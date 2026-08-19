/**
 * Chunk 5.2 — rate limiting and lobby lifecycle.
 *
 * Two halves, deliberately different in kind:
 *
 *  • the **token bucket** is pure and gets an injected clock, so this asserts
 *    the actual refill maths without a single `setTimeout`. (The limiter is
 *    switched off under `NODE_ENV=test` / `node --test` so the E2E suite can
 *    upload as fast as it likes — which is exactly why it has to be tested
 *    here, at the unit, rather than through HTTP.)
 *  • the **idle sweep** runs against the real Neon, because "did this UPDATE
 *    match the right rows" is a question only Postgres can answer. It skips
 *    without credentials, like every other DB test in this repo.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';

import { eq, inArray } from 'drizzle-orm';

import { closeDb, db, lobbies, lobbyMembers, players } from '../dist/db.js';
import { hasDatabase } from '../dist/env.js';
import { closeIdleLobbies } from '../dist/lobby-lifecycle.js';
import { createRateLimiter, ipUploadLimiter, uploadLimiter } from '../dist/rate-limit.js';

const RUN_ID = `s${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const skipPg = !hasDatabase() && 'no DATABASE_URL — skipping real-Neon lifecycle test';
const created = { lobbies: [], players: [] };

describe('Chunk 5.2 upload rate limiting', () => {
  test('a bucket allows a burst, refuses, then refills over time', () => {
    let now = 1_000_000;
    const limiter = createRateLimiter({ perMinute: 12, burst: 3, now: () => now });

    assert.equal(limiter.disabled, false);
    for (let i = 0; i < 3; i++) {
      assert.equal(limiter.take('phone').ok, true, `burst upload ${i + 1} must be allowed`);
    }

    const refused = limiter.take('phone');
    assert.equal(refused.ok, false, 'the fourth immediate upload is refused');
    assert.equal(refused.remaining, 0);
    assert.ok(refused.retryAfterSeconds >= 1, 'a refusal must say when to come back');

    // 12/min == one token every 5 s. Four seconds is not enough…
    now += 4_000;
    assert.equal(limiter.take('phone').ok, false, 'still short of a whole token');
    // …and being refused must not cost anything, so one more second is.
    now += 1_100;
    assert.equal(limiter.take('phone').ok, true, 'refilled to a whole token');

    // Buckets are per key: a refused phone never blocks anybody else.
    assert.equal(limiter.take('another-phone').ok, true);
  });

  test('a bucket never refills past its burst', () => {
    let now = 0;
    const limiter = createRateLimiter({ perMinute: 6, burst: 2, now: () => now });
    assert.equal(limiter.take('k').ok, true);
    now += 60 * 60_000; // an hour of doing nothing
    assert.equal(limiter.take('k').ok, true);
    assert.equal(limiter.take('k').ok, true);
    assert.equal(limiter.take('k').ok, false, 'an idle hour buys 2 uploads, not 360');
  });

  test('perMinute 0 disables the limiter entirely', () => {
    const limiter = createRateLimiter({ perMinute: 0 });
    assert.equal(limiter.disabled, true);
    for (let i = 0; i < 100; i++) assert.equal(limiter.take('anyone').ok, true);
    assert.equal(limiter.size, 0, 'a disabled limiter keeps no state');
  });

  test('the shipped limiters are off under test, so E2E stays deterministic', () => {
    assert.equal(uploadLimiter.disabled, true, 'NODE_TEST_CONTEXT/NODE_ENV=test must disable it');
    assert.equal(ipUploadLimiter.disabled, true, 'and the per-IP one too');
  });
});

describe('Chunk 5.2 lobby lifecycle (real Neon)', () => {
  test('the idle sweep closes a quiet lobby and leaves a busy one open', { skip: skipPg }, async () => {
    const longAgo = new Date(Date.now() - 48 * 3_600_000);

    const [idle] = await db()
      .insert(lobbies)
      .values({ code: `${RUN_ID.slice(1, 5).toUpperCase()}1`, name: `${RUN_ID} idle`, createdAt: longAgo })
      .returning();
    created.lobbies.push(idle.id);

    const [fresh] = await db()
      .insert(lobbies)
      .values({ code: `${RUN_ID.slice(1, 5).toUpperCase()}2`, name: `${RUN_ID} fresh` })
      .returning();
    created.lobbies.push(fresh.id);

    // An old lobby somebody *just* joined is not idle, however old the row is.
    // It is created with today's timestamp and backdated only once its member
    // exists: the other test files run against this same database and their
    // `POST /api/lobbies` fires an untargeted sweep, which would legitimately
    // close a 48-hour-old lobby that has no members *yet*.
    const [busy] = await db()
      .insert(lobbies)
      .values({ code: `${RUN_ID.slice(1, 5).toUpperCase()}3`, name: `${RUN_ID} busy` })
      .returning();
    created.lobbies.push(busy.id);
    const [player] = await db()
      .insert(players)
      .values({ name: `${RUN_ID}-late` })
      .returning({ id: players.id });
    created.players.push(player.id);
    await db().insert(lobbyMembers).values({ lobbyId: busy.id, playerId: player.id });
    await db().update(lobbies).set({ createdAt: longAgo }).where(eq(lobbies.id, busy.id));

    // Targeted: exactly the lobby whose room just disposed. `<= 1` rather than
    // `=== 1` because `POST /api/lobbies` also runs an untargeted sweep, and
    // the other test files run against this same database at the same time —
    // so this row may already have been closed by one of them a moment ago.
    // What matters is the state afterwards, asserted below.
    assert.ok((await closeIdleLobbies(idle.id)) <= 1, 'the quiet lobby closes at most once');
    assert.equal(await closeIdleLobbies(idle.id), 0, 'closing is idempotent');
    assert.equal(await closeIdleLobbies(fresh.id), 0, 'a lobby created moments ago is never idle');
    assert.equal(await closeIdleLobbies(busy.id), 0, 'a lobby somebody just joined is never idle');

    const rows = await db().select().from(lobbies).where(inArray(lobbies.id, created.lobbies));
    const byId = new Map(rows.map((r) => [r.id, r]));
    assert.ok(byId.get(idle.id).closedAt instanceof Date, 'closed_at must be stamped');
    assert.equal(byId.get(fresh.id).closedAt, null);
    assert.equal(byId.get(busy.id).closedAt, null);
  });

  after(async () => {
    const problems = [];
    if (!skipPg) {
      for (const [label, fn] of [
        [
          'lobby_members',
          () => created.lobbies.length && db().delete(lobbyMembers).where(inArray(lobbyMembers.lobbyId, created.lobbies)),
        ],
        ['lobbies', () => created.lobbies.length && db().delete(lobbies).where(inArray(lobbies.id, created.lobbies))],
        ['players', () => created.players.length && db().delete(players).where(inArray(players.id, created.players))],
      ]) {
        try {
          await fn();
        } catch (err) {
          problems.push(`${label}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
    try {
      await closeDb();
    } catch {
      /* pool may never have opened */
    }
    if (problems.length) {
      throw new Error(`cleanup left rows behind (run id ${RUN_ID}) — ${problems.join('; ')}`);
    }
  });
});
