/**
 * E2E #4 — Wave 4, Chunk 4.2 (the mobile capture flow).
 *
 * One mobile-sized browser, and the whole chain is real — no stubs, no fake
 * pipeline, no fake server:
 *
 *   POST /api/lobbies                     (real Fastify → real Neon)
 *     → open `/?lobby=CODE`               (the QR code's payload; code prefilled)
 *     → name + code, validated against GET /api/lobbies/:code
 *     → pick a dinosaur
 *     → `setInputFiles` a REAL fixture photo into `<input capture>`
 *     → `@dino/pipeline` deskews it IN THE BROWSER (208 KB of TS, no WASM)
 *     → the drawing is previewed on the REAL 3D model (`<WorldView>`)
 *     → confirm → POST /api/avatars (multipart, 1024² PNG)
 *     → land on `/play?…&playerId=…` and see the dino wearing that exact
 *       texture hash in `window.__world`
 *
 * The failure path is exercised first, with the fixture whose bottom-left
 * marker is covered by a thumb: it must produce the per-corner retake UI (not
 * a stack trace), and the same file input must then accept a good photo.
 *
 * **Secrets**: creating a lobby needs Neon, so with no `.env` the lobby tests
 * skip rather than fail — the same `/healthz` probe E2E #3 uses. The two
 * checks that need no server at all still run.
 *
 * Nothing here modifies E2E #1–#3. `window.__world`'s type comes from the
 * `declare global` in `02-world.spec.ts`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { CreateLobbyResponseSchema, HealthSchema } from '@dino/shared';
import { SERVER_BASE_URL } from '../playwright.config.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixture = (name: string): string => path.join(repoRoot, 'assets', 'fixtures', name);

/** A clean, flat, well-lit photo — the happy path. */
const GOOD_PHOTO = fixture('photo-01-flat.png');
/** WS-A's deliberate failure case: a thumb over the bottom-left marker. */
const OCCLUDED_PHOTO = fixture('photo-11-occluded.png');

const RUN_ID = randomUUID().slice(0, 8);

/** Budget for decode + downscale + the whole in-browser pipeline. */
const PIPELINE_BUDGET_MS = 15_000;
/** Budget for upload → the dino wearing its drawing on the game view. */
const HANDOFF_BUDGET_MS = 15_000;

