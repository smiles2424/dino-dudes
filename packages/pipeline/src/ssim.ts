/**
 * Structural Similarity (Wang et al. 2004) on the luminance plane.
 *
 * This is the pipeline's regression metric: every fixture photo is run through
 * the full pipeline and its texture compared against a committed golden. SSIM
 * rather than a pixel diff because the interesting failures are *structural*
 * (quad off by a few pixels, warp flipped, cleanup eating strokes) while the
 * uninteresting differences are per-pixel noise from resampling.
 *
 * Implementation matches the reference: 11×11 Gaussian window, σ=1.5,
 * K1=0.01, K2=0.03, L=255, mean of the per-pixel SSIM map.
 *
 * Isomorphic: no Node builtins.
 */
import { toLuminancePlane, type ImageDataLike } from './image.js';

const K1 = 0.01;
const K2 = 0.03;
const L = 255;
const C1 = (K1 * L) ** 2;
const C2 = (K2 * L) ** 2;

function gaussianKernel(radius: number, sigma: number): Float64Array {
  const size = radius * 2 + 1;
  const k = new Float64Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const d = i - radius;
    const v = Math.exp(-(d * d) / (2 * sigma * sigma));
    k[i] = v;
    sum += v;
  }
  for (let i = 0; i < size; i++) k[i] = (k[i] as number) / sum;
  return k;
}

/** Separable Gaussian blur with edge clamping. */
function blur(src: Float64Array, width: number, height: number, kernel: Float64Array): Float64Array {
  const radius = (kernel.length - 1) / 2;
  const tmp = new Float64Array(width * height);
  const out = new Float64Array(width * height);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.min(width - 1, Math.max(0, x + k));
        acc += (src[row + xx] as number) * (kernel[k + radius] as number);
      }
      tmp[row + x] = acc;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.min(height - 1, Math.max(0, y + k));
        acc += (tmp[yy * width + x] as number) * (kernel[k + radius] as number);
      }
      out[y * width + x] = acc;
    }
  }
  return out;
}

export interface SsimResult {
  /** Mean SSIM over the image, 1 == identical. */
  score: number;
  /** Per-pixel SSIM map, same dimensions as the inputs. */
  map: Float64Array;
  width: number;
  height: number;
}

/** Full SSIM, returning the map as well as the score. */
export function ssimDetailed(a: ImageDataLike, b: ImageDataLike): SsimResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new RangeError(
      `SSIM needs matching dimensions: ${a.width}x${a.height} vs ${b.width}x${b.height}`,
    );
  }
  const { width, height } = a;
  const x = Float64Array.from(toLuminancePlane(a));
  const y = Float64Array.from(toLuminancePlane(b));
  const n = width * height;

  const xx = new Float64Array(n);
  const yy = new Float64Array(n);
  const xy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const xi = x[i] as number;
    const yi = y[i] as number;
    xx[i] = xi * xi;
    yy[i] = yi * yi;
    xy[i] = xi * yi;
  }

  const kernel = gaussianKernel(5, 1.5);
  const mx = blur(x, width, height, kernel);
  const my = blur(y, width, height, kernel);
  const mxx = blur(xx, width, height, kernel);
  const myy = blur(yy, width, height, kernel);
  const mxy = blur(xy, width, height, kernel);

  const map = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const ux = mx[i] as number;
    const uy = my[i] as number;
    const vx = (mxx[i] as number) - ux * ux;
    const vy = (myy[i] as number) - uy * uy;
    const vxy = (mxy[i] as number) - ux * uy;
    const s =
      ((2 * ux * uy + C1) * (2 * vxy + C2)) / ((ux * ux + uy * uy + C1) * (vx + vy + C2));
    map[i] = s;
    total += s;
  }
  return { score: total / n, map, width, height };
}

/** Mean SSIM of two same-sized images, on luminance. 1 == identical. */
export function ssim(a: ImageDataLike, b: ImageDataLike): number {
  return ssimDetailed(a, b).score;
}
