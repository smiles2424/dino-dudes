/**
 * `POST /api/lobbies` + `GET /api/lobbies/:code`.
 *
 * Postgres is the source of truth for a lobby's existence (join codes must
 * survive a server restart); Redis only holds *live* membership, which is why
 * `GET` reports the persisted `lobby_members` rows rather than the Redis set.
 */
import { desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  API_ROUTES,
  CreateLobbyRequestSchema,
  CreateLobbyResponseSchema,
  GetLobbyParamsSchema,
  GetLobbyResponseSchema,
  ModelSlugSchema,
  TextureHashSchema,
  type CreateLobbyResponse,
  type GetLobbyResponse,
  type LobbyMemberInfo,
} from '@dino/shared';
import { avatars, db, hasDatabase, lobbies, lobbyMembers, players } from '../db.js';
import { env } from '../env.js';
import { badRequest, notConfigured, notFound } from '../errors.js';
import { generateLobbyCode } from '../lobby-code.js';

/** Rows → the frozen `LobbySchema` shape (timestamps as ISO strings). */
export function serializeLobby(row: typeof lobbies.$inferSelect): CreateLobbyResponse['lobby'] {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
}

/**
 * The URL a phone opens / the projector's QR code encodes. A query parameter
 * (rather than a path segment) so it works against today's single-page web app
 * and any router Wave 4 chooses.
 */
export const joinUrlFor = (code: string): string =>
  new URL(`/?lobby=${code}`, env.PUBLIC_WEB_URL).toString();

/** How many distinct codes to try before admitting defeat (32^5 keyspace). */
const CODE_ATTEMPTS = 8;

export async function registerLobbyRoutes(app: FastifyInstance): Promise<void> {
  app.post(API_ROUTES.createLobby, async (request, reply) => {
    if (!hasDatabase()) throw notConfigured('DATABASE_URL');

    const parsed = CreateLobbyRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw badRequest('invalid lobby payload', parsed.error.flatten().fieldErrors);
    }
    const name = parsed.data.name && parsed.data.name.length > 0 ? parsed.data.name : null;

    // Retry on the UNIQUE(code) violation rather than pre-checking: a SELECT
    // then INSERT races two simultaneous creators, `onConflictDoNothing` cannot.
    let created: typeof lobbies.$inferSelect | undefined;
    for (let attempt = 0; attempt < CODE_ATTEMPTS && !created; attempt++) {
      const [row] = await db()
        .insert(lobbies)
        .values({ code: generateLobbyCode(), name })
        .onConflictDoNothing({ target: lobbies.code })
        .returning();
      created = row;
    }
    if (!created) {
      throw new Error(`could not allocate a free lobby code in ${CODE_ATTEMPTS} attempts`);
    }

    const body: CreateLobbyResponse = {
      lobby: serializeLobby(created),
      joinUrl: joinUrlFor(created.code),
    };
    // Parsing our own response keeps the server honest against the contract.
    return reply.code(201).send(CreateLobbyResponseSchema.parse(body));
  });

  app.get(API_ROUTES.getLobby, async (request) => {
    if (!hasDatabase()) throw notConfigured('DATABASE_URL');

    const parsed = GetLobbyParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw badRequest('invalid lobby code', parsed.error.flatten().fieldErrors);
    }
    const { code } = parsed.data;

    const [lobby] = await db().select().from(lobbies).where(eq(lobbies.code, code)).limit(1);
    if (!lobby) throw notFound(`no lobby with code ${code}`, { code });

    const memberRows = await db()
      .select({
        playerId: players.id,
        name: players.name,
        joinedAt: lobbyMembers.joinedAt,
      })
      .from(lobbyMembers)
      .innerJoin(players, eq(players.id, lobbyMembers.playerId))
      .where(eq(lobbyMembers.lobbyId, lobby.id))
      .orderBy(lobbyMembers.joinedAt);

    // Each member's *current* dino = their most recent avatar row. Fetched in
    // one extra query and folded in memory: a lobby is party-sized (tens), so
    // a correlated "latest per player" subquery would be complexity for nothing.
    const latest = new Map<string, { modelSlug: string; textureHash: string }>();
    if (memberRows.length > 0) {
      const avatarRows = await db()
        .select({
          playerId: avatars.playerId,
          modelSlug: avatars.modelSlug,
          textureHash: avatars.textureHash,
          createdAt: avatars.createdAt,
        })
        .from(avatars)
        .where(
          inArray(
            avatars.playerId,
            memberRows.map((m) => m.playerId),
          ),
        )
        .orderBy(desc(avatars.createdAt));
      for (const row of avatarRows) {
        if (!latest.has(row.playerId)) {
          latest.set(row.playerId, { modelSlug: row.modelSlug, textureHash: row.textureHash });
        }
      }
    }

    const members: LobbyMemberInfo[] = memberRows.map((m) => {
      const avatar = latest.get(m.playerId);
      // A slug/hash that fails the contract (hand-edited row, older schema) is
      // reported as "no avatar yet" rather than failing the whole request.
      const slug = avatar ? ModelSlugSchema.safeParse(avatar.modelSlug) : null;
      const hash = avatar ? TextureHashSchema.safeParse(avatar.textureHash) : null;
      return {
        playerId: m.playerId,
        name: m.name,
        modelSlug: slug?.success ? slug.data : null,
        textureHash: hash?.success ? hash.data : null,
        joinedAt: m.joinedAt.toISOString(),
      };
    });

    const body: GetLobbyResponse = {
      lobby: serializeLobby(lobby),
      memberCount: members.length,
      members,
    };
    return GetLobbyResponseSchema.parse(body);
  });
}
