#!/usr/bin/env node
/**
 * Apply pending Drizzle migrations — the *deploy* path (Chunk 5.3).
 *
 * `pnpm db:migrate` runs `drizzle-kit migrate`, which is perfect on a laptop and
 * wrong in a container: drizzle-kit is a **devDependency**, and the production
 * image is pruned to `@dino/server`'s prod deps precisely so the thing serving
 * children's drawings isn't carrying a schema toolchain. This script does the
 * same job with `drizzle-orm`'s own migrator (a prod dep) plus `pg`, reading the
 * exact same `drizzle/` folder and `__drizzle_migrations` bookkeeping table, so
 * the two are interchangeable and neither re-applies the other's work.
 *
 * It is the container ENTRYPOINT's first act. Consequences worth knowing:
 *   · Boot is fail-fast. A bad schema stops the deploy instead of serving a
 *     server that 500s on the first upload at the venue.
 *   · Migrations run over `DATABASE_URL_UNPOOLED` (Neon's direct endpoint).
 *     DDL and advisory locks are unreliable through PgBouncer — same reason
 *     `drizzle.config.ts` does it.
 *   · With no DATABASE_URL* at all it exits 0 with a SKIP line, which is what
 *     lets a secret-less smoke test (`docker run` with no env) still boot.
 *
 * Concurrency: Drizzle takes a Postgres advisory lock, so two instances booting
 * at once is safe — but see docs/DEPLOY.md, the event wants ONE instance anyway.
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
