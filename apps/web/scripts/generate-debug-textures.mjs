/**
 * Generates the `/debug/world` harness fixtures:
 *
 *   apps/web/public/debug/textures/<sha256>.png   3 + 1 canonical 1024² PNGs
 *   apps/web/public/debug/textures/manifest.json  hash ↔ description
 *   apps/web/public/debug/world.json              a static LobbyState
 *
 * These stand in for real deskewed drawings until WS-A's pipeline lands, so
 * the 3D world (and E2E #2) needs no backend and no pipeline. Everything is
 * drawn with plain loops — no canvas, no fonts — so the bytes are identical on
 * every machine and the committed screenshot baseline stays valid.
 *
 * Each texture paints ONLY inside `TEXTURE_SAFE_AREA` (the 64 px inset), which
 * is the only region a printed template lets people draw in, and marks its
 * four safe-area corners in different colours plus a big "→ snout" wedge, so a
 * human can see at a glance which bit of paper landed on which bit of dino.
 *
 *   run: node apps/web/scripts/generate-debug-textures.mjs
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { TEXTURE, TEXTURE_SAFE_AREA } from '../../../packages/shared/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'public', 'debug');
const texDir = join(outDir, 'textures');

const W = TEXTURE.width;
const H = TEXTURE.height;
const SA = TEXTURE_SAFE_AREA;

// ── Tiny raster helpers ────────────────────────────────────────────────────

function createImage(fill) {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return data;
}

function setPixel(data, x, y, color) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  data[i] = color[0];
  data[i + 1] = color[1];
  data[i + 2] = color[2];
  data[i + 3] = 255;
}

function fillRect(data, x0, y0, w, h, color) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) setPixel(data, x, y, color);
  }
}

/** Paints every safe-area pixel through a callback: (x, y) → colour | null. */
function paintSafeArea(data, shade) {
  for (let y = SA.y; y < SA.y + SA.height; y += 1) {
    for (let x = SA.x; x < SA.x + SA.width; x += 1) {
      const color = shade(x - SA.x, y - SA.y);
      if (color) setPixel(data, x, y, color);
    }
  }
}

/** Orientation key: corner blocks + a wedge pointing at the snout. */
function paintOrientationMarks(data) {
  const s = 84;
  fillRect(data, SA.x, SA.y, s, s, [214, 44, 44]); // top-left  → tail-top
  fillRect(data, SA.x + SA.width - s, SA.y, s, s, [40, 168, 72]); // top-right → head-top
  fillRect(data, SA.x + SA.width - s, SA.y + SA.height - s, s, s, [48, 86, 214]); // BR → front foot
  fillRect(data, SA.x, SA.y + SA.height - s, s, s, [240, 196, 32]); // BL → tail-bottom

  // Wedge pointing right: right of the sheet == the animal's snout.
  const cy = SA.y + Math.round(SA.height / 2);
  const tipX = SA.x + SA.width - 40;
  const backX = tipX - 260;
  for (let x = backX; x <= tipX; x += 1) {
    const t = (x - backX) / (tipX - backX);
    const halfHeight = Math.round(110 * (1 - t));
    for (let y = cy - halfHeight; y <= cy + halfHeight; y += 1) setPixel(data, x, y, [22, 22, 26]);
  }
}

// ── PNG encoding (8-bit RGBA, filter 0) ────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), payload])), 0);
  return Buffer.concat([head, payload, crc]);
}

