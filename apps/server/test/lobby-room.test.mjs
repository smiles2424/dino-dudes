/**
 * Chunk 3.3 integration test — **the flagship of Wave 3**.
 *
 * Everything here is real: the real Fastify app, the real Colyseus server
 * sharing its `http.Server`, real WebSocket clients (`colyseus.js` via
 * `@colyseus/testing`), real HTTP over a real socket (`fetch`, not
 * `fastify.inject`), the real Neon database and the real Upstash cache.
 *
 * The journey it walks is the product in miniature:
 *
 *   create a lobby over HTTP
 *     → client A joins the room by code (a phone in the world)
 *     → client B joins the same room as a spectator (the projector)
 *     → a 1024² PNG is POSTed to /api/avatars over HTTP for A's player
 *     → BOTH clients' synchronized state shows the new textureHash
 *     → GET /api/textures/:hash returns byte-identical PNG
 *
 * Safety rules (as in Chunks 3.1/3.2): every row is tagged with a unique
 * per-run id, `after()` deletes everything by primary key even after a failure,
 * and with no credentials the tests **skip** rather than fail so a secret-less
 * CI run stays green.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { boot } from '@colyseus/testing';
import { inArray } from 'drizzle-orm';

import {
  LOBBY_ROOM_NAME,
  LobbyStateSchema,
  ROOM_ERROR_CODES,
  ROOM_MESSAGES,
} from '@dino/shared';

import { makePng } from './fixture-png.mjs';
import { buildApp } from '../dist/app.js';
import { avatars, closeDb, db, lobbies, lobbyMembers, players } from '../dist/db.js';
import { hasDatabase } from '../dist/env.js';
import { createGameServer } from '../dist/game-server.js';
import { lobbyPlayersKey, redis, textureKey } from '../dist/redis.js';
import { roomsForCode, spawnFor } from '../dist/rooms/LobbyRoom.js';

const RUN_ID = `r${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const PLAYER_NAME = `${RUN_ID}-rex`.slice(0, 24);
const skipPg = !hasDatabase() && 'no DATABASE_URL — skipping real-Neon room test';

const TEXTURE = makePng(1024, RUN_ID);
const TEXTURE_HASH = createHash('sha256').update(TEXTURE).digest('hex');

const created = { players: [], avatars: [], lobbies: [], redisKeys: [] };

let app;
let colyseus;
/** `http://127.0.0.1:<port>` — the same origin serves REST *and* WebSocket. */
let origin;
let lobbyCode;
/** Live room handles + the messages each client received. */
let clientA;
let clientB;
const broadcastsA = [];
const broadcastsB = [];

// ── helpers ────────────────────────────────────────────────────────────────

