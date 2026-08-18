/**
 * E2E #3 — Wave 4, Chunk 4.1 (the lobby-connected game view).
 *
 * One browser, everything else real:
 *
 *   POST /api/lobbies over HTTP            (real Fastify → real Neon)
 *     → open `/play?lobby=CODE`            (real web build, spectator join)
 *     → the browser opens a real WebSocket to the real Colyseus room
 *     → POST /api/avatars with a 1024² PNG (request context — no browser)
 *     → the room fans the upload out over the socket, the page prefetches the
 *       PNG from `GET /api/textures/:hash` and hot-swaps it onto the model
 *     → assert the dino AND its texture hash are in `window.__world` ≤ 5 s
 *
 * That last assertion is the whole product in one line: paper → phone → API →
 * Postgres → Redis → Colyseus → someone else's screen. Chunk 4.3's flagship
 * replaces the request-context upload with a second, mobile-emulated browser
 * pushing a photo through the real pipeline.
 *
 * **Secrets**: creating a lobby needs Neon, so with no `.env` this file skips
 * rather than fails — the same rule the server integration tests follow. It
 * asks the running server (`/healthz` reports `checks.postgres === null` when
 * Postgres is not configured) instead of looking for a file, so it is right
 * about the server the browser is actually talking to.
 *
 * Nothing here modifies E2E #1 or #2. `window.__world`'s type comes from the
 * `declare global` in `02-world.spec.ts` — one program, one contract.
 */
import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import {
  CreateAvatarResponseSchema,
  CreateLobbyResponseSchema,
  HealthSchema,
} from '@dino/shared';
import { SERVER_BASE_URL } from '../playwright.config.js';
import { makePng } from '../support/fixture-png.js';

/**
 * Tags every row this run creates, so leftovers in Neon are identifiable.
 * The full uuid seeds the texture, so its content address is unique per run
 * (`avatars.texture_hash` is UNIQUE).
 */
const RUN_UUID = randomUUID();
const RUN_ID = RUN_UUID.slice(0, 8);
const PLAYER_NAME = `e2e-${RUN_ID}`;

/** The Wave 4 budget: a drawing is on the projector within five seconds. */
const FANOUT_BUDGET_MS = 5000;

test.use({
  viewport: { width: 1000, height: 800 },
  launchOptions: {
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  },
});

/** `null` when the server has no Postgres — the signal to skip. */
async function postgresConfigured(request: APIRequestContext): Promise<boolean> {
  const res = await request.get(`${SERVER_BASE_URL}/healthz`);
  expect(res.ok(), 'the server under test must be up').toBe(true);
  return HealthSchema.parse(await res.json()).checks.postgres !== null;
}

test('the game view prompts for a code when the URL has no lobby', async ({ page }) => {
  // Needs no secrets: this path never reaches the room or the database.
  await page.goto('/play');
  await expect(page.getByTestId('lobby-code-prompt')).toBeVisible();
  await expect(page.getByTestId('lobby-code-submit')).toBeDisabled();

  await page.getByTestId('lobby-code-input').fill('ab');
  await expect(page.getByTestId('lobby-code-submit')).toBeDisabled();
});

test('a drawing uploaded over HTTP appears on the spectator screen', async ({ page, request }) => {
  test.skip(!(await postgresConfigured(request)), 'no DATABASE_URL — skipping the live lobby E2E');

  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  // ── 1. A real lobby, created the way the host's device creates one ───────
  const created = await request.post(`${SERVER_BASE_URL}/api/lobbies`, {
    data: { name: `e2e ${RUN_ID}` },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { lobby, joinUrl } = CreateLobbyResponseSchema.parse(await created.json());

  // ── 2. The projector opens the game view and spectates ───────────────────
  await page.goto(`/play?lobby=${lobby.code}`);

  await expect(page.getByTestId('lobby-code')).toHaveText(lobby.code);
  const status = page.getByTestId('lobby-status');
  await expect(status).toHaveAttribute('data-status', 'connected');
  // Spectating adds no dino of its own.
  await expect(status).toHaveAttribute('data-dino-count', '0');

  // The QR code encodes the same join URL the API hands out.
  const qr = page.getByTestId('lobby-qr');
  await expect(qr).toBeVisible();
  const encoded = await qr.getAttribute('data-qr-value');
  expect(encoded).toContain(`lobby=${lobby.code}`);
  expect(new URL(joinUrl).searchParams.get('lobby')).toBe(lobby.code);

  // ── 3. A phone uploads a drawing over plain HTTP, with no browser ────────
  const png = makePng(1024, RUN_UUID);
  const expectedHash = createHash('sha256').update(png).digest('hex');

  const started = Date.now();
  const uploaded = await request.post(`${SERVER_BASE_URL}/api/avatars`, {
    multipart: {
      lobbyCode: lobby.code,
      playerName: PLAYER_NAME,
      modelSlug: 'raptor',
      texture: { name: 'texture.png', mimeType: 'image/png', buffer: png },
    },
  });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const avatar = CreateAvatarResponseSchema.parse(await uploaded.json());
  expect(avatar.avatar.textureHash).toBe(expectedHash);
  const playerId = avatar.player.id;

  // ── 4. …and it is on the screen within the budget ────────────────────────
  await page.waitForFunction(
    (args) =>
      window.__world?.dinoCount === 1 && window.__world?.appliedTextures[args.id] === args.hash,
    { id: playerId, hash: expectedHash },
    { timeout: FANOUT_BUDGET_MS },
  );
  const elapsed = Date.now() - started;

  const world = await page.evaluate(() => ({ ...window.__world }));
  expect(world.dinoCount).toBe(1);
  expect(world.appliedTextures?.[playerId]).toBe(expectedHash);
  expect(world.textureErrors).toEqual({});
  expect(world.pendingTextures).toBe(0);
  expect(world.frames).toBeGreaterThan(0);
  // Live mode is not screenshot mode; the world is animating.
  expect(world.frozen).toBe(false);
  // The harness and the live view report the same contract version.
  expect(world.version).toBe(1);

  // The nameplate comes from synchronized state, not from anything local.
  await expect(page.getByTestId('nameplate')).toHaveCount(1);
  await expect(page.getByTestId('nameplate')).toHaveText(PLAYER_NAME);
  await expect(status).toHaveAttribute('data-dino-count', '1');

  expect(failures, 'the live game view ran without console/page errors').toEqual([]);
  expect(elapsed, `upload → projector took ${elapsed}ms`).toBeLessThan(FANOUT_BUDGET_MS);
});
