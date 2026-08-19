/**
 * "Who is in this lobby, and what are they wearing?" — read from Postgres.
 *
 * Two callers need exactly this (Wave 4, Chunk 4.2):
 *   • `GET /api/lobbies/:code`, so a client can render the lobby before any
 *     Colyseus state arrives;
 *   • `LobbyRoom.onCreate`, so a room created *after* people have uploaded
 *     starts with their dinos in it rather than an empty field.
 *
 * That second one is not a nicety. A lobby's room is disposed as soon as it is
 * empty (`autoDispose`), so the very first person to draw uploads over plain
 * HTTP with no room in existence, and then opens the game view — which creates
 * a brand-new room. Without hydration their own drawing would be missing from
 * the world they just walked into.
 */
import { desc, eq, inArray } from 'drizzle-orm';
import { ModelSlugSchema, TextureHashSchema, type ModelSlug, type TextureHash } from '@dino/shared';
import { avatars, db, lobbyMembers, players } from './db.js';

export interface PersistedMember {
  playerId: string;
  name: string;
  joinedAt: Date;
  /** `null` until this player has uploaded a drawing. */
  modelSlug: ModelSlug | null;
  textureHash: TextureHash | null;
}

/**
 * Lobby membership, oldest first, each with their **current** dino (their most
 * recent avatar row).
 *
 * The avatars are fetched in one extra query and folded in memory: a lobby is
 * party-sized (tens of people), so a correlated "latest per player" subquery
 * would be complexity for nothing.
 */
export async function loadLobbyMembers(lobbyId: string): Promise<PersistedMember[]> {
  const memberRows = await db()
    .select({
      playerId: players.id,
      name: players.name,
      joinedAt: lobbyMembers.joinedAt,
    })
    .from(lobbyMembers)
    .innerJoin(players, eq(players.id, lobbyMembers.playerId))
    .where(eq(lobbyMembers.lobbyId, lobbyId))
    .orderBy(lobbyMembers.joinedAt);

  if (memberRows.length === 0) return [];

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

  const latest = new Map<string, { modelSlug: string; textureHash: string }>();
  for (const row of avatarRows) {
    if (!latest.has(row.playerId)) {
      latest.set(row.playerId, { modelSlug: row.modelSlug, textureHash: row.textureHash });
    }
  }

  return memberRows.map((member) => {
    const avatar = latest.get(member.playerId);
    // A slug/hash that fails the contract (hand-edited row, older schema) is
    // reported as "no avatar yet" rather than failing the whole request.
    const slug = avatar ? ModelSlugSchema.safeParse(avatar.modelSlug) : null;
    const hash = avatar ? TextureHashSchema.safeParse(avatar.textureHash) : null;
    return {
      playerId: member.playerId,
      name: member.name,
      joinedAt: member.joinedAt,
      modelSlug: slug?.success ? slug.data : null,
      textureHash: hash?.success ? hash.data : null,
    };
  });
}