/** Polls `predicate` until it returns something truthy, or gives up loudly. */
async function waitFor(label, predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try {
      value = predicate();
    } catch {
      value = undefined;
    }
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/** `fetch` + parse in one step — a Response body can only be consumed once. */
async function jsonRequest(path, init, expectedStatus) {
  const res = await fetch(`${origin}${path}`, init);
  const text = await res.text();
  assert.equal(res.status, expectedStatus, `${path} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

/** Every entry in a client's synchronized player map, as plain objects. */
const playersOf = (room) => Object.values(room.state.toJSON().players ?? {});
const findByName = (room, name) => playersOf(room).find((p) => p.name === name);

// ── the run ────────────────────────────────────────────────────────────────

describe('Chunk 3.3 LobbyRoom (real Colyseus + Fastify + Neon + Upstash)', () => {
  before(async () => {
    app = await buildApp();
    // Colyseus attaches to Fastify's raw `http.Server`; Fastify must be `ready`
    // (plugins loaded, routes registered) but must NOT bind the port itself —
    // `boot()` does that for both of them. This is exactly why `app.ts` is a
    // factory that doesn't listen.
    await app.ready();
    colyseus = await boot(createGameServer(app));
    origin = `http://127.0.0.1:${colyseus.server.port ?? 2568}`;
  });

  test('POST /api/lobbies over real HTTP creates a joinable lobby', { skip: skipPg }, async () => {
    const body = await jsonRequest(
      '/api/lobbies',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `${RUN_ID} room test` }),
      },
      201,
    );
    lobbyCode = body.lobby.code;
    created.lobbies.push(body.lobby.id);
    created.redisKeys.push(lobbyPlayersKey(lobbyCode), textureKey(TEXTURE_HASH));

    assert.match(lobbyCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
    // Wave 4 hands this straight to the QR encoder.
    assert.ok(body.joinUrl.includes(`lobby=${lobbyCode}`), body.joinUrl);
  });

  test('joining an unknown code fails with a structured error', { skip: skipPg }, async () => {
    await assert.rejects(
      () => colyseus.sdk.joinOrCreate(LOBBY_ROOM_NAME, { code: 'ZZZZZ', name: 'nobody' }),
      (err) => {
        // Colyseus surfaces `ServerError(code, message)` as `err.code`.
        assert.equal(err.code, ROOM_ERROR_CODES.lobbyNotFound, `unexpected code ${err.code}: ${err.message}`);
        assert.match(String(err.message), /ZZZZZ/);
        return true;
      },
      'a typo\'d join code must not conjure an empty world',
    );
    assert.deepEqual(roomsForCode('ZZZZZ'), [], 'a rejected join must leave no room behind');
  });

  test('client A joins by code and appears in synchronized state', { skip: skipPg }, async () => {
    clientA = await colyseus.sdk.joinOrCreate(LOBBY_ROOM_NAME, {
      code: lobbyCode,
      name: PLAYER_NAME,
      modelSlug: 'stego',
    });
    clientA.onMessage(ROOM_MESSAGES.avatarUpdated, (m) => broadcastsA.push(m));

    const me = await waitFor('client A in its own state', () => findByName(clientA, PLAYER_NAME));
    assert.equal(me.modelSlug, 'stego', 'the join option picks the dino');
    assert.equal(me.textureHash, '', 'no drawing yet');

    // Position/heading are server-assigned, deterministic in the player id, so
    // every client renders the same world (the Wave 4/5 consistency follow-up).
    // Compared with a tolerance: Colyseus's `'number'` field type is float32 on
    // the wire, so exact equality against a float64 would be wrong by ~1e-7.
    const spawn = spawnFor(me.id);
    for (const [label, got, want] of [
      ['x', me.position.x, spawn.position.x],
      ['y', me.position.y, spawn.position.y],
      ['z', me.position.z, spawn.position.z],
      ['heading', me.heading, spawn.heading],
    ]) {
      assert.ok(Math.abs(got - want) < 1e-4, `spawn ${label}: got ${got}, want ${want}`);
    }
    assert.ok(Math.hypot(me.position.x, me.position.z) >= 4, 'spawned on the ring, not on top of the camera');

    // The Colyseus state really is the shape `@dino/shared` promises.
    LobbyStateSchema.parse(clientA.state.toJSON());
    assert.equal(clientA.state.code, lobbyCode);
  });

  test('client B joins the SAME room as a spectator, with no dino', { skip: skipPg }, async () => {
    clientB = await colyseus.sdk.joinOrCreate(LOBBY_ROOM_NAME, { code: lobbyCode, spectator: true });
    clientB.onMessage(ROOM_MESSAGES.avatarUpdated, (m) => broadcastsB.push(m));

    // `filterBy(['code'])` == one room per lobby code.
    assert.equal(clientB.roomId, clientA.roomId, 'same code must route to the same room');
    assert.equal(roomsForCode(lobbyCode).length, 1);

    await waitFor('client B to receive A in state', () => findByName(clientB, PLAYER_NAME));
    assert.equal(playersOf(clientB).length, 1, 'a spectator adds no dino of its own');
    assert.equal(roomsForCode(lobbyCode)[0].spectatorCount, 1);
  });

  test(
    'an avatar POSTed over HTTP reaches BOTH clients within the timeout',
    { skip: skipPg },
    async () => {
      const form = new FormData();
      form.set('playerName', PLAYER_NAME);
      form.set('lobbyCode', lobbyCode);
      form.set('modelSlug', 'trex');
      form.set('texture', new Blob([TEXTURE], { type: 'image/png' }), 'texture.png');

      const postStarted = Date.now();
      const body = await jsonRequest('/api/avatars', { method: 'POST', body: form }, 201);
      /*
       * The budget starts when the upload is ACCEPTED, not when it is sent
       * (Wave 4, Chunk 4.3 — the same correction E2E #3 needed).
       *
       * The promise is "a drawing is on the projector within five seconds of
       * the server taking it": everything before that is a 1 MB multipart body
       * crossing a home connection to Neon, which has been measured at
       * anywhere from 1 s to 6 s from this machine and is not what a fan-out
       * budget is for. Upload latency is printed so a regression there is
       * still visible.
       */
      const fanoutStarted = Date.now();
      created.players.push(body.player.id);
      created.avatars.push(body.avatar.id);
      assert.equal(body.avatar.textureHash, TEXTURE_HASH);

      // ── the assertion this whole wave exists for ──────────────────────────
      for (const [label, room] of [
        ['A (participant)', clientA],
        ['B (spectator)', clientB],
      ]) {
        const seen = await waitFor(
          `client ${label} to see the new textureHash`,
          () => {
            const p = findByName(room, PLAYER_NAME);
            return p && p.textureHash === TEXTURE_HASH ? p : undefined;
          },
          5000,
        );
        assert.equal(seen.modelSlug, 'trex', 'the upload also re-picks the dino');
        assert.equal(
          seen.id,
          body.player.id,
          'the fan-out must adopt the persisted player id, not clone the person',
        );
      }
      const fanoutMs = Date.now() - fanoutStarted;
      console.log(
        `[lobby-room] POST /api/avatars: ${fanoutStarted - postStarted}ms · fan-out to both clients: ${fanoutMs}ms`,
      );
      assert.ok(fanoutMs < 5000, 'fan-out must land well inside the 5 s budget');

      // The explicit broadcast (lets a client prefetch the PNG before the patch).
      for (const [label, box] of [
        ['A', broadcastsA],
        ['B', broadcastsB],
      ]) {
        const msg = await waitFor(`client ${label} to receive '${ROOM_MESSAGES.avatarUpdated}'`, () => box[0]);
        assert.deepEqual(msg, {
          lobbyCode,
          playerId: body.player.id,
          modelSlug: 'trex',
          textureHash: TEXTURE_HASH,
        });
      }

      assert.equal(playersOf(clientB).length, 1, 'no duplicate dino for the same person');
      LobbyStateSchema.parse(clientB.state.toJSON());
    },
  );

  test('GET /api/textures/:hash returns the uploaded bytes', { skip: skipPg }, async () => {
    const hash = findByName(clientB, PLAYER_NAME).textureHash;
    const res = await fetch(`${origin}/api/textures/${hash}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.equals(TEXTURE), 'served bytes must be byte-identical to the upload');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, 'content address must hold');
  });

  test('an uploader who disconnects keeps their dino; the room disposes when empty', { skip: skipPg }, async () => {
    await clientA.leave(true);

    // A player who has drawn stays in the world (the projector must not lose a
    // dino because a phone locked its screen) — re-keyed by playerId.
    const stillThere = await waitFor('A to persist after leaving', () => {
      const p = findByName(clientB, PLAYER_NAME);
      return p && p.textureHash === TEXTURE_HASH ? p : undefined;
    });
    assert.equal(stillThere.id, created.players[0]);

    await clientB.leave(true);
    await waitFor('the empty room to auto-dispose', () => roomsForCode(lobbyCode).length === 0);
  });

  after(async () => {
    const problems = [];
    const attempt = async (label, fn) => {
      try {
        await fn();
      } catch (err) {
        problems.push(`${label}: ${err instanceof Error ? err.message : err}`);
      }
    };

    // Shut the game server down first: it owns the listening socket.
    if (colyseus) await attempt('colyseus shutdown', () => colyseus.shutdown());
    if (app) await attempt('app close', () => app.close());

    if (!skipPg) {
      await attempt(
        'avatars',
        () => created.players.length && db().delete(avatars).where(inArray(avatars.playerId, created.players)),
      );
      await attempt(
        'lobby_members',
        () =>
          created.lobbies.length &&
          db().delete(lobbyMembers).where(inArray(lobbyMembers.lobbyId, created.lobbies)),
      );
      await attempt(
        'lobbies',
        () => created.lobbies.length && db().delete(lobbies).where(inArray(lobbies.id, created.lobbies)),
      );
      await attempt(
        'players',
        () => created.players.length && db().delete(players).where(inArray(players.id, created.players)),
      );
      await attempt('redis keys', () => created.redisKeys.length && redis.del(...created.redisKeys));
    }
    await attempt('close db', () => closeDb());

    if (problems.length) {
      throw new Error(`cleanup left rows behind (run id ${RUN_ID}) — ${problems.join('; ')}`);
    }
  });
});
