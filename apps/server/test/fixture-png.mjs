/**
 * A real, valid PNG built from scratch — shared by the server integration tests.
 *
 * Why not a checked-in fixture: textures are content-addressed and shared, so
 * every test run wants *different* bytes — otherwise a run's cleanup would be
 * deleting a row another run is still using (and, before Chunk 5.2 split the
 * blob from the wearer, identical bytes actively stole the other player's
 * avatar row). Seeding the colour from a per-run id gives each run its
 * own content address while keeping the image a smooth gradient — a noise image
 * would not compress and would blow past the Texture Spec's 2 MB cap.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGB PNG of `size`×`size`; `seed` shifts the colours so each run is unique. */
export function makePng(size, seed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  let tint = 0;
  for (const ch of seed) tint = (tint * 31 + ch.charCodeAt(0)) & 0xff;
  const stride = size * 3 + 1;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = row + 1 + x * 3;
      raw[p] = (x >> 2) & 0xff;
      raw[p + 1] = (y >> 2) & 0xff;
      raw[p + 2] = tint;
    }
  }
  /*
   * Stamp the seed into the first row's blue channel (Wave 4, Chunk 4.1).
   *
   * `tint` is one byte, so the generator could only ever produce 256 distinct
   * images — and `avatars.texture_hash` is UNIQUE, so two runs with colliding
   * tints silently share one avatar row and `avatar.playerId` stops matching
   * `player.id` (the documented consequence in the Chunk 3.2 log note). Writing
   * the seed's own bytes in makes distinct seeds mean distinct content
   * addresses, always. ~1/256 of runs used to trip over this.
   */
  for (let i = 0; i < seed.length && i < size; i++) {
    raw[1 + i * 3 + 2] = seed.charCodeAt(i) & 0xff;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