// A phone, because this flow only exists for phones. SwiftShader because the
// preview renders the real 3D model in a headless browser.
test.use({
  viewport: { width: 390, height: 844 },
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

async function createLobby(request: APIRequestContext): Promise<string> {
  const created = await request.post(`${SERVER_BASE_URL}/api/lobbies`, {
    data: { name: `e2e ${RUN_ID}` },
  });
  expect(created.status(), await created.text()).toBe(201);
  return CreateLobbyResponseSchema.parse(await created.json()).lobby.code;
}

/** Walk the two form steps, leaving the page on the photo step. */
async function reachPhotoStep(page: Page, name: string, model: string): Promise<void> {
  await expect(page.getByTestId('capture-details')).toBeVisible();
  await page.getByTestId('capture-name').fill(name);
  await page.getByTestId('capture-details-submit').click();

  await expect(page.getByTestId('capture-model')).toBeVisible();
  await page.getByTestId(`capture-model-${model}`).click();
  await expect(page.getByTestId(`capture-model-${model}`)).toHaveAttribute('data-selected', 'true');
  await page.getByTestId('capture-model-submit').click();

  await expect(page.getByTestId('capture-photo')).toBeVisible();
}

test('the capture flow validates a lobby code before anyone draws', async ({ page }) => {
  // Needs no secrets: a malformed code never leaves the browser.
  await page.goto('/');

  await expect(page.getByTestId('capture-flow')).toHaveAttribute('data-step', 'details');
  await expect(page.getByTestId('capture-code')).toHaveValue('');

  await page.getByTestId('capture-details-submit').click();
  await expect(page.getByTestId('capture-details-error')).toContainText(/name/i);

  await page.getByTestId('capture-name').fill('Sam');
  await page.getByTestId('capture-code').fill('ab');
  await page.getByTestId('capture-details-submit').click();
  await expect(page.getByTestId('capture-details-error')).toContainText(/5 letters and numbers/i);

  // Still on step one — nothing advanced on an invalid code.
  await expect(page.getByTestId('capture-flow')).toHaveAttribute('data-step', 'details');
});

test('the lobby code is prefilled from the QR code URL', async ({ page }) => {
  // `?lobby=CODE` is the shape `POST /api/lobbies` hands out and the
  // projector's QR code encodes. No server call happens until "Next".
  await page.goto('/?lobby=ABC23');
  await expect(page.getByTestId('capture-code')).toHaveValue('ABC23');

  // A junk code in the URL must not be silently accepted as prefill.
  await page.goto('/?lobby=nope');
  await expect(page.getByTestId('capture-code')).toHaveValue('');
});

test('an unreadable photo becomes per-corner retake hints, then a good one goes through', async ({
  page,
  request,
}) => {
  test.skip(!(await postgresConfigured(request)), 'no DATABASE_URL — skipping the capture E2E');
  test.setTimeout(120_000);

  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  const code = await createLobby(request);
  const playerName = `e2e-${RUN_ID}`;

  // ── 1. The phone opens the join link and the code is already there ────────
  await page.goto(`/?lobby=${code}`);
  await expect(page.getByTestId('capture-code')).toHaveValue(code);

  await reachPhotoStep(page, playerName, 'raptor');

  // ── 2. The failure path: a thumb over one of the corner markers ───────────
  const photoInput = page.getByTestId('capture-photo-input');
  await photoInput.setInputFiles(OCCLUDED_PHOTO);

  const hints = page.getByTestId('capture-corner-hints');
  await expect(hints).toBeVisible({ timeout: PIPELINE_BUDGET_MS });

  // All four corners are always reported — that is what makes the hint
  // actionable ("three of four; move your thumb off the bottom-left square").
  await expect(page.getByTestId('capture-corner')).toHaveCount(4);
  const notFound = page.locator('[data-testid=capture-corner][data-found=false]');
  expect(await notFound.count(), 'the occluded fixture must report a missing corner').toBeGreaterThan(0);

  // A named corner, and a sentence telling the human what to do about it.
  const hintItems = page.getByTestId('capture-corner-hint');
  expect(await hintItems.count()).toBeGreaterThan(0);
  await expect(hintItems.first()).toContainText(/corner square/i);
  await expect(page.getByTestId('capture-corner-summary')).toContainText(/corner squares/i);

  // The flow did NOT advance, and the retake control is the same input.
  await expect(page.getByTestId('capture-flow')).toHaveAttribute('data-step', 'photo');
  await expect(page.getByTestId('capture-preview')).toHaveCount(0);

  // ── 3. Retake with a good photo → the real pipeline runs in the browser ───
  const startedProcessing = Date.now();
  await photoInput.setInputFiles(GOOD_PHOTO);

  const preview = page.getByTestId('capture-preview');
  await expect(preview).toBeVisible({ timeout: PIPELINE_BUDGET_MS });
  const wallClockMs = Date.now() - startedProcessing;
  await expect(page.getByTestId('capture-corner-hints')).toHaveCount(0);

  // The pipeline's own timing, reported by the page.
  const pipelineMs = Number(await page.getByTestId('capture-elapsed').innerText());
  expect(Number.isFinite(pipelineMs)).toBe(true);
  console.log(
    `[e2e#4] in-browser processPhoto: ${pipelineMs}ms (${wallClockMs}ms wall clock incl. decode + PNG encode)`,
  );

  // ── 4. The drawing really is on the 3D model, before anything is sent ─────
  const textureHash = (await page.getByTestId('capture-texture-hash').innerText()).trim();
  expect(textureHash, 'the preview must content-address the texture it is showing').toMatch(
    /^[0-9a-f]{64}$/,
  );

  await expect(page.getByTestId('capture-preview-stage')).toBeVisible();
  await page.waitForFunction(
    (hash) => window.__world?.appliedTextures['capture-preview'] === hash,
    textureHash,
    { timeout: PIPELINE_BUDGET_MS },
  );
  const previewWorld = await page.evaluate(() => ({ ...window.__world }));
  expect(previewWorld.dinoCount, 'the preview shows exactly one dino').toBe(1);
  expect(previewWorld.textureErrors).toEqual({});
  expect(previewWorld.frames).toBeGreaterThan(0);

  // A clean fixture must not trip the advisory warnings.
  await expect(page.getByTestId('capture-warning')).toHaveCount(0);

  // ── 5. Confirm → upload → the game view ──────────────────────────────────
  const startedUpload = Date.now();
  const confirm = page.getByTestId('capture-confirm');
  await confirm.click();
  // Double-submit is impossible: the button disables the moment it is pressed
  // and is never re-enabled on the way out.
  await expect(confirm).toBeDisabled();

  await page.waitForURL(/\/play\?/, { timeout: HANDOFF_BUDGET_MS });
  const landed = new URL(page.url());
  expect(landed.searchParams.get('lobby')).toBe(code);
  expect(landed.searchParams.get('name')).toBe(playerName);
  expect(landed.searchParams.get('model')).toBe('raptor');
  // The persisted player id is what stops the room minting a second dino.
  const playerId = landed.searchParams.get('playerId');
  expect(playerId).toMatch(/^[0-9a-f-]{36}$/);

  // ── 6. …and the dino is in the world wearing that exact texture ──────────
  const status = page.getByTestId('lobby-status');
  await expect(status).toHaveAttribute('data-status', 'connected');

  await page.waitForFunction(
    (args) => window.__world?.appliedTextures[args.id] === args.hash,
    { id: playerId as string, hash: textureHash },
    { timeout: HANDOFF_BUDGET_MS },
  );
  const handoffMs = Date.now() - startedUpload;
  console.log(`[e2e#4] confirm → dino on the game view: ${handoffMs}ms`);

  const world = await page.evaluate(() => ({ ...window.__world }));
  expect(world.dinoCount, 'one person, one dino').toBe(1);
  expect(world.appliedTextures?.[playerId as string]).toBe(textureHash);
  expect(world.textureErrors).toEqual({});
  expect(world.pendingTextures).toBe(0);

  await expect(page.getByTestId('nameplate')).toHaveText(playerName);
  await expect(status).toHaveAttribute('data-dino-count', '1');

  expect(failures, 'the capture flow ran without console/page errors').toEqual([]);
});
