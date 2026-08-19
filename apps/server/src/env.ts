/**
 * Environment loading + validation.
 *
 * Wave 1 must boot with an empty `.env` (the CI build has no secrets), so every
 * third-party credential is optional here. Wave 3 tightens this by asserting
 * the DB/Redis values are present before touching those subsystems — see
 * `requireDatabaseUrl` / `requireUpstash`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both `src/` (tsx dev) and `dist/` (built).
config({ path: path.resolve(here, '..', '..', '..', '.env') });

/**
 * `.env.example` ships these keys with empty values, and `z.coerce.number()`
 * would happily read `''` as `0` — which for the rate limit means "off in
 * production". An empty variable is an *unset* one.
 */
const blankIsUnset = <T extends z.ZodTypeAny>(schema: T): z.ZodEffects<T> =>
  z.preprocess((value) => (value === '' ? undefined : value), schema) as unknown as z.ZodEffects<T>;

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(2567),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().optional(),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  REDIS_URL: z.string().optional(),
  SESSION_SECRET: z.string().optional(),

  /** Comma-separated allowlist; `*` (default) allows any origin, fine for a LAN party game. */
  CORS_ORIGIN: z.string().default('*'),
  /** Base URL handed out in lobby join links / QR codes. */
  PUBLIC_WEB_URL: z.string().default('http://localhost:5173'),

  /**
   * `POST /api/avatars` uploads allowed per minute, per IP and per player
   * (Wave 5, Chunk 5.2). `0` disables the limiter — which is the *default under
   * `NODE_ENV=test`*, so the E2E suite (which uploads as fast as it can) stays
   * deterministic. See `rate-limit.ts`.
   */
  AVATAR_UPLOAD_LIMIT_PER_MIN: blankIsUnset(z.coerce.number().int().min(0).optional()),

  /**
   * How long a lobby may sit with nothing happening before the next room
   * disposal (or lobby creation) stamps its `closed_at`. See
   * `lobby-lifecycle.ts`.
   */
  LOBBY_IDLE_HOURS: blankIsUnset(z.coerce.number().min(0).default(12)),
});

export type Env = z.infer<typeof EnvSchema> & { AVATAR_UPLOAD_LIMIT_PER_MIN: number };

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

/** Tests (and `node --test`, which sets `NODE_TEST_CONTEXT`) opt out by default. */
const underTest = parsed.data.NODE_ENV === 'test' || Boolean(process.env['NODE_TEST_CONTEXT']);

export const env: Env = {
  ...parsed.data,
  AVATAR_UPLOAD_LIMIT_PER_MIN: parsed.data.AVATAR_UPLOAD_LIMIT_PER_MIN ?? (underTest ? 0 : 12),
};

/** True when the Upstash REST credentials are present. */
export const hasUpstash = (): boolean =>
  Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);

/** True when a Neon connection string is present. */
export const hasDatabase = (): boolean => Boolean(env.DATABASE_URL);

export function requireDatabaseUrl(): string {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
  return env.DATABASE_URL;
}

export function requireUpstash(): { url: string; token: string } {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set. requires both');
  }
  return { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN };
}
