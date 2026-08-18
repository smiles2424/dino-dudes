/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  COLYSEUS ROOM SPEC — FROZEN CONTRACT (Wave 1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Zod mirrors of the Colyseus `LobbyRoom` synchronized state and its messages.
 *
 * Colyseus syncs via `@colyseus/schema` classes (see `apps/server/src/rooms`),
 * which cannot themselves be Zod objects. These schemas are the authoritative
 * *shape* description: the server's Schema classes must stay structurally
 * assignable to them, and clients (`apps/web`, E2E) parse against them so a
 * drift between server and client fails loudly instead of silently.
 */
import { z } from 'zod';
import { ModelSlugSchema, PlayerIdSchema, PlayerNameSchema, TextureHashSchema } from './api.js';

/** Colyseus room name used by `gameServer.define()` and `client.joinById`/`joinOrCreate`. */
export const LOBBY_ROOM_NAME = 'lobby';

/** A dino's position/heading in the shared world. Metres, radians, Y-up. */
export const Vec3Schema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
});
export type Vec3 = z.infer<typeof Vec3Schema>;

/** One player as synchronized to every client in the lobby. */
export const PlayerStateSchema = z.object({
  id: PlayerIdSchema,
  name: PlayerNameSchema,
  modelSlug: ModelSlugSchema,
  /** Empty string until the player has uploaded a drawing. */
  textureHash: z.union([TextureHashSchema, z.literal('')]),
  position: Vec3Schema,
  /** Y-axis rotation in radians. */
  heading: z.number(),
});
export type PlayerState = z.infer<typeof PlayerStateSchema>;

/** The whole synchronized room state. */
export const LobbyStateSchema = z.object({
  code: z.string(),
  /** Keyed by Colyseus `sessionId`. */
  players: z.record(z.string(), PlayerStateSchema),
  createdAt: z.number().int().nonnegative(),
});
export type LobbyState = z.infer<typeof LobbyStateSchema>;

/** Options accepted by `LobbyRoom.onCreate` / `onJoin`. */
export const JoinLobbyOptionsSchema = z.object({
  name: PlayerNameSchema,
  modelSlug: ModelSlugSchema,
  /** Set when reconnecting/rejoining an existing persisted player. */
  playerId: PlayerIdSchema.optional(),
});
export type JoinLobbyOptions = z.infer<typeof JoinLobbyOptionsSchema>;

// ── Messages ───────────────────────────────────────────────────────────────

/** Message type identifiers. Client→server and server→client. */
export const ROOM_MESSAGES = {
  /** server → all: a player's texture changed (also reflected in room state). */
  avatarUpdated: 'avatar-updated',
  /** client → server: pick or change dino model before/after uploading. */
  selectModel: 'select-model',
  /** client → server: idle/wander movement update. */
  move: 'move',
} as const;
export type RoomMessageType = (typeof ROOM_MESSAGES)[keyof typeof ROOM_MESSAGES];

export const AvatarUpdatedMessageSchema = z.object({
  lobbyCode: z.string(),
  playerId: PlayerIdSchema,
  modelSlug: ModelSlugSchema,
  textureHash: TextureHashSchema,
});
export type AvatarUpdatedMessage = z.infer<typeof AvatarUpdatedMessageSchema>;

export const SelectModelMessageSchema = z.object({ modelSlug: ModelSlugSchema });
export type SelectModelMessage = z.infer<typeof SelectModelMessageSchema>;

export const MoveMessageSchema = z.object({
  position: Vec3Schema,
  heading: z.number(),
});
export type MoveMessage = z.infer<typeof MoveMessageSchema>;

/** Redis pub/sub channel carrying {@link AvatarUpdatedMessageSchema}. */
export const AVATAR_UPDATES_CHANNEL = 'avatar:updates';

/** Redis key builders — one definition shared by server modules and tests. */
export const redisKeys = {
  texture: (hash: string): string => `texture:${hash}`,
  lobbyPlayers: (code: string): string => `lobby:${code}:players`,
} as const;
