/**
 * The 3D world, driven through `/debug/world?static=1`: the real world
 * component rendered from a static JSON state and local PNGs, with no backend,
 * Colyseus or pipeline behind it. Covers geometry, the safe-area UV unwrap,
 * texture loading, the runtime texture swap, and the `window.__world` contract
 * every later wave asserts against.
 *
 * One committed screenshot baseline is valid on every OS because nothing here
 * is allowed to vary: `?static=1` freezes motion at t = 0, pins DPR to 1, turns
 * MSAA off and renders a fixed 800×500 canvas; the browser is forced onto
 * SwiftShader so CI and laptops share a rasteriser; the canvas contains no text
 * (nameplates are DOM and are masked out); and no wobble comes from
 * `Math.random()` — it is all derived from the player id.
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
 * The `window.__world` contract, mirrored here so this test is a type-checked
 * consumer of it. The implementation is `apps/web/src/world/world-debug.ts`.
 */
declare global {
  interface Window {
    __world?: WorldDebugSnapshot & {
      setTexture?: (playerId: string, textureHash: string) => void;
      /** `version: 3` — current motion time in seconds on the shared clock. */
      motionTime?: () => number;
      /** `version: 3` — the pose this client would render at time `t`. */
      poseAtTime?: (
        playerId: string,
        t: number,
      ) => { x: number; y: number; z: number; rotationY: number; t: number } | null;
      /** `version: 3` — is this dino fully in frame at motion time `t`? */
      playerOnScreen?: (playerId: string, t: number) => boolean | null;
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
  /** Added in `version: 3` — the ANIMATED transform, rewritten every frame. */
  poses: Record<
    string,
    { x: number; y: number; z: number; rotationY: number; t: number }
  >;
  /** Added in `version: 3` — how this page is timing the wander. */
  motion: {
    source: 'server' | 'local';
    seed: string;
    epoch: number;
    offsetMs: number;
    samples: number;
  };
  /** Added in `version: 3` — the shot after fit-to-bounds framing. */
  camera: {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
    aspect: number;
  };
  /** Added in `version: 3` — dinos outside the viewport. Must be 0. */
  offscreen: number;
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

/*
 * Every test here builds the whole scene on SwiftShader, which costs 8–25 s,
 * and three of them load the world twice — more than the 30 s default in
 * `playwright.config.ts`, which is sized for the DOM specs. Nothing in this
 * file asserts how *fast* the world appears, and the per-step waits below stay
 * tight; only the total gets headroom, as 04 and 05 already do.
 */
test.describe.configure({ timeout: 120_000 });

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

  expect(world.version).toBe(3);
  expect(world.frozen).toBe(true);
  // No server here, so the harness times its own wander.
  expect(world.motion.source).toBe('local');
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

  expect(new Set(Object.values(world.appliedTextures)).size).toBe(drawn.length);

  // Geometry is per species, not per dino, and is built once.
  expect(world.geometryBuilds).toBe(new Set(players.map((p) => p.modelSlug)).size);

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
     * With SwiftShader, a fixed DPR and no in-canvas text, the only expected
     * cross-machine difference is ±1 LSB shading and the odd flipped pixel
     * along a silhouette — and total silhouette is ≈1.5 % of the frame. 5 %
     * leaves ~3× headroom while still failing loudly on anything real: a
     * missing dino, a texture on the wrong animal, a broken unwrap, a lighting
     * or camera change all move far more than that.
     */
    maxDiffPixelRatio: 0.05,
    animations: 'disabled',
  });
  // The baseline was recorded on Windows/SwiftShader. If a future renderer or
  // browser bump makes this drift everywhere at once, re-record it with
  // `pnpm e2e:only -- --update-snapshots` and eyeball the new PNG in the diff.
});

/**
 * Every dino must be on screen — asserted over a full wander period rather than
 * at whatever instant the test caught, since the slowest dino here needs ≈39 s
 * to close its orbit. Sampled through the same projection three.js renders
 * with, so it tests the fit in `world/camera-fit.ts` and not a re-derivation.
 */
