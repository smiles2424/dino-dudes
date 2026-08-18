/**
 * Planar homography — the maths OpenCV's `getPerspectiveTransform` /
 * `perspectiveTransform` do, in ~120 lines of dependency-free TypeScript.
 *
 * ── Why not OpenCV.js? ─────────────────────────────────────────────────────
 * PLAN.md names OpenCV.js (WASM) for the deskew. We deliberately did NOT take
 * it, and the plan explicitly allows this ("an equivalent well-tested
 * homography implementation is an acceptable documented deviation"). Reasons:
 *
 *   1. The whole OpenCV.js build is ~8 MB of WASM to obtain two functions that
 *      are 120 lines of linear algebra. On the phones this app targets, that
 *      download sits directly in the capture flow's critical path.
 *   2. There is no single OpenCV.js artifact that loads cleanly in *both* Node
 *      (for CI goldens) and a Vite browser bundle — it wants `cv.wasm` fetched
 *      from a URL and hangs its module off a global with an async ready hook.
 *      That is a lot of load-bearing glue for the highest-risk module.
 *   3. `getPerspectiveTransform` is an exactly-determined 8×8 solve — there is
 *      no algorithmic subtlety and no approximation to get wrong. It is
 *      verified here two ways: an analytic round-trip test, and the golden
 *      SSIM suite which measures the warp end-to-end.
 *
 * If a future wave needs OpenCV's heavier machinery (contour finding, ArUco
 * refinement), swapping this module for `cv.getPerspectiveTransform` is a
 * drop-in: the matrix convention below is OpenCV's exactly (row-major 3×3,
 * `h[8] == 1`, maps src → dst).
 */
import type { Point } from './image.js';

/** Row-major 3×3, `[h0..h8]`, `h8` normalised to 1. Maps src → dst. */
export type Homography = Float64Array;

/**
 * Solves `A x = b` for an n×n system by Gaussian elimination with partial
 * pivoting. `a` is row-major and is destroyed. Returns null if singular.
 */
function solveLinearSystem(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
  for (let col = 0; col < n; col++) {
    // Partial pivot: the largest |value| in this column at or below the diagonal.
    let pivot = col;
    let best = Math.abs(a[col * n + col] as number);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(a[row * n + col] as number);
      if (v > best) {
        best = v;
        pivot = row;
      }
    }
    if (best < 1e-12) return null;
    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const t = a[col * n + k] as number;
        a[col * n + k] = a[pivot * n + k] as number;
        a[pivot * n + k] = t;
      }
      const t = b[col] as number;
      b[col] = b[pivot] as number;
      b[pivot] = t;
    }
    const diag = a[col * n + col] as number;
    for (let row = col + 1; row < n; row++) {
      const factor = (a[row * n + col] as number) / diag;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) {
        a[row * n + k] = (a[row * n + k] as number) - factor * (a[col * n + k] as number);
      }
      b[row] = (b[row] as number) - factor * (b[col] as number);
    }
  }
  // Back-substitution.
  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = b[row] as number;
    for (let k = row + 1; k < n; k++) sum -= (a[row * n + k] as number) * (x[k] as number);
    x[row] = sum / (a[row * n + row] as number);
  }
  return x;
}

/**
 * The 3×3 homography taking the four `src` points to the four `dst` points,
 * in order. Same contract as OpenCV's `getPerspectiveTransform`.
 *
 * Each correspondence (x,y) → (u,v) gives two rows of an 8×8 system:
 *   u = (h0 x + h1 y + h2) / (h6 x + h7 y + 1)
 *   v = (h3 x + h4 y + h5) / (h6 x + h7 y + 1)
 * cross-multiplied into linear form.
 *
 * @throws if the correspondence is degenerate (three collinear points, etc).
 */
export function getPerspectiveTransform(
  src: readonly Point[],
  dst: readonly Point[],
): Homography {
  if (src.length !== 4 || dst.length !== 4) {
    throw new RangeError('getPerspectiveTransform needs exactly 4 point pairs');
  }
  const a = new Float64Array(8 * 8);
  const b = new Float64Array(8);

  for (let i = 0; i < 4; i++) {
    const s = src[i] as Point;
    const d = dst[i] as Point;
    const r0 = i * 2 * 8;
    a[r0 + 0] = s.x;
    a[r0 + 1] = s.y;
    a[r0 + 2] = 1;
    a[r0 + 6] = -s.x * d.x;
    a[r0 + 7] = -s.y * d.x;
    b[i * 2] = d.x;

    const r1 = (i * 2 + 1) * 8;
    a[r1 + 3] = s.x;
    a[r1 + 4] = s.y;
    a[r1 + 5] = 1;
    a[r1 + 6] = -s.x * d.y;
    a[r1 + 7] = -s.y * d.y;
    b[i * 2 + 1] = d.y;
  }

  const solution = solveLinearSystem(a, b, 8);
  if (!solution) throw new Error('degenerate point correspondence: homography is singular');

  const h = new Float64Array(9);
  h.set(solution, 0);
  h[8] = 1;
  for (const v of h) {
    if (!Number.isFinite(v)) throw new Error('degenerate point correspondence: non-finite homography');
  }
  return h;
}

/** Applies `h` to a point. Equivalent to OpenCV's `perspectiveTransform`. */
export function applyHomography(h: Homography, x: number, y: number): Point {
  const w = (h[6] as number) * x + (h[7] as number) * y + (h[8] as number);
  if (w === 0) return { x: Number.NaN, y: Number.NaN };
  return {
    x: ((h[0] as number) * x + (h[1] as number) * y + (h[2] as number)) / w,
    y: ((h[3] as number) * x + (h[4] as number) * y + (h[5] as number)) / w,
  };
}

/** The inverse mapping (dst → src). Uses the adjugate, then renormalises. */
export function invertHomography(h: Homography): Homography {
  const A = h[0] as number;
  const B = h[1] as number;
  const C = h[2] as number;
  const D = h[3] as number;
  const E = h[4] as number;
  const F = h[5] as number;
  const G = h[6] as number;
  const H = h[7] as number;
  const I = h[8] as number;

  const co0 = E * I - F * H;
  const co1 = -(D * I - F * G);
  const co2 = D * H - E * G;
  const det = A * co0 + B * co1 + C * co2;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error('homography is not invertible');
  }
  const inv = new Float64Array(9);
  inv[0] = co0;
  inv[1] = -(B * I - C * H);
  inv[2] = B * F - C * E;
  inv[3] = co1;
  inv[4] = A * I - C * G;
  inv[5] = -(A * F - C * D);
  inv[6] = co2;
  inv[7] = -(A * H - B * G);
  inv[8] = A * E - B * D;
  for (let k = 0; k < 9; k++) inv[k] = (inv[k] as number) / det;
  // Renormalise so inv[8] == 1, matching the convention above.
  const s = inv[8] as number;
  if (Math.abs(s) > 1e-12) for (let k = 0; k < 9; k++) inv[k] = (inv[k] as number) / s;
  return inv;
}

/** Signed area of a polygon; positive == clockwise in image coords (y down). */
export function signedArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as Point;
    const q = points[(i + 1) % points.length] as Point;
    sum += p.x * q.y - q.x * p.y;
  }
  return sum / 2;
}

/** True when the quad is convex and non-self-intersecting. */
export function isConvexQuad(points: readonly Point[]): boolean {
  if (points.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const p = points[i] as Point;
    const q = points[(i + 1) % 4] as Point;
    const r = points[(i + 2) % 4] as Point;
    const cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}
