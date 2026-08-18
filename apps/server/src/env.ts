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
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env: Env = parsed.data;

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
