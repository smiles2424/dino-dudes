/**
 * The flagship: the whole product end to end with nothing stubbed. A
 * Pixel-sized context walks the real capture flow and its dinosaur must appear
 * on a spectating desktop context within {@link FANOUT_BUDGET_MS} of the upload
 * being accepted.
 *
 * What only this spec proves is that two independent clients render *one*
 * world: while it moves (shared seed, epoch and clock, so they agree on a
 * future trajectory and on the live pose of a walking dino) and in pixels.
 * There is no committed baseline, unlike E2E #2 — spawn points are
 * server-assigned and differ every run, so the canvas comparison is between two
 * frames that must agree rather than against a golden PNG.
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  devices,
  expect,
  test,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import {
  CreateAvatarResponseSchema,
  CreateLobbyResponseSchema,
  HealthSchema,
} from '@dino/shared';
import { SERVER_BASE_URL } from '../playwright.config.js';
import { makePng } from '../support/fixture-png.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/**
 * A good photo taken at a tilt — what a nine-year-old's arm actually produces.
 *
 * Deliberately NOT E2E #4's fixture: a fixture always yields the same texture
 * bytes, `avatars.texture_hash` is UNIQUE and the upload upserts on it, so the
 * last uploader of a given set of pixels owns the row. These two specs run in
 * parallel, and the loser's lobby then hydrates with no drawing at all.
 */
const GOOD_PHOTO = path.join(repoRoot, 'assets', 'fixtures', 'photo-02-tilted.png');

/**
 * Tags every row this run creates for `scripts/cleanup-e2e-rows.mjs`. The full
 * uuid seeds A's texture, so its content address is unique per run.
 */
const RUN_UUID = randomUUID();
const RUN_ID = RUN_UUID.slice(0, 8);
const NAME_A = `e2e-${RUN_ID}-a`;
const NAME_B = `e2e-${RUN_ID}-b`;
const MODEL_A = 'raptor';
const MODEL_B = 'stego';

/** The promise: once the upload is accepted, it is on the projector. */
const FANOUT_BUDGET_MS = 5000;
/** Decode + downscale + the whole in-browser pipeline (E2E #4 measures ~1.4 s). */
const PIPELINE_BUDGET_MS = 20_000;
/** A page joining a room, loading three.js and rendering its first frames. */
const JOIN_BUDGET_MS = 30_000;

/**
 * Positions cross the wire as float32 and are decoded independently by the two
 * clients, so this is about representation, not physics — millimetres in a
 * world measured in metres.
 */
const POSITION_TOLERANCE = 1e-4;

/**
 * How far apart the two clients' estimates of the *server's* clock may be.
 * Both browsers are on this machine, so this is pure estimation error: a page
 * that processes a patch late reads an offset that is too small until a later
 * tick corrects it. 400 ms moves a wandering dino by ≈19 cm.
 */
const MAX_CLOCK_SKEW_MS = 400;
/**
 * How far apart the two clients may render the same *moving* dino, sampled at
 * one wall-clock moment. A fixed distance rather than one derived from the
 * observed skew, which would excuse any amount of drift: with page-local timing
 * two browsers loaded seconds apart sit at different phases of one orbit, and
 * this is metres.
 */
const LIVE_POSITION_TOLERANCE = 0.35;

/** Downsampled canvas signature: 64×40 luminance cells of the 800×500 frame. */
const SIGNATURE = { width: 64, height: 40 };
/** A cell counts as changed when it moves by more than this (0–255). */
const CELL_CHANGE_THRESHOLD = 8;
/**
 * A real frame (sky gradient, checkered ground, trees, dinos) has hundreds of
 * distinct luminance levels among its 2560 cells; a blank or failed render has
 * a handful. Catches a dead canvas without being fussy.
 */
const MIN_DISTINCT_LEVELS = 40;
/**
 * Two clients rendering one state should agree exactly — same rasteriser, same
 * fixed canvas, same frozen clock. The slack absorbs texture-upload timing
 * inside the GPU driver; a genuinely missing dino is ≈100 cells.
 */
