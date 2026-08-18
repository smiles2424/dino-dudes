import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { MARKERS, TEMPLATE_MM, TEXTURE_SPEC } from '@dino/shared';
import {
  computeLayout,
  markerGrid,
  rasterizeTemplate,
  renderTemplatePdf,
  renderTemplateSvg,
} from '../dist/index.js';

const require = createRequire(import.meta.url);

test('layout: each marker inner corner sits exactly on a drawable-quad corner', () => {
  const l = computeLayout();
  const { x, y, size } = l.quad;
  const corners = {
    topLeft: [x, y],
    topRight: [x + size, y],
    bottomRight: [x + size, y + size],
    bottomLeft: [x, y + size],
  };
  assert.equal(l.markers.length, 4);
  for (const m of l.markers) {
    // The inner corner is the marker corner nearest the quad centre.
    const cx = m.corner.includes('Right') ? m.x : m.x + m.size;
    const cy = m.corner.startsWith('bottom') ? m.y : m.y + m.size;
    assert.deepEqual([cx, cy], corners[m.corner], `marker ${m.id} (${m.corner})`);
  }
  assert.deepEqual(
    l.markers.map((m) => m.id),
    MARKERS.order,
  );
});

test('layout: quad is square and the guide box is inset on all sides', () => {
  const l = computeLayout();
  assert.equal(l.quad.size, TEMPLATE_MM.drawableQuad);
  assert.equal(l.guide.x - l.quad.x, TEMPLATE_MM.safeAreaInset);
  assert.equal(l.quad.x + l.quad.size - (l.guide.x + l.guide.size), TEMPLATE_MM.safeAreaInset);
  assert.equal(l.cellSize, TEMPLATE_MM.markerSize / MARKERS.cellsWithBorder);
});

test('marker bits: 4x4 data cells wrapped in a solid black border', () => {
  const grid = markerGrid(0);
  assert.equal(grid.length, MARKERS.cellsWithBorder);
  for (const row of grid) assert.equal(row.length, MARKERS.cellsWithBorder);
  const last = MARKERS.cellsWithBorder - 1;
  for (let i = 0; i < MARKERS.cellsWithBorder; i++) {
    assert.equal(grid[0][i], false, 'top border must be black');
    assert.equal(grid[last][i], false, 'bottom border must be black');
    assert.equal(grid[i][0], false, 'left border must be black');
    assert.equal(grid[i][last], false, 'right border must be black');
  }
});

test('marker bits: ids 0-3 are distinct patterns', () => {
  const seen = new Set();
  for (const id of MARKERS.order) {
    seen.add(JSON.stringify(markerGrid(id)));
  }
  assert.equal(seen.size, 4);
});

test('js-aruco2 detects exactly markers 0-3 in a raster of the generated template', () => {
  const { AR } = require('js-aruco2/src/aruco.js');
  require('js-aruco2/src/dictionaries/aruco_4x4_1000.js');

  const img = rasterizeTemplate(8); // 8 px/mm ~= 203 DPI
  const detector = new AR.Detector({
    dictionaryName: MARKERS.jsAruco2Dictionary,
    maxHammingDistance: 0,
  });
  const markers = detector.detectImage(img.width, img.height, img.data);
  const ids = markers.map((m) => m.id).sort((a, b) => a - b);

  assert.deepEqual(ids, [...MARKERS.order], `detected ${JSON.stringify(ids)}`);
});

test('detected inner corners reconstruct the drawable quad to sub-millimetre accuracy', () => {
  const { AR } = require('js-aruco2/src/aruco.js');
  require('js-aruco2/src/dictionaries/aruco_4x4_1000.js');

  const pxPerMm = 8;
  const img = rasterizeTemplate(pxPerMm);
  const detector = new AR.Detector({
    dictionaryName: MARKERS.jsAruco2Dictionary,
    maxHammingDistance: 0,
  });
  const markers = detector.detectImage(img.width, img.height, img.data);

  // The spec's rule: inner corner == marker corner nearest the centroid of all
  // marker centres. Wave 2A implements this against real photos.
  const centres = markers.map((m) => ({
    x: m.corners.reduce((s, c) => s + c.x, 0) / m.corners.length,
    y: m.corners.reduce((s, c) => s + c.y, 0) / m.corners.length,
  }));
  const centroid = {
    x: centres.reduce((s, c) => s + c.x, 0) / centres.length,
    y: centres.reduce((s, c) => s + c.y, 0) / centres.length,
  };
  const inner = new Map();
  for (const m of markers) {
    const best = m.corners.reduce((a, b) =>
      Math.hypot(a.x - centroid.x, a.y - centroid.y) <= Math.hypot(b.x - centroid.x, b.y - centroid.y)
        ? a
        : b,
    );
    inner.set(m.id, best);
  }

  const l = computeLayout();
  const expected = {
    0: [l.quad.x, l.quad.y],
    1: [l.quad.x + l.quad.size, l.quad.y],
    2: [l.quad.x + l.quad.size, l.quad.y + l.quad.size],
    3: [l.quad.x, l.quad.y + l.quad.size],
  };
  for (const id of MARKERS.order) {
    const got = inner.get(id);
    assert.ok(got, `no inner corner for marker ${id}`);
    const dx = got.x / pxPerMm - expected[id][0];
    const dy = got.y / pxPerMm - expected[id][1];
    const err = Math.hypot(dx, dy);
    assert.ok(err < 1, `marker ${id} inner corner off by ${err.toFixed(2)}mm`);
  }
});

test('SVG output is well-formed-ish, A4-sized and contains all four marker groups', () => {
  const svg = renderTemplateSvg({ modelSlug: 'trex' });
  assert.ok(svg.startsWith('<svg '), 'starts with <svg>');
  assert.ok(svg.trimEnd().endsWith('</svg>'));
  assert.match(svg, /width="210mm"/);
  assert.match(svg, /height="297mm"/);
  for (const id of MARKERS.order) {
    assert.match(svg, new RegExp(`id="aruco-${id}-`), `missing marker ${id}`);
  }
  assert.match(svg, /DINO DUDES - TREX/);
  assert.match(svg, new RegExp(`spec v${TEXTURE_SPEC.version}`));
});

test('PDF output is a single-page A4 document with a valid trailer', () => {
  const bytes = renderTemplatePdf({ modelSlug: 'stego' });
  const text = Buffer.from(bytes).toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'), 'PDF header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'PDF trailer');
  assert.match(text, /\/Type \/Page /);
  assert.match(text, /\/Count 1/);
  // A4 portrait in points, 595.276 x 841.890.
  assert.match(text, /MediaBox \[0 0 595\.276 841\.890\]/);
  // xref offset must actually point at the xref table.
  const startxref = Number(/startxref\s+(\d+)/.exec(text)?.[1]);
  assert.ok(Number.isFinite(startxref));
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
});
