/**
 * `pnpm --filter @dino/server loadtest` — 50 phones in one lobby.
 *
 * The venue is a school hall with one projector and a class of children, so the
 * question this answers is narrow and specific: **when fifty clients sit in a
 * single `LobbyRoom` and a few of them upload drawings, does everybody see
 * everything, how fast, and what does it cost the server?**
 *
 * It is NOT part of `pnpm test` — it needs Neon, it takes ~a minute, and it
 * starts a real server. Run it by hand before the event.
 *
 * Built on `@colyseus/loadtest` (0.16, matching the server's Colyseus): its
 * `Options` shape and its `cli()` driver. `--tui` gives you that tool's live
 * blessed dashboard; the default is a headless run that prints numbers you can
 * paste into a report, because a TUI cannot be recorded in PLAN.md.
 *
 * Usage:
 *   pnpm --filter @dino/server loadtest                  # 50 clients, 5 uploads
 *   pnpm --filter @dino/server loadtest -- --numClients 100 --uploads 10
 *   pnpm --filter @dino/server loadtest -- --endpoint ws://host:2567 --no-spawn
 *   pnpm --filter @dino/server loadtest -- --tui         # @colyseus/loadtest UI
 *
 * Requires `pnpm build` first (it launches `dist/index.js`), and a `.env` with
 * DATABASE_URL — a lobby has to exist in Postgres before a room will accept it.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cli, type Options } from '@colyseus/loadtest';
import { Client, type Room } from 'colyseus.js';
// The same generator the integration tests use: a real, valid 1024² PNG whose
// bytes (and therefore content address) are unique per run.
// @ts-expect-error — plain-JS test helper, deliberately untyped.
import { makePng } from '../test/fixture-png.mjs';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, '..');

// ── options ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : fallback;
};
const has = (name: string): boolean => argv.includes(`--${name}`);

const PORT = Number(flag('port', '2568')); // not 2567: never fight a dev server
const HTTP = flag('httpEndpoint', `http://127.0.0.1:${PORT}`);
const ENDPOINT = flag('endpoint', HTTP.replace(/^http/, 'ws'));
const NUM_CLIENTS = Number(flag('numClients', '50'));
const UPLOADS = Number(flag('uploads', '5'));
/** How long to watch a settled room to measure patch cadence. */
const OBSERVE_MS = Number(flag('observeMs', '10000'));
const SPAWN = !has('no-spawn');
const RUN_ID = `lt${Date.now().toString(36)}`;

// ── helpers ────────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ms = (n: number): string => `${n.toFixed(0)} ms`;
const pct = (values: number[], p: number): number => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;
};

/** Resident set size of a pid, in MB. Windows and POSIX. */
async function rssMb(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('powershell', [
        '-NoProfile',
        '-Command',
        `(Get-Process -Id ${pid}).WorkingSet64`,
      ]);
      return Number(stdout.trim()) / 1024 / 1024;
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'rss=', '-p', String(pid)]);
    return Number(stdout.trim()) / 1024;
  } catch {
    return null;
  }
}