const MAX_CROSS_CLIENT_CELLS = 10;

// SwiftShader for every context in this file: three WebGL pages run headless.
test.use({
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

/** Collect console/page errors so a broken page fails loudly, not silently. */
function watchForErrors(page: Page, label: string, sink: string[]): void {
  page.on('pageerror', (error) => sink.push(`${label}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') sink.push(`${label}: ${message.text()}`);
  });
}

/**
 * Average luminance over a grid of cells, read straight out of the rendered
 * WebGL buffer (so DOM overlays — banner, QR, nameplates — cannot influence it).
 */
async function canvasSignature(page: Page): Promise<number[]> {
  return page.evaluate((size) => {
    const canvas = document.querySelector('canvas');
    if (!canvas) throw new Error('no canvas on the page');
    const off = document.createElement('canvas');
    off.width = size.width;
    off.height = size.height;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(canvas, 0, 0, size.width, size.height);
    const { data } = ctx.getImageData(0, 0, size.width, size.height);
    const cells: number[] = [];
    for (let i = 0; i < data.length; i += 4) {
      cells.push(
        Math.round(0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)),
      );
    }
    return cells;
  }, SIGNATURE);
}

function compareSignatures(
  before: readonly number[],
  after: readonly number[],
): { changed: number; mean: number } {
  expect(after.length).toBe(before.length);
  let changed = 0;
  let total = 0;
  for (let i = 0; i < before.length; i += 1) {
    const delta = Math.abs((after[i] ?? 0) - (before[i] ?? 0));
    total += delta;
    if (delta > CELL_CHANGE_THRESHOLD) changed += 1;
  }
  return { changed, mean: total / before.length };
}

/** The renderer is up, has state, and has drawn — the precondition for reading it. */
async function waitForWorld(page: Page, dinoCount: number): Promise<void> {
  await expect(page.getByTestId('lobby-status')).toHaveAttribute('data-status', 'connected', {
    timeout: JOIN_BUDGET_MS,
  });
  await page.waitForFunction(
    (expected) => window.__world?.dinoCount === expected && (window.__world?.frames ?? 0) > 0,
    dinoCount,
    { timeout: JOIN_BUDGET_MS },
  );
}

test('two browsers, one lobby: a phone drawing lands on the projector', async ({
  browser,
  request,
}, testInfo) => {
  test.skip(!(await postgresConfigured(request)), 'no DATABASE_URL — skipping the flagship E2E');
  // Three WebGL pages, a real photo pipeline and two real page loads.
  test.setTimeout(180_000);

  const failures: string[] = [];
  let projector: BrowserContext | null = null;
  let phone: BrowserContext | null = null;

  try {
    const created = await request.post(`${SERVER_BASE_URL}/api/lobbies`, {
      data: { name: `e2e ${RUN_ID}` },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { lobby, joinUrl } = CreateLobbyResponseSchema.parse(await created.json());

    // Run-seeded bytes, deliberately NOT the fixture photo's output: identical
    // bytes would upsert onto one avatars row and B would steal A's drawing.
    const pngA = makePng(1024, RUN_UUID);
    const hashA = createHash('sha256').update(pngA).digest('hex');
    const uploadedA = await request.post(`${SERVER_BASE_URL}/api/avatars`, {
      multipart: {
        lobbyCode: lobby.code,
        playerName: NAME_A,
        modelSlug: MODEL_A,
        texture: { name: 'texture.png', mimeType: 'image/png', buffer: pngA },
      },
    });
    expect(uploadedA.status(), await uploadedA.text()).toBe(201);
    const avatarA = CreateAvatarResponseSchema.parse(await uploadedA.json());
    expect(avatarA.avatar.textureHash).toBe(hashA);
    const playerIdA = avatarA.player.id;

    projector = await browser.newContext({ viewport: { width: 1000, height: 800 }, deviceScaleFactor: 1 });
    const projectorPage = await projector.newPage();
    watchForErrors(projectorPage, 'projector', failures);
    /*
     * How long the projector spends *downloading* a drawing, as distinct from
     * the socket round trip — together they are the 5 s promise. This was once
     * nearly all of it (a ~1 MB PNG over the public internet) until the server
     * began memoising texture bytes in process; it should now be milliseconds.
     */
    const textureFetches: number[] = [];
    projectorPage.on('requestfinished', (req) => {
      if (!req.url().includes('/api/textures/')) return;
      const timing = req.timing();
      if (timing.responseEnd > 0) textureFetches.push(timing.responseEnd - timing.requestStart);
    });
    await projectorPage.goto(`/play?lobby=${lobby.code}`);
    await waitForWorld(projectorPage, 1);

    const encoded = await projectorPage.getByTestId('lobby-qr').getAttribute('data-qr-value');
    expect(encoded).toContain(`lobby=${lobby.code}`);
    expect(new URL(joinUrl).searchParams.get('lobby')).toBe(lobby.code);

    phone = await browser.newContext({
      ...devices['Pixel 5'],
      // DPR 1: SwiftShader renders every pixel on the CPU, and a 2.6× buffer
      // buys this test nothing. The flow's layout is what is being exercised.
      deviceScaleFactor: 1,
    });
    const phonePage = await phone.newPage();
    watchForErrors(phonePage, 'phone', failures);

    await phonePage.goto(`/?lobby=${lobby.code}`);
    await expect(phonePage.getByTestId('capture-code')).toHaveValue(lobby.code);

    await phonePage.getByTestId('capture-name').fill(NAME_B);
    await phonePage.getByTestId('capture-details-submit').click();

    await expect(phonePage.getByTestId('capture-model')).toBeVisible();
    await phonePage.getByTestId(`capture-model-${MODEL_B}`).click();
    await phonePage.getByTestId('capture-model-submit').click();

    await expect(phonePage.getByTestId('capture-photo')).toBeVisible();
    const startedPipeline = Date.now();
    await phonePage.getByTestId('capture-photo-input').setInputFiles(GOOD_PHOTO);

    await expect(phonePage.getByTestId('capture-preview')).toBeVisible({
      timeout: PIPELINE_BUDGET_MS,
    });
    const pipelineWallMs = Date.now() - startedPipeline;
    const pipelineMs = Number(await phonePage.getByTestId('capture-elapsed').innerText());

    const hashB = (await phonePage.getByTestId('capture-texture-hash').innerText()).trim();
    expect(hashB).toMatch(/^[0-9a-f]{64}$/);
    expect(hashB).not.toBe(hashA);
    // The preview is the real renderer: the drawing is on the model already.
    await phonePage.waitForFunction(
      (hash) => window.__world?.appliedTextures['capture-preview'] === hash,
      hashB,
      { timeout: PIPELINE_BUDGET_MS },
    );

    const uploadResponse = phonePage.waitForResponse(
      (response) =>
        response.url().includes('/api/avatars') && response.request().method() === 'POST',
      { timeout: PIPELINE_BUDGET_MS },
    );
    await phonePage.getByTestId('capture-confirm').click();
    const response = await uploadResponse;
    // The budget starts here — the server has the drawing and has published it.
    // Deliberately no body read: the page navigates to `/play` the instant this
    // promise settles, and fetching a discarded response would both risk a race
    // and charge the round trip to a budget that exists to measure fan-out.
    const fanoutStarted = Date.now();
    expect(response.status()).toBe(201);

    await projectorPage.waitForFunction(
      (hash) => Object.values(window.__world?.appliedTextures ?? {}).includes(hash),
      hashB,
      { timeout: FANOUT_BUDGET_MS },
    );
    const fanoutMs = Date.now() - fanoutStarted;
    console.log(
      `[e2e#5] in-browser processPhoto: ${pipelineMs}ms (${pipelineWallMs}ms wall clock) · ` +
        `upload accepted → dino on the projector: ${fanoutMs}ms ` +
        `(of which GET /api/textures: ${textureFetches.map((ms) => Math.round(ms)).join(', ') || 'n/a'}ms)`,
    );
    expect(fanoutMs, `upload → projector took ${fanoutMs}ms`).toBeLessThan(FANOUT_BUDGET_MS);

    await phonePage.waitForURL(/\/play\?/, { timeout: JOIN_BUDGET_MS });
    const landed = new URL(phonePage.url());
    expect(landed.searchParams.get('lobby')).toBe(lobby.code);
    expect(landed.searchParams.get('name')).toBe(NAME_B);
    expect(landed.searchParams.get('model')).toBe(MODEL_B);
    // The persisted id is what stops the room minting a second dino for B.
    const playerIdB = landed.searchParams.get('playerId') ?? '';
    expect(playerIdB).toMatch(/^[0-9a-f-]{36}$/);
    expect(playerIdB).not.toBe(playerIdA);

    await projectorPage.waitForFunction(
      (args) => window.__world?.appliedTextures[args.id] === args.hash,
      { id: playerIdB, hash: hashB },
      { timeout: JOIN_BUDGET_MS },
    );
    const world = await projectorPage.evaluate(() => ({ ...window.__world }));
    expect(world.version).toBe(3);
    expect(world.dinoCount, 'two players, two dinos').toBe(2);
    expect(world.appliedTextures?.[playerIdA]).toBe(hashA);
    expect(world.appliedTextures?.[playerIdB]).toBe(hashB);
    expect(world.textureErrors).toEqual({});
    expect(world.pendingTextures).toBe(0);
    expect(world.frozen).toBe(false);
    // Two species, so geometry was built twice and never per dino.
    expect(world.geometryBuilds).toBe(2);

    await expect(projectorPage.getByTestId('nameplate')).toHaveCount(2);
    await expect(projectorPage.getByTestId('nameplate').filter({ hasText: NAME_A })).toBeVisible();
    await expect(projectorPage.getByTestId('nameplate').filter({ hasText: NAME_B })).toBeVisible();
    await expect(projectorPage.getByTestId('lobby-status')).toHaveAttribute('data-dino-count', '2');

    await waitForWorld(phonePage, 2);
    await phonePage.waitForFunction(
      (args) =>
        window.__world?.appliedTextures[args.a] === args.hashA &&
        window.__world?.appliedTextures[args.b] === args.hashB,
      { a: playerIdA, b: playerIdB, hashA, hashB },
      { timeout: JOIN_BUDGET_MS },
    );

    const phoneWorld = await phonePage.evaluate(() => ({ ...window.__world }));
    expect(Object.keys(phoneWorld.players ?? {}).sort()).toEqual([playerIdA, playerIdB].sort());

    let worstDelta = 0;
    for (const id of [playerIdA, playerIdB]) {
      const here = world.players?.[id];
      const there = phoneWorld.players?.[id];
      expect(here, `the projector must know about ${id}`).toBeTruthy();
      expect(there, `the phone must know about ${id}`).toBeTruthy();
      if (!here || !there) continue;
      expect(there.modelSlug).toBe(here.modelSlug);
      for (const key of ['x', 'y', 'z', 'heading'] as const) {
        const delta = Math.abs(here[key] - there[key]);
        worstDelta = Math.max(worstDelta, delta);
        expect(delta, `${id}.${key}: projector ${here[key]} vs phone ${there[key]}`).toBeLessThanOrEqual(
          POSITION_TOLERANCE,
        );
      }
    }
    console.log(`[e2e#5] two-client position agreement: worst delta ${worstDelta}`);
    expect(world.players?.[playerIdA]?.modelSlug).toBe(MODEL_A);
    expect(world.players?.[playerIdB]?.modelSlug).toBe(MODEL_B);

    /*
     * Two clients, one world — while the dinos are MOVING: the half of world
     * consistency that spawn positions cannot prove. The room issues the seed
     * and epoch and refreshes `serverTime`, so both browsers evaluate the same
     * function of the same clock rather than each drifting from its own load.
     */
    for (const [label, page] of [
      ['projector', projectorPage],
      ['phone', phonePage],
    ] as const) {
      await page.waitForFunction(
        /*
         * Six ticks (~3 s). The estimate is the largest `serverTime -
         * Date.now()` seen, and a page busy compiling shaders processes its
         * first patches late, which reads as an offset that is too *small*.
         * Further samples can only correct it upward, so wait for a few.
         */
        () => window.__world?.motion?.source === 'server' && window.__world.motion.samples >= 6,
        undefined,
        { timeout: JOIN_BUDGET_MS },
      );
      const motion = await page.evaluate(() => window.__world?.motion);
      expect(motion?.seed, `${label} must have the room's motion seed`).toMatch(/^[0-9a-f]{16}$/);
    }

    const [motionA, motionB] = await Promise.all([
      projectorPage.evaluate(() => window.__world?.motion),
      phonePage.evaluate(() => window.__world?.motion),
    ]);
    expect(motionB?.seed, 'both clients wander from ONE seed').toBe(motionA?.seed);
    expect(motionB?.epoch, 'both clients count from ONE epoch').toBe(motionA?.epoch);
    // Both browsers run on this machine, so their estimates of the *server's*
    // clock must land on the same value; the gap is the sync error between the
    // two screens, in milliseconds.
    const clockSkewMs = Math.abs((motionA?.offsetMs ?? 0) - (motionB?.offsetMs ?? 0));
    console.log(
      `[e2e#5] shared motion clock: seed ${motionA?.seed}, offsets ` +
        `${motionA?.offsetMs}ms / ${motionB?.offsetMs}ms → skew ${clockSkewMs}ms`,
    );
    expect(clockSkewMs, 'the two clients must agree on the server clock').toBeLessThan(
      MAX_CLOCK_SKEW_MS,
    );

    /*
     * (a) Pure trajectory agreement: both clients are asked what they would
     * render for B at the same motion time, seconds in the future. No frame
     * timing involved — a local seed or a page-local clock fails this by metres.
     */
    const sampleAt = Math.round(await projectorPage.evaluate(() => window.__world?.motionTime?.() ?? 0)) + 5;
    const sample = { id: playerIdB, t: sampleAt };
    const [futureA, futureB] = await Promise.all([
      projectorPage.evaluate((args) => window.__world?.poseAtTime?.(args.id, args.t), sample),
      phonePage.evaluate((args) => window.__world?.poseAtTime?.(args.id, args.t), sample),
    ]);
    expect(futureA, 'the projector can evaluate B at a future time').toBeTruthy();
    expect(futureB, 'the phone can evaluate B at the same time').toBeTruthy();
    let worstTrajectory = 0;
    for (const key of ['x', 'y', 'z', 'rotationY'] as const) {
      worstTrajectory = Math.max(worstTrajectory, Math.abs((futureA?.[key] ?? 0) - (futureB?.[key] ?? 0)));
    }
    expect(worstTrajectory, `same trajectory at t=${sampleAt}s`).toBeLessThanOrEqual(POSITION_TOLERANCE);

    /*
     * (b) …and they are really moving, really rendered from that shared clock.
     * Each `poses` entry carries the motion time it was evaluated at, so the
     * only slack allowed is the frame skew between the browsers times the
     * fastest a dino can walk.
     */
    const livePose = (page: Page): Promise<{ x: number; y: number; z: number; rotationY: number; t: number } | undefined> =>
      page.evaluate((id) => window.__world?.poses?.[id], playerIdB);

    const firstA = await livePose(projectorPage);
    await projectorPage.waitForTimeout(1500);
    const movedA = await livePose(projectorPage);
    const travelled = Math.hypot(
      (movedA?.x ?? 0) - (firstA?.x ?? 0),
      (movedA?.z ?? 0) - (firstA?.z ?? 0),
    );
    expect(travelled, 'the dinos must actually be wandering').toBeGreaterThan(0.01);

    const [liveA, liveB] = await Promise.all([livePose(projectorPage), livePose(phonePage)]);
    expect(liveA, 'the projector renders a pose for B').toBeTruthy();
    expect(liveB, 'the phone renders a pose for B').toBeTruthy();
    const frameSkewS = Math.abs((liveA?.t ?? 0) - (liveB?.t ?? 0));
    const liveDelta = Math.hypot(
      (liveA?.x ?? 0) - (liveB?.x ?? 0),
      (liveA?.y ?? 0) - (liveB?.y ?? 0),
      (liveA?.z ?? 0) - (liveB?.z ?? 0),
    );
    console.log(
      `[e2e#5] two-client agreement DURING motion: |ΔP| ${liveDelta.toFixed(4)} m ` +
        `(budget ${LIVE_POSITION_TOLERANCE} m) at a sampling skew of ` +
        `${(frameSkewS * 1000).toFixed(0)} ms; the dino travelled ${travelled.toFixed(3)} m in ` +
        `1.5 s; trajectory at t=${sampleAt}s agrees to ${worstTrajectory}`,
    );
    expect(liveDelta, 'the two clients must render the moving dino in one place').toBeLessThanOrEqual(
      LIVE_POSITION_TOLERANCE,
    );

    expect(await projectorPage.evaluate(() => window.__world?.offscreen)).toBe(0);
    expect(await phonePage.evaluate(() => window.__world?.offscreen)).toBe(0);

    /*
     * Two clients, one world — in pixels. Both browsers open the SAME lobby
     * frozen: fixed 800×500 canvas, DPR 1, one rasteriser, so two clients
     * rendering one synchronized state must produce one picture. That holds
     * wherever the server spawned anybody, which is why it is asserted and
     * "B's arrival changed N cells" is not.
     *
     * Opened only now, after the timed fan-out window: two more WebGL pages
     * fetching the same textures would be measuring this test's own load.
     */
    const frozenPages = await Promise.all(
      [
        { context: projector, label: 'projector(static)' },
        { context: phone, label: 'phone(static)' },
      ].map(async ({ context, label }) => {
        const page = await context.newPage();
        watchForErrors(page, label, failures);
        await page.goto(`/play?lobby=${lobby.code}&static=1`);
        await page.waitForFunction(
          (args) =>
            window.__world?.ready === true &&
            window.__world?.frozen === true &&
            window.__world?.appliedTextures[args.a] === args.hashA &&
            window.__world?.appliedTextures[args.b] === args.hashB,
          { a: playerIdA, b: playerIdB, hashA, hashB },
          { timeout: JOIN_BUDGET_MS },
        );
        // Two rAFs, so the frame in the buffer is the finished one.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        return page;
      }),
    );
    const [frozenPage, phoneFrozen] = frozenPages;
    if (!frozenPage || !phoneFrozen) throw new Error('frozen pages did not open');

    const projectorFrame = await canvasSignature(frozenPage);
    await testInfo.attach('projector.png', {
      body: await frozenPage.locator('canvas').first().screenshot(),
      contentType: 'image/png',
    });

    // Control: nothing moves in this mode, so re-sampling must be bit-for-bit
    // identical. Without it, "the two clients agree" would be evidence of
    // nothing — a metric that cannot detect change cannot detect agreement.
    await frozenPage.waitForTimeout(750);
    const control = compareSignatures(projectorFrame, await canvasSignature(frozenPage));
    expect(control, 'a frozen canvas must not change on its own').toEqual({ changed: 0, mean: 0 });

    // Sanity: a real scene, not a flat fill or a stale/blank buffer.
    expect(
      new Set(projectorFrame).size,
      'the projector canvas must contain a real scene',
    ).toBeGreaterThan(MIN_DISTINCT_LEVELS);

    const crossClient = compareSignatures(projectorFrame, await canvasSignature(phoneFrozen));
    console.log(
      `[e2e#5] projector vs phone, same frozen world: ${crossClient.changed} cells differ, mean ${crossClient.mean.toFixed(2)}`,
    );
    await testInfo.attach('phone-same-world.png', {
      body: await phoneFrozen.locator('canvas').first().screenshot(),
      contentType: 'image/png',
    });
    expect(
      crossClient.changed,
      'the two clients must render the same world (see the attached frames)',
    ).toBeLessThanOrEqual(MAX_CROSS_CLIENT_CELLS);

    expect(failures, 'every page ran without console/page errors').toEqual([]);
  } finally {
    await projector?.close();
    await phone?.close();
  }
});