function encodePng(rgba) {
  const raw = Buffer.alloc(H * (W * 4 + 1));
  for (let y = 0; y < H; y += 1) {
    raw[y * (W * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── The four patterns ──────────────────────────────────────────────────────

const PAPER = [250, 249, 244];

const PATTERNS = {
  checks: () => {
    const data = createImage(PAPER);
    paintSafeArea(data, (x, y) =>
      (Math.floor(x / 56) + Math.floor(y / 56)) % 2 === 0 ? [226, 62, 156] : [255, 236, 248],
    );
    // A fat ring so a stretched UV is obvious.
    const r = 250;
    const cx = SA.width / 2;
    const cy = SA.height / 2;
    paintSafeArea(data, (x, y) => {
      const d = Math.hypot(x - cx, y - cy);
      return d > r - 34 && d < r ? [86, 20, 60] : null;
    });
    paintOrientationMarks(data);
    return data;
  },
  stripes: () => {
    const data = createImage(PAPER);
    paintSafeArea(data, (x, y) => {
      const band = Math.floor((x + y) / 64) % 3;
      return band === 0 ? [32, 156, 176] : band === 1 ? [244, 248, 250] : [16, 84, 110];
    });
    paintOrientationMarks(data);
    return data;
  },
  rings: () => {
    const data = createImage(PAPER);
    const cx = SA.width / 2;
    const cy = SA.height / 2;
    paintSafeArea(data, (x, y) => {
      const ring = Math.floor(Math.hypot(x - cx, y - cy) / 48) % 2;
      return ring === 0 ? [126, 74, 200] : [246, 240, 255];
    });
    paintOrientationMarks(data);
    return data;
  },
  grid: () => {
    const data = createImage(PAPER);
    paintSafeArea(data, (x, y) =>
      x % 72 < 12 || y % 72 < 12 ? [58, 46, 24] : [246, 190, 60],
    );
    paintOrientationMarks(data);
    return data;
  },
};

// ── Static lobby state ─────────────────────────────────────────────────────

/**
 * Four dinos so the harness exercises all four slugs and BOTH texture paths:
 * three carry a drawing, `bronto` deliberately has none and must keep the
 * code-generated placeholder skin.
 */
const PLAYERS = [
  {
    sessionId: 'sess-trex',
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Rexy Roar',
    modelSlug: 'trex',
    pattern: 'checks',
    position: { x: -4.3, y: 0, z: 1.1 },
    heading: -0.28,
  },
  {
    sessionId: 'sess-stego',
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Spike Norris',
    modelSlug: 'stego',
    pattern: 'stripes',
    position: { x: -0.4, y: 0, z: -2.4 },
    heading: 0.22,
  },
  {
    sessionId: 'sess-raptor',
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Clawdia',
    modelSlug: 'raptor',
    pattern: 'rings',
    position: { x: 3.4, y: 0, z: 1.4 },
    heading: -0.55,
  },
  {
    sessionId: 'sess-bronto',
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Longboi',
    modelSlug: 'bronto',
    pattern: null, // no drawing yet → placeholder skin
    position: { x: 7.2, y: 0, z: -6.2 },
    heading: 0.5,
  },
];

/** The spare texture E2E #2 hot-swaps onto an already-rendered dino. */
const SPARE_PATTERN = 'grid';

// ── Emit ───────────────────────────────────────────────────────────────────

mkdirSync(texDir, { recursive: true });
for (const file of readdirSync(texDir)) rmSync(join(texDir, file));

const hashes = {};
const manifest = { textures: [] };

for (const [name, build] of Object.entries(PATTERNS)) {
  const png = encodePng(build());
  const hash = createHash('sha256').update(png).digest('hex');
  writeFileSync(join(texDir, `${hash}.png`), png);
  hashes[name] = hash;
  manifest.textures.push({
    pattern: name,
    hash,
    bytes: png.length,
    role: name === SPARE_PATTERN ? 'spare (hot-swap target)' : 'initial',
  });
}

const state = {
  code: 'DEBUG',
  createdAt: 0,
  players: Object.fromEntries(
    PLAYERS.map((player) => [
      player.sessionId,
      {
        id: player.id,
        name: player.name,
        modelSlug: player.modelSlug,
        textureHash: player.pattern ? hashes[player.pattern] : '',
        position: player.position,
        heading: player.heading,
      },
    ]),
  ),
};

manifest.spareHash = hashes[SPARE_PATTERN];
manifest.note =
  'Generated by apps/web/scripts/generate-debug-textures.mjs — regenerate, never hand-edit.';

writeFileSync(join(outDir, 'world.json'), `${JSON.stringify(state, null, 2)}\n`);
writeFileSync(join(texDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

for (const entry of manifest.textures) {
  console.log(`${entry.pattern.padEnd(8)} ${entry.hash} ${(entry.bytes / 1024).toFixed(1)} KiB`);
}
console.log(`wrote ${outDir}`);
