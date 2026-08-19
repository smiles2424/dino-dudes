/**
 * `POST /api/lobbies` + `GET /api/lobbies/:code`.
 *
 * Postgres is the source of truth for a lobby's existence (join codes must
 * survive a server restart); Redis only holds *live* membership, which is why
 * `GET` reports the persisted `lobby_members` rows rather than the Redis set.
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  API_ROUTES,
  CreateLobbyRequestSchema,
  CreateLobbyResponseSchema,
  GetLobbyParamsSchema,
  GetLobbyResponseSchema,
  type CreateLobbyResponse,
  type GetLobbyResponse,
  type LobbyMemberInfo,
} from '@dino/shared';
import { db, hasDatabase, lobbies } from '../db.js';
import { env } from '../env.js';
import { badRequest, lobbyClosed, notConfigured, notFound } from '../errors.js';
import { generateLobbyCode } from '../lobby-code.js';
import { sweepIdleLobbiesOccasionally } from '../lobby-lifecycle.js';
import { loadLobbyMembers } from '../lobby-members.js';

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

    // A new party starting is the natural (and rare) moment to close whatever
    // idled out since the last one — fire-and-forget, so it never delays the
    // projector (Chunk 5.2, `lobby-lifecycle.ts`).
    sweepIdleLobbiesOccasionally();

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
    // Chunk 5.2: a closed lobby is refused here rather than reported as a
    // 200 with `closedAt` set — the client only ever wanted to know whether it
    // can send a drawing, and `lobby_closed` is the contract's answer for "no".
    if (lobby.closedAt) {
      throw lobbyClosed(`lobby ${code} is closed`, { code, closedAt: lobby.closedAt.toISOString() });
    }

    // Chunk 4.2 moved this query into `src/lobby-members.ts` — `LobbyRoom`
    // now needs the identical answer to hydrate a freshly created room.
    const members: LobbyMemberInfo[] = (await loadLobbyMembers(lobby.id)).map((m) => ({
      playerId: m.playerId,
      name: m.name,
      modelSlug: m.modelSlug,
      textureHash: m.textureHash,
      joinedAt: m.joinedAt.toISOString(),
    }));

    const body: GetLobbyResponse = {
      lobby: serializeLobby(lobby),
      memberCount: members.length,
      members,
    };
    return GetLobbyResponseSchema.parse(body);
  });
}
