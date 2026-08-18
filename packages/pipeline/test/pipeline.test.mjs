/**
 * WS-A integration tests — the whole photo→texture pipeline against committed
 * fixtures and goldens.
 *
 * These are the "pipeline goldens (Node, CI)" suite from
 * docs/ARCHITECTURE.md §5.2. They are integration tests, not unit tests: every
 * case in the golden suite runs js-aruco2 detection, the inner-corner rule,
 * the perspective warp and the levels cleanup on a real PNG read off disk.
 *
 *   fixture PNG → decode → detect → extract quad → warp → cleanup → SSIM
 *
 * ── The SSIM threshold, and why it is 0.88 ────────────────────────────────
 * Measured over the ten synthetic fixtures, the pipeline scores 0.908–0.953
 * against its goldens. The remaining ~5% is irreducible: the golden is an
 * ideal deskew of a clean 8 px/mm sheet, while a fixture is a noisy, blurred,
 * unevenly-lit resample of it, so anti-aliasing along every stroke differs.
 * (Even the golden itself only scores 0.965 against a render of the same
 * drawing straight into texture space.)
 *
 * 0.88 sits ~3 points below the worst observed run — enough headroom for
 * floating-point drift across platforms — while still failing every regression
 * that matters. Measured, on `photo-01-flat`:
 *
 *   correct output ................................ 0.953   PASS
 *   levels cleanup accidentally disabled .......... 0.922   pass (see note)
 *   quad shifted 8 px ............................. 0.853   FAIL
 *   texture built from a different photo .......... 0.870   FAIL
 *   quad corner order rotated 90° ................. 0.806   FAIL
 *
 * SSIM is deliberately insensitive to a 1–2 px shift, so it is NOT the
 * geometry check. `MAX_CORNER_ERROR_PX` below is: the fixture generator knows
 * exactly where it put the drawable quad, and the detector is held to within
 * 6 px of it (worst observed: 3.9). Between them, the two assertions cover
 * "the geometry is right" and "the picture looks right" separately, which is
 * why neither threshold has to be heroic.
 *
 * Regenerate fixtures + goldens with:
 *   pnpm --filter @dino/pipeline generate-fixtures
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import {
  MARKERS,
  PipelineErrorSchema,
  TEXTURE,
  TEXTURE_DEST_POINTS,
  TEXTURE_SAFE_AREA,
} from '@dino/shared';
import {
  applyHomography,
  createFilledImage,
  detectDrawableQuad,
  FIXTURE_SPECS,
  generateFixture,
  getPerspectiveTransform,
  GOLDEN_FIXTURES,
  GOLDEN_SSIM_THRESHOLD,
  invertHomography,
  isConvexQuad,
  PipelineError,
  processPhoto,
  renderDrawingTexture,
  renderGoldenTexture,
  sheetQuad,
  ssim,
  warpQuadToTexture,
} from '../dist/index.js';
import { encodePng, fixturePath, goldenPath, readPng } from '../dist/node.js';

/**
 * Lives in `src/synth.ts` so the test, the `--check` CLI report and any future
 * caller all quote the same number. See the header above for the derivation.
 */
const SSIM_THRESHOLD = GOLDEN_SSIM_THRESHOLD;
/** Max distance, in source pixels, between a detected quad corner and truth. */
const MAX_CORNER_ERROR_PX = 6;
/** A golden must resemble a warp-free render of the same drawing this closely. */
const GOLDEN_VS_ANALYTIC_SSIM = 0.95;

const FAILURE_FIXTURE = FIXTURE_SPECS.find((f) => f.occludeMarker !== undefined);

// Decoding + processing 11 photos is a few seconds of work; cache it.
const cache = new Map();
async function fixture(spec) {
  let entry = cache.get(spec.name);
  if (!entry) {
    entry = { photo: await readPng(fixturePath(spec)) };
    cache.set(spec.name, entry);
  }
  return entry;
}

// ── The artifacts themselves ───────────────────────────────────────────────

test('every fixture spec has a committed photo, and every golden fixture a golden', () => {
  for (const spec of FIXTURE_SPECS) {
    assert.ok(existsSync(fixturePath(spec)), `missing fixture ${spec.name}.png — run generate-fixtures`);
  }
  for (const spec of GOLDEN_FIXTURES) {
    assert.ok(existsSync(goldenPath(spec)), `missing golden ${spec.name}.png — run generate-fixtures`);
  }
  assert.equal(GOLDEN_FIXTURES.length, 10, 'the plan calls for ~10 passing fixtures');
  assert.ok(FAILURE_FIXTURE, 'the suite needs at least one failure-path fixture');
});

