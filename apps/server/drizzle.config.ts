/**
 * drizzle-kit config — generation + migration only (never imported by the app).
 *
 * Uses `DATABASE_URL_UNPOOLED` (Neon's *direct* endpoint) on purpose: DDL and
 * advisory-lock-based migrations don't behave over the PgBouncer pooler that
 * `DATABASE_URL` points at. The running server uses the pooled URL — see `src/db.ts`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '..', '..', '.env') });

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL_UNPOOLED (or DATABASE_URL) must be set to run drizzle-kit');
}

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  strict: true,
  verbose: true,
});
