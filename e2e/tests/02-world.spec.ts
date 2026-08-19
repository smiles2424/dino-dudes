/**
 * E2E #2 — Wave 2B (WS-C, the 3D world).
 *
 * Drives `/debug/world?static=1`: the harness renders the real world component
 * from a static JSON state + local PNGs — no backend, no Colyseus, no
 * pipeline — so this test covers geometry, the safe-area UV unwrap, texture
 * loading, the runtime texture swap and the `window.__world` contract that
 * every later wave asserts against.
 *
 * Determinism (why a single committed baseline is safe on every OS):
 *   • `?static=1` freezes motion at t = 0, pins DPR to 1, turns MSAA off and
 *     renders into a fixed 800×500 canvas, so nothing depends on the window;
 *   • the browser is forced onto SwiftShader (ANGLE's software rasteriser), so
 *     CI and laptops run the same rasteriser;
 *   • the canvas contains no text at all — nameplates are DOM, and they are
 *     masked out of the screenshot, so OS font rendering cannot move a pixel;
 *   • the scene uses no `Math.random()`: every wobble is derived from the
 *     player id.
 *
 * Nothing here modifies E2E #1.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { LobbyStateSchema } from '@dino/shared';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const debugDir = path.join(repoRoot, 'apps', 'web', 'public', 'debug');

/** The harness renders exactly this file; the test derives its expectations from it. */
const worldState = LobbyStateSchema.parse(
  JSON.parse(readFileSync(path.join(debugDir, 'world.json'), 'utf8')),
);
const manifest = JSON.parse(
  readFileSync(path.join(debugDir, 'textures', 'manifest.json'), 'utf8'),
) as { spareHash: string; textures: { pattern: string; hash: string }[] };

const players = Object.values(worldState.players);
const drawn = players.filter((player) => player.textureHash !== '');
const expectedApplied = Object.fromEntries(drawn.map((p) => [p.id, p.textureHash]));

/**
 * The `window.__world` contract, mirrored here so the test is a real
 * type-checked consumer of it (the implementation lives in
 * `apps/web/src/world/world-debug.ts`).
 */
declare global {
  interface Window {
    __world?: WorldDebugSnapshot & {
      setTexture?: (playerId: string, textureHash: string) => void;
    };
  }
}

interface WorldDebugSnapshot {
  version: number;
  ready: boolean;
  frozen: boolean;
  dinoCount: number;
  /** Added in `version: 2` — synced position/heading, per player id. */
  players: Record<
    string,
    { x: number; y: number; z: number; heading: number; modelSlug: string }
  >;
  appliedTextures: Record<string, string>;
  textureErrors: Record<string, string>;
  pendingTextures: number;
  geometryBuilds: number;
  materialBuilds: number;
  frames: number;
}

test.use({
  viewport: { width: 1000, height: 800 },
  deviceScaleFactor: 1,
  launchOptions: {
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--force-color-profile=srgb',
      '--hide-scrollbars',
      '--disable-lcd-text',
    ],
  },
});

async function openWorld(page: import('@playwright/test').Page): Promise<void> {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  await page.goto('/debug/world?static=1');
  await page.waitForFunction(() => window.__world?.ready === true, undefined, { timeout: 25_000 });
  expect(failures, 'the world rendered without console/page errors').toEqual([]);
}

