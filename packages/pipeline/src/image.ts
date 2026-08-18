/**
 * The one image type the whole pipeline speaks.
 *
 * It is deliberately structurally identical to the DOM's `ImageData`, so in the
 * browser you can hand a real `ImageData` straight in (`ctx.getImageData(...)`)
 * and hand the result straight back out (`ctx.putImageData(...)`), with zero
 * adapters and zero copies. In Node the same shape falls out of `decodePng`.
 *
 * Nothing in this file — or in `homography`/`warp`/`levels`/`detect`/`process`
 * — imports a Node builtin. That is the Wave 4 requirement: the core path is
 * pure typed-array maths and runs unchanged in a browser or a worker.
 */

/** RGBA, row-major, 8 bits per channel. Same memory layout as `ImageData`. */
export interface ImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface Point {
  x: number;
  y: number;
}

/** A quadrilateral, always clockwise from top-left in texture-space terms. */
export type Quad = readonly [Point, Point, Point, Point];

/** Allocates a blank (transparent-black) RGBA image. */
export function createImage(width: number, height: number): ImageDataLike {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** Allocates an opaque image filled with one grey level. */
export function createFilledImage(width: number, height: number, value = 255): ImageDataLike {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(value);
  // fill() also set alpha to `value`; force it opaque.
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

export function cloneImage(img: ImageDataLike): ImageDataLike {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** ITU-R BT.601 luma, the same weighting js-aruco2's grayscale uses. */
export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Extracts a `width*height` Float32 luminance plane. */
export function toLuminancePlane(img: ImageDataLike): Float32Array {
  const out = new Float32Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, p = 0; p < out.length; p++, i += 4) {
    out[p] = luminance(d[i] as number, d[i + 1] as number, d[i + 2] as number);
  }
  return out;
}

/**
 * Box-average downscale by an integer-ish factor. Used by the detector's retry
 * ladder: js-aruco2's adaptive threshold uses a fixed 7px window, so a blurry
 * high-resolution photo can defeat it while the same photo at half size reads
 * perfectly.
 */
export function downscaleImage(img: ImageDataLike, factor: number): ImageDataLike {
  if (factor <= 1) return img;
  const width = Math.max(1, Math.round(img.width / factor));
  const height = Math.max(1, Math.round(img.height / factor));
  const out = createImage(width, height);
  const sx = img.width / width;
  const sy = img.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(img.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(img.width, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++) {
          r += img.data[i] as number;
          g += img.data[i + 1] as number;
          b += img.data[i + 2] as number;
          n++;
          i += 4;
        }
      }
      const o = (y * width + x) * 4;
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Byte offset of the pixel at (x, y), edge-clamped. */
export function clampedIndex(img: ImageDataLike, x: number, y: number): number {
  const cx = x < 0 ? 0 : x >= img.width ? img.width - 1 : x;
  const cy = y < 0 ? 0 : y >= img.height ? img.height - 1 : y;
  return (cy * img.width + cx) * 4;
}

/**
 * Bilinear sample at fractional coordinates, edge-clamped. Writes r,g,b,a into
 * `out` (a caller-owned 4-slot buffer — this runs a few million times per
 * texture, so it allocates nothing).
 */
export function sampleBilinear(img: ImageDataLike, fx: number, fy: number, out: Float64Array): void {
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const ia = clampedIndex(img, x0, y0);
  const ib = clampedIndex(img, x0 + 1, y0);
  const ic = clampedIndex(img, x0, y0 + 1);
  const id = clampedIndex(img, x0 + 1, y0 + 1);
  const d = img.data;
  for (let k = 0; k < 4; k++) {
    const top = (d[ia + k] as number) * (1 - tx) + (d[ib + k] as number) * tx;
    const bot = (d[ic + k] as number) * (1 - tx) + (d[id + k] as number) * tx;
    out[k] = top * (1 - ty) + bot * ty;
  }
}
