/**
 * Zod mirrors of the Colyseus `LobbyRoom` synchronized state and its messages.
 *
 * Colyseus syncs via `@colyseus/schema` classes, which cannot themselves be Zod
 * objects, so these are the authoritative *shape*: the server's Schema classes
 * must stay structurally assignable to them, and clients parse against them so
 * server/client drift fails loudly instead of silently.
 */
import { z } from 'zod';
import {
  LobbyCodeSchema,
  ModelSlugSchema,
  PlayerIdSchema,
  PlayerNameSchema,
  TextureHashSchema,
} from './api.js';

/** Colyseus room name used by `gameServer.define()` and `client.joinById`/`joinOrCreate`. */
export const LOBBY_ROOM_NAME = 'lobby';

/**
 * Matchmaking filter — one room per lobby code. Clients therefore reach their
 * lobby with `joinOrCreate(LOBBY_ROOM_NAME, { code })` and never need to know a
 * Colyseus room id.
 */
export const LOBBY_ROOM_FILTER: readonly string[] = ['code'];

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

/**
 * How often the room refreshes {@link LobbyStateSchema}'s `serverTime`. This is
 * both the worst staleness a freshly joined client sees before its first
 * refresh and how fast a bad estimate converges — a patch processed late on a
 * busy page reads as a too-small offset, and only a later tick corrects it.
 */
export const SERVER_TIME_TICK_MS = 500;

/**
 * The whole synchronized room state.
 *
 * The server issues `motionSeed` and the `motionEpoch` the wander is timed
 * from, and `serverTime` lets a client estimate its offset from the server's
 * clock — together they make idle motion identical on every screen. All three
 * default, so a client can still read state from an older server and fall back
 * to local motion.
 */
export const LobbyStateSchema = z.object({
  code: z.string(),
  /** Keyed by Colyseus `sessionId`. */
  players: z.record(z.string(), PlayerStateSchema),
  createdAt: z.number().int().nonnegative(),
  /** Per-lobby wander seed. Empty string == no server seed (harness/legacy). */
  motionSeed: z.string().default(''),
  /** Epoch (ms, server clock) that motion time is measured from. */
  motionEpoch: z.number().nonnegative().default(0),
  /** The server's wall clock, refreshed on a fixed tick. `0` == never set. */
  serverTime: z.number().nonnegative().default(0),
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

/**
 * The options actually put on the wire by `joinOrCreate`.
 *
 * `code` is required because it is the matchmaking filter. Everything else is
 * optional so a **spectator** — the projector, or a phone that has not drawn
 * yet — can join with `{ code }` alone and get no entry in `players`. Supplying
 * a `name` makes the client a participant.
 */
export const LobbyJoinOptionsSchema = z.object({
  code: LobbyCodeSchema,
  name: PlayerNameSchema.optional(),
  modelSlug: ModelSlugSchema.optional(),
  /** Set once the player exists in Postgres (e.g. after `POST /api/avatars`). */
  playerId: PlayerIdSchema.optional(),
  /** Explicit opt-out of being rendered, even when a `name` is supplied. */
  spectator: z.boolean().optional(),
});
export type LobbyJoinOptions = z.infer<typeof LobbyJoinOptionsSchema>;

/**
 * Structured reasons a join can be refused, surfaced as `err.code` on the
 * client. Deliberately outside Colyseus's own reserved 42xx range.
 */
export const ROOM_ERROR_CODES = {
  /** Options failed {@link LobbyJoinOptionsSchema}. */
  invalidJoinOptions: 4000,
  /** No lobby with that code exists in Postgres. */
  lobbyNotFound: 4040,
  /** The lobby exists but has been closed. */
  lobbyClosed: 4090,
} as const;
export type RoomErrorCode = (typeof ROOM_ERROR_CODES)[keyof typeof ROOM_ERROR_CODES];

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
