/**
 * Chunk 3.2 integration test — the REST API over the **real** Fastify app,
 * the **real** Neon and the **real** Upstash.
 *
 * It boots `buildApp()` (no port binding needed — `fastify.inject` drives the
 * full request lifecycle: routing, multipart parsing, the error handler, and
 * serialization) and walks the actual product flow:
 *
 *   create lobby → upload a 1024² PNG → fetch the bytes back → see the player
 *   in the lobby → re-upload the same drawing → reject bad uploads.
 *
 * Safety rules (same as Chunk 3.1's data-layer test):
 *  - everything created is tagged with a unique per-run id, so concurrent runs
 *    can't collide, and the lobby code comes from the server itself;
 *  - `after()` deletes every row/key by primary key, even after a failure;
 *  - with no credentials every test **skips** rather than fails, so CI on a
 *    forked PR (no secrets) stays green.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';

import { eq, inArray } from 'drizzle-orm';

import { makePng } from './fixture-png.mjs';
import { buildApp } from '../dist/app.js';
import { avatars, closeDb, db, lobbies, lobbyMembers, players } from '../dist/db.js';
import { hasDatabase } from '../dist/env.js';
import { lobbyPlayersKey, redis, textureKey } from '../dist/redis.js';

const RUN_ID = `t${randomUUID().replace(/-/g, '').slice(0, 10)}`;
const PLAYER_NAME = `${RUN_ID}-rex`.slice(0, 24);
const skipPg = !hasDatabase() && 'no DATABASE_URL — skipping real-Neon API test';
const hasRedis = redis.configured;

const created = { players: [], avatars: [], lobbies: [], redisKeys: [] };

// ── A real 1024×1024 PNG, unique per run (see `fixture-png.mjs`) ───────────
const TEXTURE = makePng(1024, RUN_ID);
const TEXTURE_HASH = createHash('sha256').update(TEXTURE).digest('hex');
const SMALL_TEXTURE = makePng(32, `${RUN_ID}-small`);

// ── multipart/form-data body builder ───────────────────────────────────────
function multipart(parts) {
  const boundary = `----dino${randomUUID().replace(/-/g, '')}`;
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n` +
            `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        ),
      );
      chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value)));
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
      chunks.push(Buffer.from(String(part.value)));
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

const avatarUpload = ({ lobbyCode, name = PLAYER_NAME, modelSlug = 'trex', texture = TEXTURE }) =>
  multipart([
    { name: 'playerName', value: name },
    { name: 'lobbyCode', value: lobbyCode },
    { name: 'modelSlug', value: modelSlug },
    { name: 'texture', filename: 'texture.png', contentType: 'image/png', value: texture },
  ]);

let app;
/** Lobby code + id created by the first test and reused by the rest. */
let lobbyCode;

