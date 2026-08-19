/**
 * The browser half of WS-A: a camera `File` in, a canonical texture PNG out.
 *
 * `@dino/pipeline`'s root entry point is deliberately isomorphic (Wave 2A:
 * ~208 KB, no WASM, no Node builtins), so the whole deskew runs here on the
 * phone and the server only ever sees a finished 1024² PNG. **Never** import
 * `@dino/pipeline/node` from this app — that subpath pulls in `node:zlib`.
 *
 * `processPhoto` is synchronous and CPU-bound. At the working size below it
 * costs well under a second on a mid-range phone, so v1 runs it on the main
 * thread behind a spinner rather than paying for a Worker + a second copy of
 * the pipeline in a separate chunk. Move it to a Worker if real phones say so.
 */
import { processPhoto, type ProcessResult } from '@dino/pipeline';
import { TEXTURE } from '@dino/shared';

/**
 * Longest edge the pipeline actually sees.
 *
 * A modern phone hands over a 12 MP (4000×3000) JPEG. Marker detection does
 * not get better above ~1600 px — the 4x4 ArUco squares are already tens of
 * pixels across — but the cost of every pass in the detection ladder scales
 * with the pixel count, so a full-size photo would be ~6× the work for no
 * accuracy. Wave 2A's fixtures are 1200×1600, i.e. exactly this size, so the
 * browser path processes them at their native resolution.
 */
export const WORKING_LONG_EDGE = 1600;

/** Everything the preview step needs about one processed photo. */
export interface CapturedTexture {
  /** The canonical 1024² PNG, ready to POST. */
  blob: Blob;
  /** Object URL for `blob` — revoke it when the capture is discarded. */
  url: string;
  /** sha256 of `blob`, or `null` where WebCrypto is unavailable (plain http). */
  hash: string | null;
  quality: ProcessResult['quality'];
  warnings: ProcessResult['warnings'];
  /** Source pixels the pipeline actually saw, after downscaling. */
  source: { width: number; height: number };
  /** Milliseconds spent inside `processPhoto` — surfaced for tuning. */
  elapsedMs: number;
}

/**
 * Decode → downscale → deskew → PNG.
 *
 * @throws {import('@dino/pipeline').PipelineError} with a four-entry
 *   per-corner diagnostic when the markers cannot be read; anything else is a
 *   plain `Error` (unreadable file, no 2D context).
 */
export async function captureTexture(file: File): Promise<CapturedTexture> {
  const photo = await decodePhoto(file, WORKING_LONG_EDGE);

  const started = performance.now();
  const result = processPhoto(photo);
  const elapsedMs = Math.round(performance.now() - started);

  const blob = await textureToPng(result.texture);
  return {
    blob,
    url: URL.createObjectURL(blob),
    hash: await sha256Hex(await blob.arrayBuffer()),
    quality: result.quality,
    warnings: result.warnings,
    source: { width: photo.width, height: photo.height },
    elapsedMs,
  };
}

/** Decodes `file` and downscales it so its longest edge is at most `maxEdge`. */
export async function decodePhoto(file: File, maxEdge: number): Promise<ImageData> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("That file isn't an image the browser can read. Try taking the photo again.");
  }

  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const ctx = make2dContext(width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } finally {
    bitmap.close();
  }
}

/** Canonical texture → `image/png` blob, the exact bytes `POST /api/avatars` wants. */
export async function textureToPng(texture: {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}): Promise<Blob> {
  if (texture.width !== TEXTURE.width || texture.height !== TEXTURE.height) {
    throw new Error(
      `pipeline returned ${texture.width}×${texture.height}, expected ${TEXTURE.width}×${TEXTURE.height}`,
    );
  }

  const ctx = make2dContext(texture.width, texture.height);
  // Copied into a fresh buffer: `ImageData` insists on a plain `ArrayBuffer`,
  // and the pipeline's `Uint8ClampedArray` is typed over `ArrayBufferLike`.
  const pixels = new Uint8ClampedArray(texture.data);
  ctx.putImageData(new ImageData(pixels, texture.width, texture.height), 0, 0);

  const canvas = ctx.canvas;
  if (isOffscreen(canvas)) return canvas.convertToBlob({ type: 'image/png' });

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('could not encode the texture as PNG'))),
      'image/png',
    );
  });
}

/** Lowercase hex sha256, or `null` when `crypto.subtle` is not available. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ── Canvas plumbing ────────────────────────────────────────────────────────

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type Any2d = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;

function isOffscreen(canvas: AnyCanvas): canvas is OffscreenCanvas {
  return typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas;
}

/**
 * `OffscreenCanvas` where it exists (every browser that ships `capture=`
 * except older Safari), a detached `<canvas>` otherwise. Neither is ever
 * attached to the document, so nothing here can reflow the page.
 */
function make2dContext(width: number, height: number): Any2d {
  const canvas: AnyCanvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });

  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as Any2d | null;
  if (!ctx) throw new Error('this browser refused a 2D canvas, so photos cannot be processed');
  return ctx;
}
