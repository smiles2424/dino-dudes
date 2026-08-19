/**
 * A real, valid PNG built from scratch — the E2E suite's stand-in for a
 * pipeline output (Wave 4, Chunk 4.1).
 *
 * A TypeScript port of `apps/server/test/fixture-png.mjs`, kept as a copy
 * rather than an import because the `e2e` package is a separate TS program
 * that cannot type-check a loose `.mjs` in another workspace.
 *
 * Why generated rather than committed: `avatars.texture_hash` is UNIQUE, so
 * every run needs *different* bytes to get its own content address. Seeding the
 * colour from a per-run id does that while keeping the image a smooth gradient
 * (a noise image would not compress and would blow past the 2 MB cap).
 *
 * Lives outside `tests/` so Playwright never mistakes it for a spec.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE: number[] = Array.from({ length: 256 }, (_unused, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGB PNG of `size`×`size`; `seed` shifts the colours so each run is unique. */
export function makePng(size: number, seed: string): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB

  let tint = 0;
  for (const ch of seed) tint = (tint * 31 + ch.charCodeAt(0)) & 0xff;

  const stride = size * 3 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const p = row + 1 + x * 3;
      raw[p] = (x >> 2) & 0xff;
      raw[p + 1] = (y >> 2) & 0xff;
      raw[p + 2] = tint;
    }
  }

  /*
   * Stamp the seed into the first row's blue channel.
   *
   * `tint` alone is one byte, so the generator can only ever produce 256
   * distinct images — and `avatars.texture_hash` is UNIQUE, so two runs whose
   * seeds happen to collide would silently share one avatar row (see the
   * Wave 3 Chunk 3.2 note about a *different* player getting the original
   * uploader's avatar back). Writing the seed's own bytes into the image makes
   * distinct seeds mean distinct content addresses, always.
   */
  for (let i = 0; i < seed.length && i < size; i += 1) {
    raw[1 + i * 3 + 2] = seed.charCodeAt(i) & 0xff;
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
