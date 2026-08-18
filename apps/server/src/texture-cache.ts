/**
 * A small in-process memo for texture bytes, in front of Redis (Wave 4, 3.3).
 *
 * **Why it exists.** The wave's promise is "a drawing is on the projector
 * within five seconds of the upload being accepted". Measured end to end, the
 * Colyseus patch is ~20 ms of that and `GET /api/textures/:hash` is *all the
 * rest*: the PNG is ~1 MB and Upstash speaks HTTPS over the public internet, so
 * a cache hit still cost 0.8–3.9 s from a home connection — occasionally
 * blowing the whole budget on the one hop that is easiest to remove.
 *
 * The upload route puts the bytes here the moment it has them, which is the
 * case that matters: the phone uploads and, a second later, every screen in the
 * lobby asks for exactly those bytes.
 *
 * **Safe by construction.** The key is the sha256 of the value, so an entry can
 * never be stale — a different drawing is a different key. Nothing invalidates,
 * and nothing can serve the wrong picture.
 *
 * **Bounded.** Eviction is least-recently-used over a byte budget rather than a
 * count, because a texture is up to `TEXTURE.maxBytes` and an unbounded map of
 * them is a memory leak with a lobby attached. Redis and Postgres are still
 * behind it, so an eviction costs latency, never a drawing. In a multi-instance
 * deployment (Wave 5) each instance simply warms its own.
 */

/** ~48 MB: dozens of drawings, a rounding error next to Node's heap. */
export const TEXTURE_MEMO_MAX_BYTES = 48 * 1024 * 1024;

/** Insertion order IS the LRU order — a hit re-inserts. */
const memo = new Map<string, Buffer>();
let memoBytes = 0;

/** Cache `bytes` under their own content address. */
export function rememberTexture(hash: string, bytes: Buffer): void {
  const existing = memo.get(hash);
  if (existing) {
    memoBytes -= existing.length;
    memo.delete(hash);
  }
  memo.set(hash, bytes);
  memoBytes += bytes.length;

  while (memoBytes > TEXTURE_MEMO_MAX_BYTES) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memoBytes -= memo.get(oldest.value)?.length ?? 0;
    memo.delete(oldest.value);
  }
}

/** The bytes, or `null`. A hit refreshes the entry's place in the queue. */
export function recallTexture(hash: string): Buffer | null {
  const bytes = memo.get(hash);
  if (!bytes) return null;
  memo.delete(hash);
  memo.set(hash, bytes);
  return bytes;
}

/** Test hook: forget everything. */
export function clearTextureMemo(): void {
  memo.clear();
  memoBytes = 0;
}
