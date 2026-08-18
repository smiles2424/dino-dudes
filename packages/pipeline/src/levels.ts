/**
 * Step 3 of the pipeline: make a photographed pencil/marker drawing look like
 * a scan.
 *
 * A phone photo of a white sheet is never white and never evenly lit — there
 * is a lighting gradient across the page, the paper picks up a colour cast
 * from the room, and graphite is a mid-grey that a naive global contrast
 * stretch either crushes or leaves washed out. Three passes fix all of it:
 *
 *   1. **Flat-field** — estimate the paper's local brightness (the
 *      illumination field) and divide it out. This is what kills the gradient,
 *      and it is the reason the golden test survives the fixture generator's
 *      randomised lighting. The field is estimated on a coarse grid using a
 *      HIGH percentile per cell, so ink (dark) never drags the estimate down
 *      as long as any cell is mostly paper; the grid is then bilinearly
 *      upsampled, which is exactly a smooth illumination model.
 *   2. **Levels** — a percentile-based black/white point stretch on the
 *      corrected image, so graphite goes properly dark.
 *   3. **Paper knockout** — anything above `whitePoint` snaps to pure white,
 *      so the texture's background is a clean 255 the 3D material can treat as
 *      "unpainted" instead of a faintly grey haze.
 *
 * Colour is preserved: gain and levels are computed on luminance and applied
 * equally to R/G/B, so a red marker stays red while its paper goes white.
 *
 * Isomorphic: no Node builtins.
 */
import { cloneImage, luminance, toLuminancePlane, type ImageDataLike } from './image.js';

export interface LevelsOptions {
  /**
   * Cells per axis in the illumination-field estimate. 24 over a 1024px
   * texture is a ~43px cell — far larger than any pen stroke, far smaller than
   * the lighting variation across a sheet.
   */
  fieldGrid?: number;
  /**
   * Percentile within each field cell taken as "this is what paper looks like
   * here". High enough to ignore ink, low enough to ignore specular glare.
   */
  fieldPercentile?: number;
  /** Black point, as a percentile of the flat-fielded luminance histogram. */
  blackPercentile?: number;
  /** White point, as a percentile. */
  whitePercentile?: number;
  /**
   * Post-stretch luminance at or above which a pixel is declared bare paper
   * and forced to pure white.
   */
  paperKnockout?: number;
  /** Set false to skip step 1 (e.g. for already-scanned input). */
  flatField?: boolean;
}

/**
 * Tuned in Wave 2A by sweeping each knob against the whole synthetic fixture
 * set (`packages/pipeline/test/pipeline.test.mjs` measures the result).
 *
 * `paperKnockout` is the one that mattered: at 232 the harshly-lit fixture
 * kept a mottled grey background and scored SSIM 0.884; at 216 it scores
 * 0.947, and the sweep showed no ink loss on any fixture down to 200. 216
 * leaves headroom for genuinely faint pencil, which the levels pass has
 * already stretched darker by this point.
 */
export const DEFAULT_LEVELS: Required<LevelsOptions> = {
  fieldGrid: 24,
  fieldPercentile: 0.8,
  blackPercentile: 0.004,
  whitePercentile: 0.985,
  paperKnockout: 216,
  flatField: true,
};

/** Percentile of an unsorted Float32Array, via a 256-bucket histogram. */
function percentile(values: Float32Array, p: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < values.length; i++) {
    let v = Math.round(values[i] as number);
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    hist[v] = (hist[v] as number) + 1;
  }
  const target = Math.max(1, Math.floor(values.length * p));
  let running = 0;
  for (let v = 0; v < 256; v++) {
    running += hist[v] as number;
    if (running >= target) return v;
  }
  return 255;
}

/**
 * Estimates the illumination field: a `grid`×`grid` map of "paper brightness
 * here", bilinearly interpolated back up to full resolution.
 */
