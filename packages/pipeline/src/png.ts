/**
 * A small, exact PNG codec — encode/decode of 8-bit non-interlaced PNGs.
 *
 * ── Why hand-rolled? ───────────────────────────────────────────────────────
 * The pipeline needs PNG only at its two ENDS (read a fixture photo, write a
 * golden), never in the core. Every off-the-shelf option is a bad trade for
 * that: `sharp`/`canvas` are native modules that break CI on some platforms
 * and cannot run in a browser at all; `pngjs` is a stream API around the same
 * ~200 lines that follow. Since `node:zlib` already ships the hard part
 * (DEFLATE), the rest is chunk framing, CRC32 and the five PNG filters.
 *
 * ── Node-only, and deliberately so ─────────────────────────────────────────
 * This is the ONE module in the package that imports a Node builtin, and it is
 * reachable only through the `@dino/pipeline/node` entry point — never from
 * the package root. In the browser (Wave 4) you do not need it: `ImageData`
 * comes out of a canvas and PNG bytes go back in via `canvas.convertToBlob()`.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { createFilledImage, type ImageDataLike } from './image.js';

const SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── CRC32 ──────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── Encode ─────────────────────────────────────────────────────────────────

export interface EncodePngOptions {
  /**
   * Drop the alpha channel (PNG colour type 2). The pipeline's textures and
   * the synthetic photos are always opaque, and this makes the files 25%
   * smaller for free. Defaults to true when every alpha byte is 255.
   */
  rgb?: boolean;
  /** zlib level, 0–9. 9 by default: these files are written once, read often. */
  level?: number;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/**
 * Filters one scanline with all five PNG filters and keeps the one with the
 * smallest sum of absolute differences — the heuristic the PNG spec itself
 * recommends, and what makes flat texture backgrounds compress to nothing.
 */
function filterScanline(
  raw: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
  out: Uint8Array,
  outOffset: number,
): void {
  const len = raw.length;
  const candidates = new Uint8Array(5 * len);
  const scores = [0, 0, 0, 0, 0];

  for (let i = 0; i < len; i++) {
    const x = raw[i] as number;
    const a = i >= bpp ? (raw[i - bpp] as number) : 0;
    const b = prev ? (prev[i] as number) : 0;
    const c = prev && i >= bpp ? (prev[i - bpp] as number) : 0;
    const values = [x, (x - a) & 0xff, (x - b) & 0xff, (x - ((a + b) >> 1)) & 0xff, (x - paeth(a, b, c)) & 0xff];
    for (let f = 0; f < 5; f++) {
      const v = values[f] as number;
      candidates[f * len + i] = v;
      scores[f] = (scores[f] as number) + (v < 128 ? v : 256 - v);
    }
  }

  let best = 0;
  for (let f = 1; f < 5; f++) if ((scores[f] as number) < (scores[best] as number)) best = f;
  out[outOffset] = best;
  out.set(candidates.subarray(best * len, best * len + len), outOffset + 1);
}

/** Encodes an RGBA image as PNG bytes. */
export function encodePng(img: ImageDataLike, options: EncodePngOptions = {}): Uint8Array {
  const { width, height, data } = img;
  if (data.length !== width * height * 4) throw new RangeError('image data length mismatch');

  let opaque = true;
  for (let i = 3; i < data.length && opaque; i += 4) if (data[i] !== 255) opaque = false;
  const rgb = options.rgb ?? opaque;
  const channels = rgb ? 3 : 4;

  const stride = width * channels;
  const rawLine = new Uint8Array(stride);
  let prevLine: Uint8Array | null = null;
  const filtered = new Uint8Array((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = x * channels;
      rawLine[d] = data[s] as number;
      rawLine[d + 1] = data[s + 1] as number;
      rawLine[d + 2] = data[s + 2] as number;
      if (!rgb) rawLine[d + 3] = data[s + 3] as number;
    }
    filterScanline(rawLine, prevLine, channels, filtered, y * (stride + 1));
    prevLine = prevLine ? prevLine : new Uint8Array(stride);
    prevLine.set(rawLine);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = rgb ? 2 : 6; // colour type
  // 10..12 = compression 0, filter 0, interlace 0 (already zero)

  const idat = deflateSync(filtered, { level: options.level ?? 9 });

  const parts = [SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(idat)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

// ── Decode ─────────────────────────────────────────────────────────────────

const CHANNELS_BY_COLOUR_TYPE: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** Decodes an 8-bit, non-interlaced PNG into RGBA. */
export function decodePng(bytes: Uint8Array): ImageDataLike {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new Error('not a PNG (bad signature)');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  const idatParts: Uint8Array[] = [];

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4] as number,
      bytes[offset + 5] as number,
      bytes[offset + 6] as number,
      bytes[offset + 7] as number,
    );
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = body[8] as number;
      colourType = body[9] as number;
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`);
      if ((body[12] as number) !== 0) throw new Error('interlaced PNGs are not supported');
      if (CHANNELS_BY_COLOUR_TYPE[colourType] === undefined) {
        throw new Error(`unsupported PNG colour type ${colourType}`);
      }
    } else if (type === 'IDAT') {
      idatParts.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error('PNG has no IHDR');

  const channels = CHANNELS_BY_COLOUR_TYPE[colourType] as number;
  const merged = new Uint8Array(idatParts.reduce((s, p) => s + p.length, 0));
  let m = 0;
  for (const p of idatParts) {
    merged.set(p, m);
    m += p.length;
  }
  const raw = new Uint8Array(inflateSync(merged));

  const stride = width * channels;
  const out = createFilledImage(width, height, 0);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const filter = raw[base] as number;
    for (let i = 0; i < stride; i++) {
      const x = raw[base + 1 + i] as number;
      const a = i >= channels ? (line[i - channels] as number) : 0;
      const b = prev[i] as number;
      const c = i >= channels ? (prev[i - channels] as number) : 0;
      let value: number;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: value = x + paeth(a, b, c); break;
        default: throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      line[i] = value & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      if (channels === 1) {
        const g = line[s] as number;
        out.data[d] = g; out.data[d + 1] = g; out.data[d + 2] = g; out.data[d + 3] = 255;
      } else if (channels === 2) {
        const g = line[s] as number;
        out.data[d] = g; out.data[d + 1] = g; out.data[d + 2] = g;
        out.data[d + 3] = line[s + 1] as number;
      } else {
        out.data[d] = line[s] as number;
        out.data[d + 1] = line[s + 1] as number;
        out.data[d + 2] = line[s + 2] as number;
        out.data[d + 3] = channels === 4 ? (line[s + 3] as number) : 255;
      }
    }
    prev.set(line);
  }
  return out;
}
