/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  API SPEC — FROZEN CONTRACT (Wave 1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Zod schemas for every REST boundary between `apps/web` and `apps/server`.
 * Wave 3 (WS-B) implements the routes; Wave 4 (WS-D) consumes them. Additive
 * changes only — never tighten an existing field without a Progress Log note.
 */
import { z } from 'zod';
import { MODEL_SLUGS, TEXTURE } from './texture-spec.js';

// ── Primitives ─────────────────────────────────────────────────────────────

/** 5-character lobby join code. Uppercase, ambiguity-free alphabet (no I/O/0/1). */
export const LOBBY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const LOBBY_CODE_LENGTH = 5;
export const LobbyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .length(LOBBY_CODE_LENGTH)
  .regex(new RegExp(`^[${LOBBY_CODE_ALPHABET}]+$`), 'invalid lobby code');
export type LobbyCode = z.infer<typeof LobbyCodeSchema>;

/** sha256 of the canonical PNG bytes, lowercase hex — the texture's content address. */
export const TextureHashSchema = z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex');
export type TextureHash = z.infer<typeof TextureHashSchema>;

export const PlayerIdSchema = z.string().uuid();
export type PlayerId = z.infer<typeof PlayerIdSchema>;

export const PlayerNameSchema = z.string().trim().min(1).max(24);
export const ModelSlugSchema = z.enum(MODEL_SLUGS);

// ── Entities ───────────────────────────────────────────────────────────────

export const PlayerSchema = z.object({
  id: PlayerIdSchema,
  name: PlayerNameSchema,
  createdAt: z.string().datetime(),
});
export type Player = z.infer<typeof PlayerSchema>;

export const LobbySchema = z.object({
  id: z.string().uuid(),
  code: LobbyCodeSchema,
  name: z.string().max(64).nullable(),
  createdAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable(),
});
export type Lobby = z.infer<typeof LobbySchema>;

export const AvatarSchema = z.object({
  id: z.string().uuid(),
  playerId: PlayerIdSchema,
  modelSlug: ModelSlugSchema,
  textureHash: TextureHashSchema,
  createdAt: z.string().datetime(),
});
export type Avatar = z.infer<typeof AvatarSchema>;

// ── GET /healthz ───────────────────────────────────────────────────────────

export const HealthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSeconds: z.number().nonnegative(),
  version: z.string(),
  /** Per-dependency reachability. `null` == not configured in this environment. */
  checks: z.object({
    redis: z.boolean().nullable(),
    postgres: z.boolean().nullable(),
  }),
});
export type Health = z.infer<typeof HealthSchema>;

// ── POST /api/lobbies ──────────────────────────────────────────────────────

export const CreateLobbyRequestSchema = z.object({
  name: z.string().trim().max(64).optional(),
});
export type CreateLobbyRequest = z.infer<typeof CreateLobbyRequestSchema>;

export const CreateLobbyResponseSchema = z.object({
  lobby: LobbySchema,
  /** Absolute URL a phone can open (and that the projector QR code encodes). */
  joinUrl: z.string().url(),
});
export type CreateLobbyResponse = z.infer<typeof CreateLobbyResponseSchema>;

// ── GET /api/lobbies/:code ─────────────────────────────────────────────────

export const GetLobbyParamsSchema = z.object({ code: LobbyCodeSchema });

export const GetLobbyResponseSchema = z.object({
  lobby: LobbySchema,
  memberCount: z.number().int().nonnegative(),
});
export type GetLobbyResponse = z.infer<typeof GetLobbyResponseSchema>;

// ── POST /api/avatars (multipart/form-data) ────────────────────────────────

/**
 * Multipart fields. `texture` is the file part: a canonical
 * {@link TEXTURE.width}×{@link TEXTURE.height} PNG produced by the pipeline.
 * `sourcePhoto` is an optional original photo kept for later reprocessing.
 */
export const CreateAvatarFieldsSchema = z.object({
  lobbyCode: LobbyCodeSchema,
  playerName: PlayerNameSchema,
  modelSlug: ModelSlugSchema,
  /** Present when the client already knows the hash; the server always re-derives and verifies. */
  textureHash: TextureHashSchema.optional(),
});
export type CreateAvatarFields = z.infer<typeof CreateAvatarFieldsSchema>;

export const CreateAvatarResponseSchema = z.object({
  player: PlayerSchema,
  avatar: AvatarSchema,
  /** Content-addressed, immutably cacheable. */
  textureUrl: z.string(),
});
export type CreateAvatarResponse = z.infer<typeof CreateAvatarResponseSchema>;

// ── GET /api/textures/:hash ────────────────────────────────────────────────

export const GetTextureParamsSchema = z.object({ hash: TextureHashSchema });

/** Path builder so client and server can never disagree about the URL shape. */
export const textureUrlPath = (hash: TextureHash): string => `/api/textures/${hash}`;

// ── Errors ─────────────────────────────────────────────────────────────────

export const ApiErrorCodeSchema = z.enum([
  'bad_request',
  'not_found',
  'lobby_closed',
  'texture_invalid',
  'texture_too_large',
  'rate_limited',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorSchema = z.object({
  error: ApiErrorCodeSchema,
  message: z.string(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/** Single place both sides agree on route strings. */
export const API_ROUTES = {
  health: '/healthz',
  createLobby: '/api/lobbies',
  getLobby: '/api/lobbies/:code',
  createAvatar: '/api/avatars',
  getTexture: '/api/textures/:hash',
} as const;
