/**
 * Contract test for the Wave 2B additive dino model spec. The one thing that
 * MUST hold: every UV the unwrap can produce lands inside the texture's safe
 * area, because that is the only part of the sheet people are allowed to draw
 * in. If this fails, drawings will be clipped or blank on the animal.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DINO_MODEL_SPEC,
  DINO_PARTS,
  DINO_UV_RECT,
  MODEL_SLUGS,
  TEXTURE,
  TEXTURE_SAFE_AREA,
  dinoSideBounds,
  dinoTextureOutline,
  partSideQuad,
  sideProjectionUv,
} from '../dist/index.js';

test('dino spec: every slug in the frozen list has geometry', () => {
  for (const slug of MODEL_SLUGS) {
    const parts = DINO_PARTS[slug];
    assert.ok(Array.isArray(parts) && parts.length >= 8, `${slug} has too few parts`);
  }
  assert.deepEqual(DINO_MODEL_SPEC.slugs, MODEL_SLUGS);
  assert.equal(DINO_MODEL_SPEC.projection, 'planar-side-mirrored');
});

test('dino spec: the UV rect IS the texture safe area, not the full sheet', () => {
  assert.equal(DINO_UV_RECT.u0, TEXTURE_SAFE_AREA.x / TEXTURE.width);
  assert.equal(DINO_UV_RECT.u1, (TEXTURE_SAFE_AREA.x + TEXTURE_SAFE_AREA.width) / TEXTURE.width);
  assert.equal(DINO_UV_RECT.u0, 0.0625);
  assert.equal(DINO_UV_RECT.u1, 0.9375);
  assert.equal(DINO_UV_RECT.v0, 0.0625);
  assert.equal(DINO_UV_RECT.v1, 0.9375);
});

test('dino spec: every part vertex unwraps inside the safe area, and the animal fills it', () => {
  for (const slug of MODEL_SLUGS) {
    const bounds = dinoSideBounds(slug);
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;

    for (const part of DINO_PARTS[slug]) {
      for (const [x, y] of partSideQuad(part)) {
        const [u, v] = sideProjectionUv(x, y, bounds);
        assert.ok(u >= DINO_UV_RECT.u0 - 1e-9 && u <= DINO_UV_RECT.u1 + 1e-9, `${slug} u=${u}`);
        assert.ok(v >= DINO_UV_RECT.v0 - 1e-9 && v <= DINO_UV_RECT.v1 + 1e-9, `${slug} v=${v}`);
        minU = Math.min(minU, u);
        maxU = Math.max(maxU, u);
        minV = Math.min(minV, v);
        maxV = Math.max(maxV, v);
      }
    }

    // The bbox is stretched to fill the safe area exactly — no wasted drawing.
    assert.ok(Math.abs(minU - DINO_UV_RECT.u0) < 1e-9, `${slug} does not reach the left edge`);
    assert.ok(Math.abs(maxU - DINO_UV_RECT.u1) < 1e-9, `${slug} does not reach the right edge`);
    assert.ok(Math.abs(minV - DINO_UV_RECT.v0) < 1e-9, `${slug} does not reach the bottom edge`);
    assert.ok(Math.abs(maxV - DINO_UV_RECT.v1) < 1e-9, `${slug} does not reach the top edge`);
  }
});

test('dino spec: the snout is at +X / the right of the sheet, the feet at the bottom', () => {
  for (const slug of MODEL_SLUGS) {
    const bounds = dinoSideBounds(slug);
    // Feet sit on the ground plane.
    assert.ok(Math.abs(bounds.minY) < 1e-9, `${slug} does not stand on Y=0`);
    // The head box is the front-most thing on the animal.
    const head = DINO_PARTS[slug].find((part) => part.name === 'head');
    assert.ok(head, `${slug} has no head`);
    const headMaxX = Math.max(...partSideQuad(head).map(([x]) => x));
    assert.ok(Math.abs(headMaxX - bounds.maxX) < 1e-9, `${slug}: the snout is not at max X`);

    const [uHead] = sideProjectionUv(bounds.maxX, bounds.maxY, bounds);
    assert.equal(uHead, DINO_UV_RECT.u1);
  }
});

test('dino spec: the printable outline stays inside the safe area, in image pixels', () => {
  for (const slug of MODEL_SLUGS) {
    const outline = dinoTextureOutline(slug);
    assert.equal(outline.length, DINO_PARTS[slug].length);
    for (const polygon of outline) {
      assert.equal(polygon.length, 4);
      for (const [px, py] of polygon) {
        assert.ok(px >= TEXTURE_SAFE_AREA.x - 1e-6, `${slug} outline left of the safe area`);
        assert.ok(
          px <= TEXTURE_SAFE_AREA.x + TEXTURE_SAFE_AREA.width + 1e-6,
          `${slug} outline right of the safe area`,
        );
        assert.ok(py >= TEXTURE_SAFE_AREA.y - 1e-6, `${slug} outline above the safe area`);
        assert.ok(
          py <= TEXTURE_SAFE_AREA.y + TEXTURE_SAFE_AREA.height + 1e-6,
          `${slug} outline below the safe area`,
        );
      }
    }
  }
});