test('fixtures are reproducible: regenerating from the seed gives identical bytes', async () => {
  const spec = FIXTURE_SPECS[0];
  const regenerated = encodePng(generateFixture(spec).photo, { rgb: true });
  const onDisk = await readPng(fixturePath(spec));
  const reEncoded = encodePng(onDisk, { rgb: true });
  assert.deepEqual(
    Buffer.from(regenerated),
    Buffer.from(reEncoded),
    `${spec.name} is not reproducible — the generator changed without regenerating fixtures`,
  );
});

test('goldens are the canonical texture size, opaque, and mostly paper-white', async () => {
  const golden = await readPng(goldenPath(GOLDEN_FIXTURES[0]));
  assert.equal(golden.width, TEXTURE.width);
  assert.equal(golden.height, TEXTURE.height);
  let opaque = true;
  let white = 0;
  for (let i = 0; i < golden.data.length; i += 4) {
    if (golden.data[i + 3] !== 255) opaque = false;
    if (golden.data[i] === 255 && golden.data[i + 1] === 255 && golden.data[i + 2] === 255) white++;
  }
  assert.ok(opaque, 'a texture must have no holes');
  const whiteFraction = white / (golden.width * golden.height);
  assert.ok(whiteFraction > 0.7, `background should be knocked out to pure white, got ${whiteFraction.toFixed(3)}`);
  assert.ok(whiteFraction < 0.99, 'a golden with almost no ink means the drawing was lost');
});

// ── The headline suite ─────────────────────────────────────────────────────

test('FULL PIPELINE: every fixture photo reproduces its golden', async (t) => {
  const scores = [];
  for (const spec of GOLDEN_FIXTURES) {
    await t.test(`${spec.name} — ${spec.description}`, async () => {
      const { photo } = await fixture(spec);
      const golden = await readPng(goldenPath(spec));

      const result = processPhoto(photo);

      assert.equal(result.texture.width, TEXTURE.width);
      assert.equal(result.texture.height, TEXTURE.height);
      assert.equal(result.detection.markers.length, 4);
      assert.deepEqual(
        result.detection.markers.map((m) => m.id),
        [...MARKERS.order],
        'markers must be reported in the frozen clockwise-from-top-left order',
      );
      assert.ok(isConvexQuad(result.detection.quad), 'the drawable quad must be convex');

      // Geometry: compare against the generator's answer key.
      const { trueQuad } = generateFixture(spec);
      const errors = trueQuad.map((p, i) =>
        Math.hypot(p.x - result.detection.quad[i].x, p.y - result.detection.quad[i].y),
      );
      const worstCorner = Math.max(...errors);
      assert.ok(
        worstCorner <= MAX_CORNER_ERROR_PX,
        `quad corner off by ${worstCorner.toFixed(1)}px (limit ${MAX_CORNER_ERROR_PX}); ` +
          `per-corner ${errors.map((e) => e.toFixed(1)).join(', ')}`,
      );

      // Appearance.
      const score = ssim(result.texture, golden);
      scores.push({ name: spec.name, score });
      assert.ok(
        score >= SSIM_THRESHOLD,
        `SSIM ${score.toFixed(4)} < ${SSIM_THRESHOLD} (passes used: ${result.detection.passesUsed.join(' → ')})`,
      );

      // A texture is always opaque — the 3D material relies on it.
      for (let i = 3; i < result.texture.data.length; i += 4) {
        if (result.texture.data[i] !== 255) {
          assert.fail(`texture pixel ${(i - 3) / 4} is not opaque`);
        }
      }
    });
  }
  console.log(
    '    SSIM: ' + scores.map((s) => `${s.name.replace('photo-', '')}=${s.score.toFixed(3)}`).join(' '),
  );
});

test('goldens are distinguishable: each result matches its OWN golden best', async () => {
  // Guards the degenerate pass where every texture comes out blank-ish and
  // therefore matches every golden. Compares each fixture against the next
  // fixture's golden — different drawing, same everything else.
  for (let i = 0; i < GOLDEN_FIXTURES.length; i++) {
    const spec = GOLDEN_FIXTURES[i];
    const other = GOLDEN_FIXTURES[(i + 1) % GOLDEN_FIXTURES.length];
    const { photo } = await fixture(spec);
    const texture = processPhoto(photo).texture;
    const own = ssim(texture, await readPng(goldenPath(spec)));
    const foreign = ssim(texture, await readPng(goldenPath(other)));
    assert.ok(
      own > foreign + 0.02,
      `${spec.name}: own golden ${own.toFixed(4)} is not clearly better than ${other.name}'s ${foreign.toFixed(4)}`,
    );
  }
});

