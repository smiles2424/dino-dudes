/**
 * Typed Neon Postgres client.
 *
 * App queries go through the **pooled** `DATABASE_URL` (Neon's PgBouncer
 * endpoint) — that's what a long-lived Fastify/Colyseus process wants.
 * Migrations use `DATABASE_URL_UNPOOLED` instead and live in `drizzle.config.ts`
 * / `scripts/migrate.mjs`; DDL over the pooler is unreliable.
 *
 * The pool is created **lazily** so importing this module is safe in a
 * no-secrets environment (CI on a forked PR): nothing connects until the first
 * `db()` call, and `hasDatabase()` lets callers skip instead of crash.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { hasDatabase, requireDatabaseUrl } from './env.js';
import { schema } from './schema.js';

export * from './schema.js';
export { hasDatabase };

export type Database = NodePgDatabase<typeof schema>;

let pool: pg.Pool | undefined;
let instance: Database | undefined;

/**
 * The shared Drizzle client. Throws if `DATABASE_URL` is unset — guard with
 * `hasDatabase()` in code paths that must survive a secret-less environment.
 */
export function db(): Database {
  if (!instance) {
    pool = new pg.Pool({
      connectionString: requireDatabaseUrl(),
      // Neon always requires TLS; its certs are publicly trusted.
      ssl: { rejectUnauthorized: true },
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    pool.on('error', (err) => {
      console.warn('[db] idle client error:', err.message);
    });
    instance = drizzle(pool, { schema });
  }
  return instance;
}

/** Cheap liveness probe for `/healthz`. Resolves false rather than throwing. */
export async function dbPing(): Promise<boolean> {
  if (!hasDatabase()) return false;
  try {
    const rows = await db().execute<{ ok: number }>('select 1 as ok');
    return rows.rows.length === 1;
  } catch (err) {
    console.warn('[db] ping failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** Closes the pool. Call on shutdown and at the end of test runs. */
export async function closeDb(): Promise<void> {
  const p = pool;
  pool = undefined;
  instance = undefined;
  if (p) await p.end();
}
