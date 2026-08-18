/**
 * Perspective warp — OpenCV's `warpPerspective` with `WARP_INVERSE_MAP`
 * semantics: for every destination pixel we map back into the source and
 * sample there, so the output has no holes.
 *
 * Pure typed-array maths; runs identically in Node and a browser worker.
 */
import {
  createImage,
  sampleBilinear,
  type ImageDataLike,
  type Point,
  type Quad,
} from './image.js';
import {
  applyHomography,
  getPerspectiveTransform,
  invertHomography,
  type Homography,
} from './homography.js';

export interface WarpOptions {
  width: number;
  height: number;
  /**
   * Samples per destination pixel per axis. `2` means each output pixel is the
   * average of a 2×2 grid of source samples.
   *
   * A phone photo of an A4 sheet puts far MORE source pixels inside the
   * drawable quad than the 1024² we warp down to, so plain bilinear
   * point-sampling aliases badly — pencil hatching turns into moiré. `'auto'`
   * measures the quad's source-space size and picks a factor that makes the
   * sample grid at least as dense as the source, capped at 4 (16 samples/px).
   */
  supersample?: number | 'auto';
}

const MAX_SUPERSAMPLE = 4;

/** Longest edge of the quad in source pixels. */
function maxEdgeLength(quad: Quad): number {
  let max = 0;
  for (let i = 0; i < 4; i++) {
    const p = quad[i] as Point;
    const q = quad[(i + 1) % 4] as Point;
    max = Math.max(max, Math.hypot(q.x - p.x, q.y - p.y));
  }
  return max;
}

/** Chooses a supersample factor so we never undersample a high-res photo. */
export function autoSupersample(quad: Quad, destSize: number): number {
  const ratio = maxEdgeLength(quad) / destSize;
  if (!Number.isFinite(ratio) || ratio <= 1.05) return 1;
  return Math.min(MAX_SUPERSAMPLE, Math.ceil(ratio));
}

/**
 * Warps `src` through `h` (a source→dest homography) into a `width`×`height`
 * image. Destination pixels whose back-projection falls outside the source are
 * edge-clamped, matching `BORDER_REPLICATE`.
 */
export function warpPerspective(
  src: ImageDataLike,
  h: Homography,
  options: WarpOptions & { supersample?: number },
): ImageDataLike {
  const { width, height } = options;
  const samples = Math.max(1, Math.round(typeof options.supersample === 'number' ? options.supersample : 1));
  const inv = invertHomography(h);
  const out = createImage(width, height);
  const px = new Float64Array(4);
  const step = 1 / samples;
  const offset = step / 2;
  const n = samples * samples;

  const i0 = inv[0] as number, i1 = inv[1] as number, i2 = inv[2] as number;
  const i3 = inv[3] as number, i4 = inv[4] as number, i5 = inv[5] as number;
  const i6 = inv[6] as number, i7 = inv[7] as number, i8 = inv[8] as number;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy++) {
        const dy = y + offset + sy * step;
        for (let sx = 0; sx < samples; sx++) {
          const dx = x + offset + sx * step;
          const w = i6 * dx + i7 * dy + i8;
          const ux = (i0 * dx + i1 * dy + i2) / w;
          const uy = (i3 * dx + i4 * dy + i5) / w;
          sampleBilinear(src, ux, uy, px);
          r += px[0] as number;
          g += px[1] as number;
          b += px[2] as number;
          a += px[3] as number;
        }
      }
      const o = (y * width + x) * 4;
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = a / n;
    }
  }
  return out;
}

/**
 * The pipeline's headline operation: take the four drawable-quad corners found
 * in a photo (clockwise from top-left, i.e. marker ids `MARKERS.order`) and
 * produce the canonical texture-sized raster.
 *
 * The destination points come from the frozen `TEXTURE_DEST_POINTS`, so this
 * function and the printed template can never disagree.
 */
export function warpQuadToTexture(
  src: ImageDataLike,
  quad: Quad,
  destPoints: readonly (readonly [number, number])[],
  options: WarpOptions,
): ImageDataLike {
  const dst: Point[] = destPoints.map(([x, y]) => ({ x, y }));
  const h = getPerspectiveTransform(quad as readonly Point[], dst);
  const supersample =
    options.supersample === 'auto' || options.supersample === undefined
      ? autoSupersample(quad, Math.max(options.width, options.height))
      : options.supersample;
  return warpPerspective(src, h, { width: options.width, height: options.height, supersample });
}

/** Re-exported for callers that want to map single points (debug overlays). */
export { applyHomography, getPerspectiveTransform, invertHomography };