test('goldens are honest: they match a warp-free render of the same drawing', () => {
  // Breaks the circularity of "golden and result share the warp code": this
  // render never touches the homography, it just draws into the safe area of a
  // blank 1024² texture. If the warp or the safe-area geometry were wrong, the
  // goldens would not resemble it.
  for (const spec of GOLDEN_FIXTURES.slice(0, 3)) {
    const score = ssim(renderGoldenTexture(spec.seed), renderDrawingTexture(spec.seed));
    assert.ok(
      score >= GOLDEN_VS_ANALYTIC_SSIM,
      `${spec.name}: golden vs analytic render SSIM ${score.toFixed(4)} < ${GOLDEN_VS_ANALYTIC_SSIM}`,
    );
  }
});

/** Fraction of the margin outside TEXTURE_SAFE_AREA that has ink in it. */
function marginInkFraction(texture) {
  const { x, y, width, height } = TEXTURE_SAFE_AREA;
  let ink = 0;
  for (let py = 0; py < texture.height; py++) {
    const inRows = py >= y && py < y + height;
    for (let px = 0; px < texture.width; px++) {
      if (inRows && px >= x && px < x + width) continue;
      const i = (py * texture.width + px) * 4;
      const lum = 0.299 * texture.data[i] + 0.587 * texture.data[i + 1] + 0.114 * texture.data[i + 2];
      if (lum < 200) ink++;
    }
  }
  return ink / (TEXTURE.width * TEXTURE.height - width * height);
}

test("the printed guide box is wiped, so dinosaurs don't wear a dashed rectangle", async () => {
  // The template's "DRAW INSIDE THIS BOX" guide sits 10mm inside the drawable
  // quad, which means it is INSIDE the texture — every photo of a real printed
  // sheet has it. `clearTemplateMargin` removes it. This test proves both
  // halves: the guide really is there, and the pipeline really removes it.
  const { photo } = await fixture(GOLDEN_FIXTURES[0]);

  const unfixed = marginInkFraction(processPhoto(photo, { clearMargin: false }).texture);
  assert.ok(
    unfixed > 0.001,
    'the fixture no longer contains the printed guide box, so this test proves nothing',
  );

  const fixed = marginInkFraction(processPhoto(photo).texture);
  assert.equal(fixed, 0, `${(fixed * 100).toFixed(2)}% of the safe-area margin still has ink in it`);
});

// ── The failure path ───────────────────────────────────────────────────────

test('FAILURE PATH: an occluded marker yields a structured per-corner error', async () => {
  const { photo } = await fixture(FAILURE_FIXTURE);

  let thrown;
  try {
    processPhoto(photo);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown instanceof PipelineError, `expected a PipelineError, got ${thrown}`);
  assert.equal(thrown.code, 'markers_incomplete');

  // The payload must satisfy the frozen contract, so the API and the Wave 4
  // capture UI can consume it without adapters.
  const payload = PipelineErrorSchema.parse(thrown.toJSON());
  assert.equal(payload.corners.length, 4);
  assert.deepEqual(
    payload.corners.map((c) => c.corner),
    ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'],
  );

  // The generator covered marker 3 == bottomLeft, and only that one.
  assert.deepEqual(thrown.missingCorners, ['bottomLeft']);
  for (const corner of payload.corners) {
    if (corner.corner === 'bottomLeft') {
      assert.equal(corner.found, false);
      assert.equal(corner.point, null);
      assert.match(corner.hint, /bottom-left/, 'the hint must name the corner the user has to fix');
    } else {
      assert.equal(corner.found, true, `${corner.corner} should still have been found`);
      assert.ok(corner.point && Number.isFinite(corner.point.x), 'a found corner reports where it is');
      assert.equal(corner.hint, '');
    }
  }
  assert.deepEqual(payload.detectedMarkerIds, [0, 1, 2]);
});

test('FAILURE PATH: blank, tiny and malformed inputs all report structurally', () => {
  const cases = [
    ['markers_not_found', createFilledImage(900, 1200, 255)],
    ['image_too_small', createFilledImage(200, 260, 255)],
    ['image_invalid', { width: 400, height: 400, data: new Uint8ClampedArray(16) }],
  ];
  for (const [expected, input] of cases) {
    let thrown;
    try {
      detectDrawableQuad(input);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof PipelineError, `${expected}: expected a PipelineError`);
    assert.equal(thrown.code, expected);
    const payload = PipelineErrorSchema.parse(thrown.toJSON());
    assert.equal(payload.corners.filter((c) => !c.found).length, 4);
    assert.ok(payload.message.length > 10, 'errors carry a human-readable message');
  }
});

// ── The maths underneath ───────────────────────────────────────────────────

