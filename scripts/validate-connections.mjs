#!/usr/bin/env node
/**
 * Third-party connection validation (Wave 1 gate).
 *
 * Checks:
 *   1. Neon Postgres `SELECT 1` over DATABASE_URL (pooled)
 *   2. Neon Postgres `SELECT 1` over DATABASE_URL_UNPOOLED (direct)
 *   3. Upstash Redis `PING` over the REST API (@upstash/redis, HTTPS/443)
 *
 * NOTE: we deliberately do NOT use ioredis / REDIS_URL (TCP 6379). See the
 * Progress Log in PLAN.md — port 6379 is blackholed on the dev machine.
 *
 * Never prints secret values. Exits 0 on success, 1 on failure.
 * Set VALIDATE_SOFT_FAIL=1 (CI without secrets) to exit 0 when env vars are missing.
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { Redis } from '@upstash/redis';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '..', '.env') });

const REQUIRED = [
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
];

const soft = process.env.VALIDATE_SOFT_FAIL === '1';
const missing = REQUIRED.filter((k) => !process.env[k]);

if (missing.length > 0) {
  const msg = `Missing env vars: ${missing.join(', ')}`;
  if (soft) {
    console.log(`SKIP  connection validation — ${msg} (VALIDATE_SOFT_FAIL=1)`);
    process.exit(0);
  }
  console.error(`FAIL  ${msg}`);
  process.exit(1);
}

/** Redact anything that looks like a credential out of an error message. */
function scrub(text) {
  return String(text)
    .replace(/\/\/[^@\s]+@/g, '//<redacted>@')
    .replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>');
}

async function checkPostgres(label, url) {
  const client = new pg.Client({ connectionString: url });
  const t0 = Date.now();
  try {
    await client.connect();
    const res = await client.query('SELECT 1 AS ok, version() AS version');
    const version = String(res.rows[0].version).split(' ').slice(0, 2).join(' ');
    return { label, ok: res.rows[0].ok === 1, detail: `${version}, ${Date.now() - t0}ms` };
  } catch (err) {
    return { label, ok: false, detail: scrub(err.message) };
  } finally {
    await client.end().catch(() => {});
  }
}

async function checkUpstash() {
  const t0 = Date.now();
  try {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    const pong = await redis.ping();
    return {
      label: 'Upstash Redis (REST/443)',
      ok: String(pong).toUpperCase() === 'PONG',
      detail: `${pong}, ${Date.now() - t0}ms`,
    };
  } catch (err) {
    return { label: 'Upstash Redis (REST/443)', ok: false, detail: scrub(err.message) };
  }
}

const results = [
  await checkPostgres('Neon Postgres (pooled)', process.env.DATABASE_URL),
  await checkPostgres('Neon Postgres (unpooled)', process.env.DATABASE_URL_UNPOOLED),
  await checkUpstash(),
];

for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label} — ${r.detail}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length}/${results.length} connection check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} connection checks passed.`);
