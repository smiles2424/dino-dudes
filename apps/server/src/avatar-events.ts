/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ⚑ HOOK POINT FOR CHUNK 3.3 (Colyseus room fan-out)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `POST /api/avatars` calls {@link emitAvatarUpdated} exactly once, after the
 * player + avatar rows are committed and the texture is cached. In v1 the API
 * and Colyseus share **one process**, so the fan-out is a direct in-process
 * function call — no Redis pub/sub round-trip (PLAN.md, Chunk 3.3).
 *
 * ── What Chunk 3.3 must do ────────────────────────────────────────────────
 *   In `src/index.ts`, right after `gameServer.define(LOBBY_ROOM_NAME, …)`:
 *
 *     import { setAvatarBroadcaster } from './avatar-events.js';
 *     setAvatarBroadcaster((update) => {
 *       // find the LobbyRoom whose state.code === update.lobbyCode,
 *       // set players[…].textureHash / modelSlug, and
 *       // room.broadcast(ROOM_MESSAGES.avatarUpdated, update)
 *     });
 *
 *   Nothing in the route layer changes: it already awaits this hook and already
 *   swallows/logs listener failures so a room bug can never fail an upload that
 *   is already persisted. Matching the payload to `AvatarUpdatedMessageSchema`
 *   in `@dino/shared` is deliberate — the room can forward it verbatim.
 *
 * Until then the default listener is a no-op, which is why Chunk 3.2 can ship
 * and be tested without any room logic at all.
 */
import type { AvatarUpdatedMessage } from '@dino/shared';

/** Payload handed to the room layer. Structurally `AvatarUpdatedMessageSchema`. */
export type AvatarUpdate = AvatarUpdatedMessage;

export type AvatarBroadcaster = (update: AvatarUpdate) => void | Promise<void>;

let broadcaster: AvatarBroadcaster | null = null;

/** Registers the room-layer fan-out. Chunk 3.3 calls this once at boot. */
export function setAvatarBroadcaster(fn: AvatarBroadcaster | null): void {
  broadcaster = fn;
}

/** True once a broadcaster is registered — handy for `/healthz` and tests. */
export const hasAvatarBroadcaster = (): boolean => broadcaster !== null;

/**
 * Notifies the room layer. Never throws: the avatar is already persisted by the
 * time this runs, so a fan-out failure must not turn a successful upload into a
 * 500 (the client would re-upload and the world would still be right).
 */
export async function emitAvatarUpdated(update: AvatarUpdate): Promise<void> {
  if (!broadcaster) return;
  try {
    await broadcaster(update);
  } catch (err) {
    console.warn('[avatar-events] broadcaster failed:', err instanceof Error ? err.message : err);
  }
}
