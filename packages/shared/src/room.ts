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
 * Matchmaking filter — **one room per lobby code**. Added Wave 3 Chunk 3.3
 * (additive). `gameServer.define(LOBBY_ROOM_NAME, LobbyRoom).filterBy([...])`
 * on the server; clients therefore reach their lobby with
 * `joinOrCreate(LOBBY_ROOM_NAME, { code })` and never need a Colyseus room id.
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
 * How often the room refreshes {@link LobbyStateSchema}'s `serverTime`.
 * Added Wave 5 Chunk 5.1. Each tick is one small number in the next patch, and
 * every tick re-estimates the client's clock offset, so this is both the worst
 * staleness a freshly joined client can see before its first refresh *and* how
 * fast an estimate made on a busy page (a late-processed patch reads as a
 * too-small offset) converges on the truth.
 */
export const SERVER_TIME_TICK_MS = 500;

/**
 * The whole synchronized room state.
 *
 * `motionSeed` / `motionEpoch` / `serverTime` were added in Wave 5 Chunk 5.1
 * (**additive**) so that idle motion is identical on every screen: the server
 * issues the seed and the epoch the wander is timed from, and `serverTime` —
 * refreshed every {@link SERVER_TIME_TICK_MS} — lets a client estimate its
 * offset from the server's clock. All three default so a client can still read
 * a state produced by an older server (it then falls back to local motion).
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
 * The options actually put on the wire by `joinOrCreate(LOBBY_ROOM_NAME, …)`.
 * Added Wave 3 Chunk 3.3 (**additive** — {@link JoinLobbyOptionsSchema} is
 * untouched and still describes an uploader's identity fields).
 *
 * `code` is required because it is the matchmaking filter. Everything else is
 * optional so a **spectator** (the projector view, or a phone that has not
 * drawn yet) can join with `{ code }` alone: it watches the world and gets no
 * entry in `players`. A client that supplies a `name` is a participant and is
 * added to the synchronized player map.
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
 * Structured reasons a join can be refused, sent as the Colyseus `ServerError`
 * code (`err.code` on the client). Deliberately outside Colyseus's own reserved
 * 42xx range. Added Wave 3 Chunk 3.3 (additive).
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