export function estimateIlluminationField(
  lum: Float32Array,
  width: number,
  height: number,
  grid: number,
  p: number,
): Float32Array {
  const coarse = new Float32Array(grid * grid);
  const cellW = width / grid;
  const cellH = height / grid;
  const bucket = new Uint32Array(256);

  for (let gy = 0; gy < grid; gy++) {
    const y0 = Math.floor(gy * cellH);
    const y1 = Math.min(height, Math.ceil((gy + 1) * cellH));
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor(gx * cellW);
      const x1 = Math.min(width, Math.ceil((gx + 1) * cellW));
      bucket.fill(0);
      let n = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) {
          let v = Math.round(lum[row + x] as number);
          v = v < 0 ? 0 : v > 255 ? 255 : v;
          bucket[v] = (bucket[v] as number) + 1;
          n++;
        }
      }
      const target = Math.max(1, Math.floor(n * p));
      let running = 0;
      let value = 255;
      for (let v = 0; v < 256; v++) {
        running += bucket[v] as number;
        if (running >= target) {
          value = v;
          break;
        }
      }
      coarse[gy * grid + gx] = Math.max(1, value);
    }
  }

  // Smooth the coarse map once (3×3 box) so a cell that happened to be mostly
  // ink cannot punch a hole in the field.
  const smooth = new Float32Array(grid * grid);
  for (let gy = 0; gy < grid; gy++) {
    for (let gx = 0; gx < grid; gx++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const y = gy + dy;
        if (y < 0 || y >= grid) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = gx + dx;
          if (x < 0 || x >= grid) continue;
          sum += coarse[y * grid + x] as number;
          n++;
        }
      }
      smooth[gy * grid + gx] = sum / n;
    }
  }

  // Bilinear upsample, sampling cell CENTRES so the field has no seams.
  const field = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(grid - 1, Math.max(0, (y + 0.5) / cellH - 0.5));
    const gy0 = Math.floor(fy);
    const gy1 = Math.min(grid - 1, gy0 + 1);
    const ty = fy - gy0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(grid - 1, Math.max(0, (x + 0.5) / cellW - 0.5));
      const gx0 = Math.floor(fx);
      const gx1 = Math.min(grid - 1, gx0 + 1);
      const tx = fx - gx0;
      const a = smooth[gy0 * grid + gx0] as number;
      const b = smooth[gy0 * grid + gx1] as number;
      const c = smooth[gy1 * grid + gx0] as number;
      const d = smooth[gy1 * grid + gx1] as number;
      field[y * width + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return field;
}

/**
 * Runs the three cleanup passes. Returns a new image; `src` is untouched.
 * Alpha is forced opaque — a texture never has holes.
 */
export function cleanupLevels(src: ImageDataLike, options: LevelsOptions = {}): ImageDataLike {
  const o = { ...DEFAULT_LEVELS, ...options };
  const out = cloneImage(src);
  const { width, height } = src;
  const n = width * height;

  // ── 1. Flat-field ────────────────────────────────────────────────────────
  const lum = toLuminancePlane(src);
  const corrected = new Float32Array(n);
  if (o.flatField) {
    const field = estimateIlluminationField(lum, width, height, o.fieldGrid, o.fieldPercentile);
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const gain = 255 / Math.max(1, field[p] as number);
      out.data[i] = (src.data[i] as number) * gain;
      out.data[i + 1] = (src.data[i + 1] as number) * gain;
      out.data[i + 2] = (src.data[i + 2] as number) * gain;
      corrected[p] = Math.min(255, (lum[p] as number) * gain);
    }
  } else {
    corrected.set(lum);
  }

  // ── 2. Levels ────────────────────────────────────────────────────────────
  const black = percentile(corrected, o.blackPercentile);
  const white = Math.max(black + 8, percentile(corrected, o.whitePercentile));
  const scale = 255 / (white - black);

  // Build the transfer curve once; applying it is then a table lookup.
  const curve = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    curve[v] = Math.round(Math.min(255, Math.max(0, (v - black) * scale)));
  }

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = curve[Math.min(255, Math.max(0, Math.round(out.data[i] as number)))] as number;
    const g = curve[Math.min(255, Math.max(0, Math.round(out.data[i + 1] as number)))] as number;
    const b = curve[Math.min(255, Math.max(0, Math.round(out.data[i + 2] as number)))] as number;

    // ── 3. Paper knockout ──────────────────────────────────────────────────
    if (luminance(r, g, b) >= o.paperKnockout) {
      out.data[i] = 255;
      out.data[i + 1] = 255;
      out.data[i + 2] = 255;
    } else {
      out.data[i] = r;
      out.data[i + 1] = g;
      out.data[i + 2] = b;
    }
    out.data[i + 3] = 255;
  }

  return out;
}

/**
 * Variance of the Laplacian over the luminance plane — the standard cheap
 * focus measure. Reported (not enforced) so Wave 4 can nudge the user.
 */
export function sharpness(img: ImageDataLike): number {
  const lum = toLuminancePlane(img);
  const { width, height } = img;
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const lap =
        4 * (lum[i] as number) -
        (lum[i - 1] as number) -
        (lum[i + 1] as number) -
        (lum[i - width] as number) -
        (lum[i + width] as number);
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return Math.max(0, sumSq / n - mean * mean);
}

/** Mean luminance, 0–255. */
export function meanLuminance(img: ImageDataLike): number {
  const lum = toLuminancePlane(img);
  let sum = 0;
  for (let i = 0; i < lum.length; i++) sum += lum[i] as number;
  return sum / lum.length;
}