test('homography: getPerspectiveTransform maps the source points exactly', () => {
  const src = [
    { x: 10, y: 20 },
    { x: 310, y: 44 },
    { x: 290, y: 400 },
    { x: 4, y: 370 },
  ];
  const dst = TEXTURE_DEST_POINTS.map(([x, y]) => ({ x, y }));
  const h = getPerspectiveTransform(src, dst);
  for (let i = 0; i < 4; i++) {
    const got = applyHomography(h, src[i].x, src[i].y);
    assert.ok(Math.hypot(got.x - dst[i].x, got.y - dst[i].y) < 1e-6, `corner ${i}: ${JSON.stringify(got)}`);
  }
  // And the inverse takes them back.
  const inv = invertHomography(h);
  for (let i = 0; i < 4; i++) {
    const back = applyHomography(inv, dst[i].x, dst[i].y);
    assert.ok(Math.hypot(back.x - src[i].x, back.y - src[i].y) < 1e-6, `inverse corner ${i}`);
  }
  // A degenerate correspondence is rejected rather than silently producing NaN.
  assert.throws(() =>
    getPerspectiveTransform(
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ],
      dst,
    ),
  );
});

test('warp: deskewing the flat template puts the guide box exactly on the safe area', () => {
  // A pure-geometry check with no photo and no detection: warp the drawable
  // quad of the undistorted sheet and confirm the printed guide box lands on
  // TEXTURE_SAFE_AREA. This is the contract WS-C's UV unwrap depends on.
  const pxPerMm = 8;
  const quad = sheetQuad(pxPerMm);
  const h = getPerspectiveTransform(
    quad,
    TEXTURE_DEST_POINTS.map(([x, y]) => ({ x, y })),
  );
  const guideMm = 10; // TEMPLATE_MM.safeAreaInset
  const topLeftGuide = { x: quad[0].x + guideMm * pxPerMm, y: quad[0].y + guideMm * pxPerMm };
  const mapped = applyHomography(h, topLeftGuide.x, topLeftGuide.y);
  assert.ok(
    Math.abs(mapped.x - TEXTURE_SAFE_AREA.x) < 1 && Math.abs(mapped.y - TEXTURE_SAFE_AREA.y) < 1,
    `guide box corner mapped to ${mapped.x.toFixed(2)},${mapped.y.toFixed(2)}, expected ${TEXTURE_SAFE_AREA.x},${TEXTURE_SAFE_AREA.y}`,
  );
});

test('warp: supersampling changes the result but not the geometry', async () => {
  const spec = GOLDEN_FIXTURES[0];
  const { photo } = await fixture(spec);
  const quad = detectDrawableQuad(photo).quad;
  const opts = { width: TEXTURE.width, height: TEXTURE.height };
  const one = warpQuadToTexture(photo, quad, TEXTURE_DEST_POINTS, { ...opts, supersample: 1 });
  const four = warpQuadToTexture(photo, quad, TEXTURE_DEST_POINTS, { ...opts, supersample: 4 });
  const score = ssim(one, four);
  assert.ok(score > 0.9, `supersampling should refine, not relocate: SSIM ${score.toFixed(4)}`);
  assert.ok(score < 0.9999, 'supersampling should actually do something');
});

// ── The PNG codec ──────────────────────────────────────────────────────────

test('png: encode/decode round-trips both RGB and RGBA exactly', async () => {
  const img = createFilledImage(97, 61, 0);
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = (i * 7) & 0xff;
    img.data[i + 1] = (i * 13) & 0xff;
    img.data[i + 2] = (i * 29) & 0xff;
    img.data[i + 3] = 255;
  }
  const { decodePng } = await import('../dist/png.js');
  for (const rgb of [true, false]) {
    const back = decodePng(encodePng(img, { rgb }));
    assert.equal(back.width, img.width);
    assert.equal(back.height, img.height);
    assert.deepEqual(Buffer.from(back.data), Buffer.from(img.data), `rgb=${rgb}`);
  }
});

test('ssim: identical images score 1, and an inverted one scores far below', () => {
  const a = createFilledImage(64, 64, 255);
  for (let i = 0; i < a.data.length; i += 4) {
    const v = ((i / 4) % 64) * 4;
    a.data[i] = v;
    a.data[i + 1] = v;
    a.data[i + 2] = v;
  }
  assert.ok(ssim(a, a) > 0.9999);
  const b = createFilledImage(64, 64, 0);
  for (let i = 0; i < b.data.length; i += 4) {
    b.data[i] = 255 - a.data[i];
    b.data[i + 1] = 255 - a.data[i + 1];
    b.data[i + 2] = 255 - a.data[i + 2];
  }
  assert.ok(ssim(a, b) < 0.5, 'an inverted image must not look similar');
});