async function waitForHealth(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${HTTP}/healthz`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  return false;
}

/** Boots the built server on its own port, unless one is already answering. */
async function startServer(): Promise<ChildProcess | null> {
  if (await waitForHealth(500)) {
    console.log(`• using the server already answering on ${HTTP}`);
    return null;
  }
  if (!SPAWN) throw new Error(`nothing is listening on ${HTTP} and --no-spawn was passed`);

  console.log(`• starting apps/server/dist/index.js on port ${PORT} (run \`pnpm build\` if this fails)`);
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      // Every "phone" in this test is 127.0.0.1, so the per-IP upload bucket
      // (12/min in production) would refuse the run rather than the server
      // being tested. Raise it here rather than switching the limiter off, so
      // the code path under load is still the real one.
      AVATAR_UPLOAD_LIMIT_PER_MIN: flag('uploadLimit', '600'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[server] ${b.toString()}`));
  if (!(await waitForHealth())) {
    child.kill();
    throw new Error('the server never became healthy');
  }
  return child;
}

interface Tracked {
  room: Room;
  /** Wall-clock arrival of every state patch, for cadence. */
  patches: number[];
  /** playerId → when this client first saw a non-empty textureHash for them. */
  sawTexture: Map<string, number>;
}

/**
 * One client's script — the `main(options)` entrypoint `@colyseus/loadtest`
 * drives in `--tui` mode, reused verbatim by the headless runner below.
 */
async function connectOne(options: Options, roomCode: string, tracked: Tracked[]): Promise<void> {
  const client = new Client(options.endpoint);
  const room = await client.joinOrCreate(options.roomName, {
    code: roomCode,
    name: `${RUN_ID}-c${options.clientId}`,
  });

  // The real client prefetches the texture on this message; here it only keeps
  // colyseus.js from logging an "unregistered handler" line per upload.
  room.onMessage('avatar-updated', () => {});

  const entry: Tracked = { room, patches: [], sawTexture: new Map() };
  room.onStateChange(() => {
    entry.patches.push(Date.now());
    const players = (room.state as unknown as { players: Map<string, { id: string; textureHash: string }> }).players;
    players?.forEach((player) => {
      if (player.textureHash && !entry.sawTexture.has(player.id)) {
        entry.sawTexture.set(player.id, Date.now());
      }
    });
  });
  tracked.push(entry);
}

// ── the run ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const server = await startServer();
  const started = Date.now();

  try {
    // 1. a real lobby (Postgres is the source of truth for join codes) --------
    const lobbyRes = await fetch(`${HTTP}/api/lobbies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: `loadtest ${RUN_ID}` }),
    });
    if (!lobbyRes.ok) throw new Error(`POST /api/lobbies → ${lobbyRes.status} ${await lobbyRes.text()}`);
    const { lobby } = (await lobbyRes.json()) as { lobby: { code: string } };
    console.log(`• lobby ${lobby.code} · ${NUM_CLIENTS} clients → ${ENDPOINT}`);

    // 2. fill the room -------------------------------------------------------
    const options: Options = {
      endpoint: ENDPOINT,
      roomName: 'lobby',
      roomId: '',
      numClients: NUM_CLIENTS,
      delay: 0,
      logLevel: 'all',
      reestablishAllDelay: 0,
      retryFailed: 0,
      output: '',
      clientId: 0,
    };

    const tracked: Tracked[] = [];
    const joinTimes: number[] = [];
    let failed = 0;
    for (let i = 0; i < NUM_CLIENTS; i++) {
      const t0 = Date.now();
      try {
        await connectOne({ ...options, clientId: i }, lobby.code, tracked);
        joinTimes.push(Date.now() - t0);
      } catch (err) {
        failed++;
        console.error(`  client ${i} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`• joined ${tracked.length}/${NUM_CLIENTS} (${failed} failed) · join p50 ${ms(pct(joinTimes, 50))} · p95 ${ms(pct(joinTimes, 95))}`);

    // Let the room settle so "synced" means the same thing for everybody.
    await sleep(2000);
    const roomSize = (t: Tracked): number =>
      (t.room.state as unknown as { players: { size: number } }).players?.size ?? 0;
    const synced = tracked.filter((t) => roomSize(t) >= tracked.length).length;
    console.log(`• synced ${synced}/${tracked.length} clients see all ${tracked.length} players`);

    // 3. uploads mid-run -----------------------------------------------------
    // The number that matters at the venue: a phone finishes uploading, and
    // every screen in the room has the new dino in its state N ms later.
    const uploadLatencies: number[] = [];
    const uploadedHashes: string[] = [];
    for (let u = 0; u < UPLOADS; u++) {
      const uploader = tracked[u % tracked.length];
      if (!uploader) break;
      const name = `${RUN_ID}-c${u}`;
      const texture: Buffer = makePng(1024, `${RUN_ID}-${u}`);
      const hash = createHash('sha256').update(texture).digest('hex');
      uploadedHashes.push(hash);

      const form = new FormData();
      form.set('lobbyCode', lobby.code);
      form.set('playerName', name);
      form.set('modelSlug', 'trex');
      form.set('texture', new Blob([texture], { type: 'image/png' }), 'texture.png');

      const t0 = Date.now();
      const res = await fetch(`${HTTP}/api/avatars`, { method: 'POST', body: form });
      if (!res.ok) {
        console.error(`  upload ${u} → ${res.status} ${await res.text()}`);
        continue;
      }
      const { player } = (await res.json()) as { player: { id: string } };
      const accepted = Date.now();

      // Wait for the LAST client to see it — the projector promise is about
      // everybody, not the median.
      const deadline = Date.now() + 10_000;
      let seen = 0;
      while (Date.now() < deadline) {
        seen = tracked.filter((t) => t.sawTexture.has(player.id)).length;
        if (seen === tracked.length) break;
        await sleep(10);
      }
      const last = Math.max(
        ...tracked.map((t) => t.sawTexture.get(player.id) ?? Number.NEGATIVE_INFINITY),
      );
      uploadLatencies.push(last - accepted);
      console.log(
        `  upload ${u + 1}/${UPLOADS} (${(texture.length / 1024).toFixed(0)} kB, ${hash.slice(0, 8)}…): ` +
          `POST ${ms(accepted - t0)} · state on ${seen}/${tracked.length} clients ` +
          `· slowest ${ms(last - accepted)}`,
      );
    }

    // 4. cadence + cost ------------------------------------------------------
    const observeFrom = Date.now();
    const rssBefore = server ? await rssMb(server.pid ?? 0) : null;
    await sleep(OBSERVE_MS);
    const rssAfter = server ? await rssMb(server.pid ?? 0) : null;

    const patchCounts = tracked.map((t) => t.patches.filter((at) => at >= observeFrom).length);
    const perSecond = patchCounts.map((n) => n / (OBSERVE_MS / 1000));
    const totalPatches = patchCounts.reduce((a, b) => a + b, 0);

    console.log('');
    console.log('── results ───────────────────────────────────────────────');
    console.log(`clients joined      : ${tracked.length}/${NUM_CLIENTS} (${failed} failed)`);
    console.log(`clients fully synced: ${synced}/${tracked.length}`);
    console.log(`join latency        : p50 ${ms(pct(joinTimes, 50))} · p95 ${ms(pct(joinTimes, 95))} · max ${ms(Math.max(...joinTimes, 0))}`);
    if (uploadLatencies.length) {
      console.log(
        `upload → state (last client): p50 ${ms(pct(uploadLatencies, 50))} · max ${ms(Math.max(...uploadLatencies))} over ${uploadLatencies.length} uploads`,
      );
    }
    console.log(
      `patch cadence       : ${(perSecond.reduce((a, b) => a + b, 0) / (perSecond.length || 1)).toFixed(2)} patches/s per client ` +
        `(${totalPatches} patches across ${tracked.length} clients in ${OBSERVE_MS / 1000}s)`,
    );
    console.log(
      `server memory (RSS) : ${rssBefore === null ? 'n/a' : `${rssBefore.toFixed(1)} MB → ${rssAfter?.toFixed(1)} MB`}`,
    );
    console.log(`loadtest client RSS : ${(process.memoryUsage().rss / 1024 / 1024).toFixed(1)} MB`);
    console.log(`elapsed             : ${((Date.now() - started) / 1000).toFixed(1)} s`);
    console.log('──────────────────────────────────────────────────────────');

    for (const t of tracked) await t.room.leave(true).catch(() => {});
    await sleep(500);

    if (!has('keep')) await cleanUp(lobby.code, uploadedHashes);
  } finally {
    if (server) server.kill();
  }
}

/**
 * Deletes everything this run put in Neon. A loadtest that leaves fifty players
 * and a handful of megabyte textures behind every time is litter, and the E2E
 * cleanup script only knows about rows named `e2e-…`.
 */
async function cleanUp(lobbyCode: string, hashes: string[]): Promise<void> {
  const { db, avatars, lobbies, lobbyMembers, players, textures } = await import('../src/db.js');
  const { and, eq, inArray, like } = await import('drizzle-orm');
  try {
    const mine = await db().select({ id: players.id }).from(players).where(like(players.name, `${RUN_ID}-%`));
    const ids = mine.map((p) => p.id);
    if (ids.length) await db().delete(avatars).where(inArray(avatars.playerId, ids));
    if (hashes.length) await db().delete(textures).where(inArray(textures.hash, hashes));
    const [lobby] = await db().select({ id: lobbies.id }).from(lobbies).where(eq(lobbies.code, lobbyCode));
    if (lobby) await db().delete(lobbyMembers).where(eq(lobbyMembers.lobbyId, lobby.id));
    if (ids.length) await db().delete(lobbyMembers).where(inArray(lobbyMembers.playerId, ids));
    if (ids.length) await db().delete(players).where(inArray(players.id, ids));
    if (lobby) await db().delete(lobbies).where(and(eq(lobbies.id, lobby.id)));
    console.log(`• cleaned up ${ids.length} players, ${hashes.length} textures and lobby ${lobbyCode}`);
  } catch (err) {
    console.error(`  cleanup failed (rows left behind, run id ${RUN_ID}):`, err);
  }
}

if (has('tui')) {
  // The @colyseus/loadtest dashboard. It needs a lobby code to join, so pass
  // one with `--lobby ABCDE` (create it with POST /api/lobbies first).
  const code = flag('lobby', '');
  if (!code) throw new Error('--tui needs an existing lobby: --lobby ABCDE');
  cli(async (options: Options) => {
    await connectOne(options, code, []);
  });
} else {
  await main();
  process.exit(0);
}