test('every dino stays inside the frame, for every moment of its wander', async ({ page }) => {
  await openWorld(page);

  const camera = await page.evaluate(() => window.__world?.camera);
  expect(camera, 'the world reports the shot it framed').toBeTruthy();

  const offFrame = await page.evaluate((ids) => {
    const missed: string[] = [];
    for (const id of ids) {
      // 0.25 s steps over 60 s: more than one full orbit for the slowest dino.
      for (let t = 0; t <= 60; t += 0.25) {
        if (window.__world?.playerOnScreen?.(id, t) !== true) {
          missed.push(`${id}@${t.toFixed(2)}s`);
          break;
        }
      }
    }
    return missed;
  }, players.map((player) => player.id));

  expect(offFrame, 'no dinosaur may ever leave the frame').toEqual([]);
  console.log(
    `[e2e#2] framing: camera ${JSON.stringify(camera?.position)} fov ${camera?.fov} ` +
      `covers all ${players.length} dinos for a full wander period`,
  );

  await page.goto('/debug/world');
  await page.waitForFunction(() => (window.__world?.frames ?? 0) > 5, undefined, {
    timeout: 25_000,
  });
  expect(await page.evaluate(() => window.__world?.offscreen)).toBe(0);
});

/**
 * The venue case without a venue: twelve dinos on the 4–8 m spawn ring
 * `spawnFor` uses, including the four cardinal points at the full 8 m — the
 * geometry that used to put ~17 % of a lobby outside the frame.
 *
 * Both viewports matter. A portrait phone frustum is so narrow horizontally
 * that dollying alone cannot contain a 16 m field, which is why the fit widens
 * the lens once the dolly saturates.
 */
test('every dino stays inside the frame with a full lobby on the spawn ring', async ({ page }) => {
  const crowd = LobbyStateSchema.parse(
    JSON.parse(readFileSync(path.join(debugDir, 'world-crowd.json'), 'utf8')),
  );
  const crowdIds = Object.values(crowd.players).map((player) => player.id);

  for (const viewport of [
    { width: 960, height: 540 }, // a projector
    { width: 380, height: 760 }, // a phone, portrait
  ]) {
    await page.goto(
      `/debug/world?state=/debug/world-crowd.json&size=${viewport.width}x${viewport.height}`,
    );
    await page.waitForFunction(
      (expected) =>
        window.__world?.dinoCount === expected && (window.__world?.frames ?? 0) > 3,
      crowdIds.length,
      { timeout: 25_000 },
    );

    const missed = await page.evaluate((ids) => {
      const off: string[] = [];
      for (const id of ids) {
        for (let t = 0; t <= 60; t += 0.25) {
          if (window.__world?.playerOnScreen?.(id, t) !== true) {
            off.push(`${id}@${t.toFixed(2)}s`);
            break;
          }
        }
      }
      return off;
    }, crowdIds);
    const camera = await page.evaluate(() => window.__world?.camera);
    console.log(
      `[e2e#2] framing ${viewport.width}×${viewport.height} (canvas aspect ` +
        `${camera?.aspect.toFixed(2)}): ${crowdIds.length} dinos on the 4–8 m ring → camera ` +
        `${JSON.stringify(camera?.position)} fov ${camera?.fov}`,
    );

    expect(missed, `nobody may be off frame at ${viewport.width}×${viewport.height}`).toEqual([]);
    expect(await page.evaluate(() => window.__world?.offscreen)).toBe(0);
  }
});

test('the world idles when live and is perfectly frozen under ?static=1', async ({ page }) => {
  // Live: the dinos wander, so their nameplates track across the screen.
  await page.goto('/debug/world');
  await page.waitForFunction(() => window.__world?.ready === true, undefined, { timeout: 25_000 });
  const plate = page.getByTestId('nameplate').first();
  const liveBefore = await plate.boundingBox();
  expect(liveBefore).toBeTruthy();
  /*
   * Polled rather than sampled once after a fixed wait: the wander only
   * advances on rendered frames, and a worker sharing the machine with several
   * other SwiftShader browsers can render almost none in a fixed 1.2 s.
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

  for (const player of drawn) {
    if (player.id === target.id) continue;
    expect(after.appliedTextures[player.id]).toBe(player.textureHash);
  }
});