describe('Chunk 3.2 REST API (real Fastify + Neon + Upstash)', () => {
  before(async () => {
    assert.ok(TEXTURE.length < 2 * 1024 * 1024, `fixture PNG must fit the 2 MB cap, got ${TEXTURE.length}`);
    app = await buildApp();
    await app.ready();
  });

  test('GET /healthz reports both dependencies', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(res.statusCode, 200, 'healthz must answer 200 even when degraded');

    const body = res.json();
    assert.ok(['ok', 'degraded'].includes(body.status));
    // `null` == not configured; a boolean == a real probe just ran.
    assert.equal(body.checks.postgres, hasDatabase() ? true : null);
    assert.equal(body.checks.redis, hasRedis ? true : null);
    if (hasDatabase() && hasRedis) assert.equal(body.status, 'ok');
  });

  test('POST /api/lobbies creates a lobby with a valid join code', { skip: skipPg }, async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/lobbies',
      payload: { name: `${RUN_ID} party` },
    });
    assert.equal(res.statusCode, 201, res.payload);

    const body = res.json();
    lobbyCode = body.lobby.code;
    created.lobbies.push(body.lobby.id);
    created.redisKeys.push(lobbyPlayersKey(lobbyCode));

    assert.match(lobbyCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/, 'contract join code');
    assert.equal(body.lobby.name, `${RUN_ID} party`);
    assert.equal(body.lobby.closedAt, null);
    assert.ok(body.joinUrl.includes(lobbyCode), `joinUrl should carry the code: ${body.joinUrl}`);

    const get = await app.inject({ method: 'GET', url: `/api/lobbies/${lobbyCode}` });
    assert.equal(get.statusCode, 200);
    assert.equal(get.json().memberCount, 0);
    assert.deepEqual(get.json().members, []);

    // Lower-case codes are normalised by the shared schema, not rejected.
    const lower = await app.inject({ method: 'GET', url: `/api/lobbies/${lobbyCode.toLowerCase()}` });
    assert.equal(lower.statusCode, 200);
    assert.equal(lower.json().lobby.code, lobbyCode);
  });

  test('GET /api/lobbies/:code 404s for an unknown lobby', { skip: skipPg }, async () => {
    const res = await app.inject({ method: 'GET', url: '/api/lobbies/ZZZZZ' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, 'not_found');

    const malformed = await app.inject({ method: 'GET', url: '/api/lobbies/nope' });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error, 'bad_request');
  });

  test('POST /api/avatars stores the texture and joins the lobby', { skip: skipPg }, async () => {
    assert.ok(lobbyCode, 'lobby must exist');
    created.redisKeys.push(textureKey(TEXTURE_HASH));

    const res = await app.inject({
      method: 'POST',
      url: '/api/avatars',
      ...avatarUpload({ lobbyCode }),
    });
    assert.equal(res.statusCode, 201, res.payload);

    const body = res.json();
    created.players.push(body.player.id);
    created.avatars.push(body.avatar.id);

    assert.equal(body.player.name, PLAYER_NAME);
    assert.equal(body.avatar.modelSlug, 'trex');
    assert.equal(body.avatar.textureHash, TEXTURE_HASH, 'server must derive the sha256 itself');
    assert.equal(body.textureUrl, `/api/textures/${TEXTURE_HASH}`);

    // The bytes really landed in Postgres, not just in the response.
    const [stored] = await db().select().from(avatars).where(eq(avatars.textureHash, TEXTURE_HASH));
    assert.ok(stored.texture.equals(TEXTURE), 'stored texture must be byte-identical');

    if (hasRedis) {
      const cached = await redis.getTexture(TEXTURE_HASH);
      assert.ok(cached?.equals(TEXTURE), 'upload must warm the Redis cache');
      assert.ok(
        (await redis.listLobbyMembers(lobbyCode)).includes(body.player.id),
        'upload must add the player to live lobby membership',
      );
    }
  });

  test('GET /api/textures/:hash returns identical bytes with immutable caching', { skip: skipPg }, async () => {
    const res = await app.inject({ method: 'GET', url: `/api/textures/${TEXTURE_HASH}` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/png');
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.ok(res.rawPayload.equals(TEXTURE), 'served bytes must be byte-identical to the upload');
    assert.equal(createHash('sha256').update(res.rawPayload).digest('hex'), TEXTURE_HASH);

    // Cache miss → Postgres fallback → cache re-warmed.
    if (hasRedis) {
      await redis.del(textureKey(TEXTURE_HASH));
      assert.equal(await redis.getTexture(TEXTURE_HASH), null, 'cache should be cold now');

      const cold = await app.inject({ method: 'GET', url: `/api/textures/${TEXTURE_HASH}` });
      assert.equal(cold.statusCode, 200);
      assert.ok(cold.rawPayload.equals(TEXTURE), 'postgres fallback must serve identical bytes');
      assert.ok(
        (await redis.getTexture(TEXTURE_HASH))?.equals(TEXTURE),
        'a cache miss must re-warm the cache',
      );
    }

    const unknown = 'f'.repeat(64);
    const missing = await app.inject({ method: 'GET', url: `/api/textures/${unknown}` });
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error, 'not_found');

    const malformed = await app.inject({ method: 'GET', url: '/api/textures/not-a-hash' });
    assert.equal(malformed.statusCode, 400);
    assert.equal(malformed.json().error, 'bad_request');
  });

  test('GET /api/lobbies/:code lists the player with their dino', { skip: skipPg }, async () => {
    const res = await app.inject({ method: 'GET', url: `/api/lobbies/${lobbyCode}` });
    assert.equal(res.statusCode, 200);

    const body = res.json();
    assert.equal(body.memberCount, 1);
    assert.equal(body.members.length, 1);
    assert.equal(body.members[0].name, PLAYER_NAME);
    assert.equal(body.members[0].modelSlug, 'trex');
    assert.equal(body.members[0].textureHash, TEXTURE_HASH);
  });

  test('re-uploading the same drawing is idempotent, not an error', { skip: skipPg }, async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/avatars',
      ...avatarUpload({ lobbyCode }),
    });
    // texture_hash is UNIQUE: a duplicate is "already stored" (SQLSTATE 23505
    // is swallowed), never a 500.
    assert.equal(res.statusCode, 201, res.payload);

    const body = res.json();
    assert.equal(body.avatar.textureHash, TEXTURE_HASH);
    assert.equal(body.avatar.id, created.avatars[0], 'must reuse the existing avatar row');
    assert.equal(body.player.id, created.players[0], 'same name in the same lobby is the same player');

    const lobby = await app.inject({ method: 'GET', url: `/api/lobbies/${lobbyCode}` });
    assert.equal(lobby.json().memberCount, 1, 'a retake must not duplicate the member');
  });

  test('bad uploads return structured contract errors', { skip: skipPg }, async () => {
    // 1. not a PNG at all
    const notPng = await app.inject({
      method: 'POST',
      url: '/api/avatars',
      ...avatarUpload({ lobbyCode, texture: Buffer.from('this is definitely not a png') }),
    });
    assert.equal(notPng.statusCode, 422, notPng.payload);
    assert.equal(notPng.json().error, 'texture_invalid');
    assert.equal(notPng.json().details.reason, 'not_png');

    // 2. a real PNG of the wrong size
    const wrongSize = await app.inject({
      method: 'POST',
      url: '/api/avatars',
      ...avatarUpload({ lobbyCode, texture: SMALL_TEXTURE }),
    });
    assert.equal(wrongSize.statusCode, 422, wrongSize.payload);
    assert.equal(wrongSize.json().error, 'texture_invalid');
    assert.equal(wrongSize.json().details.reason, 'wrong_dimensions');
    assert.equal(wrongSize.json().details.width, 32);

    // 3. missing the file part entirely
    const noFile = await app.inject({
      method: 'POST',
      url: '/api/avatars',
      ...multipart([
        { name: 'playerName', value: PLAYER_NAME },
        { name: 'lobbyCode', value: lobbyCode },
        { name: 'modelSlug', value: 'trex' },
      ]),
    });
    assert.equal(noFile.statusCode, 400);
    assert.equal(noFile.json().error, 'bad_request');

    // 4. invalid field values (unknown dino)
    const badSlug = await app.inject({
      method: 'POST',
      url: '/api/avatars',
      ...avatarUpload({ lobbyCode, modelSlug: 'velociraptorex' }),
    });
    assert.equal(badSlug.statusCode, 400);
    assert.equal(badSlug.json().error, 'bad_request');

    // 5. a lobby that doesn't exist
    const noLobby = await app.inject({
      method: 'POST',
      url: '/api/avatars',
      ...avatarUpload({ lobbyCode: 'ZZZZZ' }),
    });
    assert.equal(noLobby.statusCode, 404);
    assert.equal(noLobby.json().error, 'not_found');

    // 6. not multipart at all
    const json = await app.inject({
      method: 'POST',
      url: '/api/avatars',
      payload: { playerName: PLAYER_NAME },
    });
    assert.equal(json.json().error, 'bad_request');

    // None of the above may have written anything.
    const lobby = await app.inject({ method: 'GET', url: `/api/lobbies/${lobbyCode}` });
    assert.equal(lobby.json().memberCount, 1, 'failed uploads must not create members');
  });

  after(async () => {
    const problems = [];
    try {
      if (app) await app.close();
    } catch (err) {
      problems.push(`app close: ${err instanceof Error ? err.message : err}`);
    }
    if (!skipPg) {
      for (const [label, fn] of [
        [
          'avatars',
          () =>
            created.players.length &&
            db().delete(avatars).where(inArray(avatars.playerId, created.players)),
        ],
        [
          'lobby_members',
          () =>
            created.lobbies.length &&
            db().delete(lobbyMembers).where(inArray(lobbyMembers.lobbyId, created.lobbies)),
        ],
        [
          'lobbies',
          () => created.lobbies.length && db().delete(lobbies).where(inArray(lobbies.id, created.lobbies)),
        ],
        [
          'players',
          () => created.players.length && db().delete(players).where(inArray(players.id, created.players)),
        ],
        ['redis keys', () => created.redisKeys.length && redis.del(...created.redisKeys)],
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
