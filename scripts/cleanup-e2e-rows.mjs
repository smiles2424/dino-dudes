#!/usr/bin/env node
/**
 * Delete the rows the browser E2E suite leaves in Neon (Wave 4, Chunk 4.3).
 *
 * E2E #3, #4 and the flagship all talk to the real API, so every run persists a
 * lobby, a player and an avatar. Nothing in Playwright owns a database client,
 * so the litter used to accumulate for ever. This script is the cleanup path:
 * Playwright's `globalTeardown` runs it after the last test, and it can also be
 * run by hand (`pnpm e2e:cleanup`).
 *
 * **Surgical by construction.** It only ever touches rows whose *name* carries
 * the e2e tag the suite stamps on everything it creates:
 *
 *   lobbies.name  `e2e <8 hex>`     (`e2e 3f2a1b9c`)
 *   players.name  `e2e-<8 hex>…`    (`e2e-3f2a1b9c`, `e2e-3f2a1b9c-a`)
 *
 * Both patterns are anchored, so a real lobby or a real child's name can never
 * match. Avatars and lobby_members are deleted only via those ids (foreign keys
 * mean they have to go first anyway).
 *
 * Never fails the caller: with no `DATABASE_URL` it prints a SKIP line and
 * exits 0 (the same rule `validate:connections` follows), and a database error
 * is reported and swallowed — leftover rows must never turn a green suite red.
 */
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, '..', '.env') });

/** Anchored so only rows this suite created can ever match. */
const LOBBY_NAME_PATTERN = '^e2e [0-9a-f]{8}$';
const PLAYER_NAME_PATTERN = '^e2e-[0-9a-f]{8}';

const url = process.env.DATABASE_URL;
if (!url) {
  console.log('SKIP  e2e cleanup — no DATABASE_URL');
  process.exit(0);
}

/** Redact anything that looks like a credential out of an error message. */
function scrub(text) {
  return String(text)
    .replace(/\/\/[^@\s]+@/g, '//<redacted>@')
    .replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>');
}

const client = new pg.Client({ connectionString: url });
const t0 = Date.now();

try {
  await client.connect();

  const players = await client.query('SELECT id FROM players WHERE name ~ $1', [
    PLAYER_NAME_PATTERN,
  ]);
  const lobbies = await client.query('SELECT id FROM lobbies WHERE name ~ $1', [
    LOBBY_NAME_PATTERN,
  ]);
  const playerIds = players.rows.map((row) => row.id);
  const lobbyIds = lobbies.rows.map((row) => row.id);

  if (playerIds.length === 0 && lobbyIds.length === 0) {
    console.log('CLEAN e2e cleanup — nothing left behind');
  } else {
    // Children first: lobby_members and avatars both reference players.
    const members = await client.query(
      'DELETE FROM lobby_members WHERE player_id = ANY($1::uuid[]) OR lobby_id = ANY($2::uuid[])',
      [playerIds, lobbyIds],
    );
    const avatars = await client.query('DELETE FROM avatars WHERE player_id = ANY($1::uuid[])', [
      playerIds,
    ]);
    const deletedPlayers = await client.query('DELETE FROM players WHERE id = ANY($1::uuid[])', [
      playerIds,
    ]);
    const deletedLobbies = await client.query('DELETE FROM lobbies WHERE id = ANY($1::uuid[])', [
      lobbyIds,
    ]);
    // Since Wave 5 Chunk 5.2 the drawings live in their own content-addressed
    // table, shared between however many players wear them — so they are
    // deleted by "nobody is wearing this any more", not by owner. Safe for
    // concurrent runs: a texture another run is still using has a wearer row.
    const textures = await client.query(
      'DELETE FROM textures t WHERE NOT EXISTS (SELECT 1 FROM avatars a WHERE a.texture_hash = t.hash)',
    );

    console.log(
      `CLEAN e2e cleanup — ${deletedLobbies.rowCount} lobbies, ${deletedPlayers.rowCount} players, ` +
        `${avatars.rowCount} avatars, ${textures.rowCount} textures, ${members.rowCount} memberships ` +
        `(${Date.now() - t0}ms)`,
    );
  }
} catch (err) {
  // Deliberately non-fatal: this is housekeeping, not an assertion.
  console.warn(`WARN  e2e cleanup failed — ${scrub(err.message)}`);
} finally {
  await client.end().catch(() => {});
}
