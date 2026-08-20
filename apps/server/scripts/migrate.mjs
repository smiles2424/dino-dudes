#!/usr/bin/env node
/**
 * Apply pending Drizzle migrations — the *deploy* path.
 *
 * `pnpm db:migrate` runs drizzle-kit, which is a devDependency the production
 * image is pruned of, so this does the same job with `drizzle-orm`'s own
 * migrator over the same `drizzle/` folder and bookkeeping table; the two are
 * interchangeable. It runs over `DATABASE_URL_UNPOOLED` because DDL and
 * advisory locks are unreliable through PgBouncer, and exits 0 with a SKIP line
 * when there is no database, so a secret-less smoke test still boots.
 *
 * As the container entrypoint's first act it makes boot fail-fast: a bad schema
 * stops a deploy instead of surfacing as a 500 on a child's upload.
 */
import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '..', 'drizzle');

// Same repo-root `.env` the server reads. Absent in a container — a no-op there,
// where the platform injects the real environment.
config({ path: path.resolve(here, '..', '..', '..', '.env') });

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.log('[migrate] SKIP — no DATABASE_URL_UNPOOLED / DATABASE_URL in the environment');
  process.exit(0);
}
if (!process.env.DATABASE_URL_UNPOOLED) {
  console.warn('[migrate] DATABASE_URL_UNPOOLED is unset; falling back to the pooled URL');
}

const pool = new pg.Pool({
  connectionString: url,
  ssl: { rejectUnauthorized: true },
  max: 1,
  connectionTimeoutMillis: 15_000,
});

try {
  const started = Date.now();
  await migrate(drizzle(pool), { migrationsFolder });
  console.log(`[migrate] up to date in ${Date.now() - started}ms (${migrationsFolder})`);
} catch (err) {
  console.error('[migrate] FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