/** Two rAFs after `ready` so the last texture is definitely on screen. */
async function settleFrames(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test('the world harness renders every dino and applies every texture', async ({ page }) => {
  await openWorld(page);

  const world = (await page.evaluate(() => ({ ...window.__world }))) as WorldDebugSnapshot;

  expect(world.version).toBe(2);
  expect(world.frozen).toBe(true);
  expect(world.dinoCount).toBe(players.length);
  // `players` mirrors the state the renderer was handed, verbatim.
  expect(Object.keys(world.players).sort()).toEqual(players.map((p) => p.id).sort());
  for (const player of players) {
    expect(world.players[player.id]).toEqual({
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      heading: player.heading,
      modelSlug: player.modelSlug,
    });
  }
  expect(world.appliedTextures).toEqual(expectedApplied);
  expect(world.textureErrors).toEqual({});
  expect(world.pendingTextures).toBe(0);
  expect(world.frames).toBeGreaterThan(0);

  // Three distinct drawings really did land on three different dinos.
  expect(new Set(Object.values(world.appliedTextures)).size).toBe(drawn.length);

  // Geometry is per species, not per dino, and is built once.
  expect(world.geometryBuilds).toBe(new Set(players.map((p) => p.modelSlug)).size);

  // Every player has a floating nameplate showing their name.
  await expect(page.getByTestId('nameplate')).toHaveCount(players.length);
  for (const player of players) {
    await expect(page.getByTestId('nameplate').filter({ hasText: player.name })).toBeVisible();
  }

  // The dino without a drawing keeps the placeholder skin rather than erroring.
  const undrawn = players.filter((player) => player.textureHash === '');
  expect(undrawn.length).toBeGreaterThan(0);
  for (const player of undrawn) {
    expect(world.appliedTextures[player.id]).toBeUndefined();
  }
});

test('the frozen world canvas matches the committed baseline', async ({ page }) => {
  await openWorld(page);
  await settleFrames(page);

  const canvas = page.locator('canvas').first();
  await expect(canvas).toHaveScreenshot('world-static.png', {
    // Nameplates are DOM drawn over the canvas; mask them so OS font metrics
    // can never break the comparison.
    mask: [page.getByTestId('nameplate')],
    /*
     * Tolerance rationale: with SwiftShader + fixed DPR + no in-canvas text the
     * only expected cross-machine difference is ±1 LSB shading (absorbed by the
     * default per-pixel `threshold` of 0.2) and the odd flipped pixel along a
     * silhouette. The scene's total silhouette length is ≈6 k px of a 400 k px
     * canvas (≈1.5 %), so 5 % leaves ~3× headroom for CI's rasteriser while
     * still failing loudly on anything real: a missing dino, a texture applied
     * to the wrong animal, a broken unwrap or a lighting/camera change all move
     * far more than 5 % of the frame.
     */
    maxDiffPixelRatio: 0.05,
    animations: 'disabled',
  });
  // The baseline was recorded on Windows/SwiftShader. If a future renderer or
  // browser bump makes this drift everywhere at once, re-record it with
  // `pnpm e2e:only -- --update-snapshots` and eyeball the new PNG in the diff.
});

test('the world idles when live and is perfectly frozen under ?static=1', async ({ page }) => {
  // Live: the dinos wander, so their nameplates track across the screen.
  await page.goto('/debug/world');
  await page.waitForFunction(() => window.__world?.ready === true, undefined, { timeout: 25_000 });
  const plate = page.getByTestId('nameplate').first();
  const liveBefore = await plate.boundingBox();
  expect(liveBefore).toBeTruthy();
  /*
   * Polled rather than sampled once after a fixed wait (Wave 4, Chunk 4.1):
   * the assertion is unchanged — the plate must really travel — but the wander
   * only advances on rendered frames, and a worker sharing the machine with
   * several other SwiftShader browsers can render almost none inside a fixed
   * 1.2 s. This gives the same fact room to be observed.
   */
  await expect
    .poll(async () => Math.abs(((await plate.boundingBox())?.x ?? 0) - (liveBefore?.x ?? 0)), {
      timeout: 15_000,
      message: 'the live world must animate',
    })
    .toBeGreaterThan(1);

  // Static: nothing moves at all — the precondition for a stable baseline.
  await openWorld(page);
  const staticPlate = page.getByTestId('nameplate').first();
  const staticBefore = await staticPlate.boundingBox();
  await page.waitForTimeout(1200);
  const staticAfter = await staticPlate.boundingBox();
  expect(staticAfter).toEqual(staticBefore);
});

test('a drawing can be swapped at runtime without rebuilding the model', async ({ page }) => {
  await openWorld(page);

  const target = drawn[drawn.length - 1];
  if (!target) throw new Error('fixture has no textured player');
  const spareHash = manifest.spareHash;
  expect(spareHash).not.toBe(target.textureHash);

  const before = (await page.evaluate(() => ({ ...window.__world }))) as WorldDebugSnapshot;

  await page.evaluate(
    (args) => window.__world?.setTexture?.(args.playerId, args.hash),
    { playerId: target.id, hash: spareHash },
  );

  await page.waitForFunction(
    (args) =>
      window.__world?.appliedTextures[args.playerId] === args.hash &&
      window.__world?.ready === true,
    { playerId: target.id, hash: spareHash },
    { timeout: 15_000 },
  );

  const after = (await page.evaluate(() => ({ ...window.__world }))) as WorldDebugSnapshot;

  expect(after.appliedTextures[target.id]).toBe(spareHash);
  expect(after.dinoCount).toBe(before.dinoCount);
  // The proof that this was a material swap, not a model reload:
  expect(after.geometryBuilds).toBe(before.geometryBuilds);
  expect(after.materialBuilds).toBe(before.materialBuilds);
  expect(after.textureErrors).toEqual({});

  // The other dinos are untouched.
  for (const player of drawn) {
    if (player.id === target.id) continue;
    expect(after.appliedTextures[player.id]).toBe(player.textureHash);
  }
});
