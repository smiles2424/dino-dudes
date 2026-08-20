/**
 * The lobby-connected game view: one browser, everything else real. A drawing
 * uploaded over plain HTTP with no browser involved must reach the spectating
 * page within {@link FANOUT_BUDGET_MS} — one assertion covering paper → phone →
 * API → Postgres → Redis → Colyseus → someone else's screen.
 *
 * Skips without Neon, asked of the running server via `/healthz` rather than by
 * looking for a file, so it is right about the server the browser is actually
 * talking to.
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
 * Tags every row this run creates so leftovers in Neon are identifiable. The
 * full uuid seeds the texture, so its content address is unique per run.
 */
const RUN_UUID = randomUUID();
const RUN_ID = RUN_UUID.slice(0, 8);
const PLAYER_NAME = `e2e-${RUN_ID}`;

/**
 * Once the upload has been accepted, the drawing is on the projector within
 * five seconds.
 *
 * The clock starts when `POST /api/avatars` *responds*. Starting it at send
 * would fold the upload itself — a 1 MB body, a Neon insert and an Upstash
 * publish, 1.5–8 s from a home connection — into a budget that exists to
 * measure fan-out. Upload latency is printed separately so a regression there
 * cannot silently eat this budget.
 */
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
  /*
   * This spec builds the SwiftShader scene *and* waits on a real upload, so it
   * needs the same headroom 02 and 04 take. The per-step budgets are untouched
   * — FANOUT_BUDGET_MS still holds the room to 5 s and is the assertion that
   * means something; only the total gets room.
   */
  test.setTimeout(120_000);

  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  const created = await request.post(`${SERVER_BASE_URL}/api/lobbies`, {
    data: { name: `e2e ${RUN_ID}` },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { lobby, joinUrl } = CreateLobbyResponseSchema.parse(await created.json());

  await page.goto(`/play?lobby=${lobby.code}`);

  await expect(page.getByTestId('lobby-code')).toHaveText(lobby.code);
  const status = page.getByTestId('lobby-status');
  await expect(status).toHaveAttribute('data-status', 'connected');
  // Spectating adds no dino of its own.
  await expect(status).toHaveAttribute('data-dino-count', '0');

  const qr = page.getByTestId('lobby-qr');
  await expect(qr).toBeVisible();
  const encoded = await qr.getAttribute('data-qr-value');
  expect(encoded).toContain(`lobby=${lobby.code}`);
  expect(new URL(joinUrl).searchParams.get('lobby')).toBe(lobby.code);

  const png = makePng(1024, RUN_UUID);
  const expectedHash = createHash('sha256').update(png).digest('hex');

  const postStarted = Date.now();
  const uploaded = await request.post(`${SERVER_BASE_URL}/api/avatars`, {
    multipart: {
      lobbyCode: lobby.code,
      playerName: PLAYER_NAME,
      modelSlug: 'raptor',
      texture: { name: 'texture.png', mimeType: 'image/png', buffer: png },
    },
  });
  // The fan-out budget starts here: the server has the drawing and has told
  // everyone about it, and every millisecond after this is the room's.
  const fanoutStarted = Date.now();
  const uploadMs = fanoutStarted - postStarted;
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const avatar = CreateAvatarResponseSchema.parse(await uploaded.json());
  expect(avatar.avatar.textureHash).toBe(expectedHash);
  const playerId = avatar.player.id;

  await page.waitForFunction(
    (args) =>
      window.__world?.dinoCount === 1 && window.__world?.appliedTextures[args.id] === args.hash,
    { id: playerId, hash: expectedHash },
    { timeout: FANOUT_BUDGET_MS },
  );
  const fanoutMs = Date.now() - fanoutStarted;
  console.log(`[e2e#3] POST /api/avatars: ${uploadMs}ms · upload → projector: ${fanoutMs}ms`);

  const world = await page.evaluate(() => ({ ...window.__world }));
  expect(world.dinoCount).toBe(1);
  expect(world.appliedTextures?.[playerId]).toBe(expectedHash);
  expect(world.textureErrors).toEqual({});
  expect(world.pendingTextures).toBe(0);
  expect(world.frames).toBeGreaterThan(0);
  // Live mode is not screenshot mode; the world is animating.
  expect(world.frozen).toBe(false);
  expect(world.version).toBe(3);
  // A live lobby times its wander from the server's clock.
  expect(world.motion?.source).toBe('server');
  expect(world.motion?.seed).toMatch(/^[0-9a-f]{16}$/);
  expect(world.motion?.epoch).toBeGreaterThan(0);
  expect(world.offscreen).toBe(0);

  // The nameplate comes from synchronized state, not from anything local.
  await expect(page.getByTestId('nameplate')).toHaveCount(1);
  await expect(page.getByTestId('nameplate')).toHaveText(PLAYER_NAME);
  await expect(status).toHaveAttribute('data-dino-count', '1');

  expect(failures, 'the live game view ran without console/page errors').toEqual([]);
  expect(fanoutMs, `upload → projector took ${fanoutMs}ms`).toBeLessThan(FANOUT_BUDGET_MS);
});
