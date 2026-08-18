/**
 * Synthetic fixture generator — stand-in "phone photos" until real ones land.
 *
 * PLAN.md's WS-A calls for ~10 real photos of a filled template. Those need a
 * human with a printer and a phone, so Wave 2A generates a set with the same
 * shape: a drawing composited onto the real generated template, then abused
 * the way a phone abuses a photograph.
 *
 * Everything is seeded, so `generateFixtureSet()` produces byte-identical
 * output on every machine and CI run — which is the only way a golden suite is
 * worth having. The seeds are part of the contract: changing one invalidates
 * that fixture's golden.
 *
 * Pipeline of a fixture:
 *   rasterizeTemplate  →  composite drawing into the guide box
 *   →  place on a "desk" background  →  perspective + rotation
 *   →  lighting gradient + vignette  →  blur  →  sensor noise
 *
 * Isomorphic: no Node builtins (writing files lives in `node.ts`).
 */
import { TEMPLATE_MM, TEXTURE, TEXTURE_DEST_POINTS, TEXTURE_SAFE_AREA } from '@dino/shared';
import { createDrawing, createRng, drawStrokes, type DrawMapping, type Stroke } from './draw.js';
import { getPerspectiveTransform } from './homography.js';
import {
  cloneImage,
  createFilledImage,
  luminance,
  type ImageDataLike,
  type Point,
  type Quad,
} from './image.js';
import { cleanupLevels, clearTemplateMargin } from './levels.js';
import { rasterizeTemplate } from './rasterize.js';
import { computeLayout } from './template.js';
import { warpPerspective, warpQuadToTexture } from './warp.js';

/** Resolution the flat sheet is rasterized at. ~203 DPI. */
export const SHEET_PX_PER_MM = 8;

/**
 * Fixture photo size — 1.9 MP, the size a phone photo arrives at after the
 * capture flow downscales it, and enough that the drawable quad spans ~760 px
 * (within ~25% of the texture's own 1024, so the deskew is near 1:1 and the
 * golden test measures the pipeline rather than a resampling artefact).
 *
 * There is a hard file-size reason not to go bigger: sensor noise is close to
 * incompressible in PNG, so every extra megapixel costs ~0.9 MB *per fixture*
 * in the repo. Real fixtures will be JPEGs and can be larger.
 */
export const PHOTO_WIDTH = 1200;
export const PHOTO_HEIGHT = 1600;

/**
 * Stored precision of a fixture, in levels. Rounding the finished photo to
 * even values costs nothing the pipeline can detect (a 1-level shift is orders
 * of magnitude below every threshold in it — measured SSIM actually moves
 * +0.001) and removes ~25% of the PNG's size, which is otherwise pure noise
 * entropy. Set to 1 to disable.
 */
export const PHOTO_QUANTIZE = 2;

export interface FixtureSpec {
  /** Filename stem, e.g. `photo-01-flat`. */
  name: string;
  seed: number;
  /** One-line description of what this fixture is stressing. */
  description: string;
  /** Rotation of the sheet within the frame, degrees. */
  rotationDeg: number;
  /** 0 == head-on. ~0.3 is a steep, awkward angle. */
  perspective: number;
  /** Fraction of the frame's short side the sheet spans. */
  fill: number;
  /** Strength of the lighting gradient, 0–1. */
  lighting: number;
  /** Gaussian blur radius in photo pixels. */
  blur: number;
  /** Sensor noise sigma, in levels. */
  noise: number;
  /** Marker id to cover with a "thumb" — the failure-path fixture. */
  occludeMarker?: number;
}

/**
 * The committed fixture set. Ten photos spanning the range a phone actually
 * produces, plus one deliberately broken one for the error path.
 *
 * Seeds are load-bearing: they name the golden.
 */
export const FIXTURE_SPECS: readonly FixtureSpec[] = [
  { name: 'photo-01-flat', seed: 1001, description: 'head-on, evenly lit — the easy case', rotationDeg: 0.6, perspective: 0.01, fill: 0.9, lighting: 0.08, blur: 0.5, noise: 1.5 },
  { name: 'photo-02-tilted', seed: 1002, description: 'moderate tilt, held slightly above the sheet', rotationDeg: -4, perspective: 0.1, fill: 0.88, lighting: 0.18, blur: 0.6, noise: 2 },
  { name: 'photo-03-angled', seed: 1003, description: 'steep angle from the side', rotationDeg: 7, perspective: 0.22, fill: 0.86, lighting: 0.22, blur: 0.7, noise: 2 },
  { name: 'photo-04-dim', seed: 1004, description: 'dim room, strong lighting falloff', rotationDeg: -2.5, perspective: 0.08, fill: 0.88, lighting: 0.45, blur: 0.8, noise: 3 },
  { name: 'photo-05-shadowed', seed: 1005, description: 'photographer shadow across one side', rotationDeg: 3, perspective: 0.14, fill: 0.87, lighting: 0.38, blur: 0.7, noise: 2.5 },
  { name: 'photo-06-rotated90', seed: 1006, description: 'sheet turned on its side in frame', rotationDeg: 90, perspective: 0.06, fill: 0.62, lighting: 0.15, blur: 0.6, noise: 2 },
  { name: 'photo-07-upsidedown', seed: 1007, description: 'sheet upside down — orientation comes from the marker ids', rotationDeg: 178, perspective: 0.09, fill: 0.88, lighting: 0.2, blur: 0.6, noise: 2 },
  { name: 'photo-08-blurry', seed: 1008, description: 'soft focus, handheld', rotationDeg: -6, perspective: 0.12, fill: 0.87, lighting: 0.2, blur: 2.1, noise: 2.5 },
  { name: 'photo-09-far', seed: 1009, description: 'shot from too far away — small in frame', rotationDeg: 4.5, perspective: 0.1, fill: 0.62, lighting: 0.18, blur: 0.6, noise: 2 },
  { name: 'photo-10-harsh', seed: 1010, description: 'harsh directional light plus heavy vignette', rotationDeg: -8, perspective: 0.18, fill: 0.85, lighting: 0.55, blur: 0.9, noise: 3 },
  { name: 'photo-11-occluded', seed: 1011, description: 'FAILURE CASE: a thumb covers the bottom-left marker', rotationDeg: 2, perspective: 0.1, fill: 0.88, lighting: 0.2, blur: 0.7, noise: 2, occludeMarker: 3 },
];

/** Fixtures that must produce a golden. */
export const GOLDEN_FIXTURES = FIXTURE_SPECS.filter((f) => f.occludeMarker === undefined);

/**
 * The bar a fixture's texture must clear against its golden.
 *
 * Measured over this set the pipeline scores 0.908–0.953; the ~5% shortfall is
 * irreducible, since a golden is an ideal deskew of a clean 8 px/mm sheet
 * while a fixture is a noisy, blurred, unevenly-lit resample of one (the
 * golden itself only scores 0.965 against a warp-free render of the same
 * drawing). 0.88 sits ~3 points below the worst observed run — headroom for
 * floating-point drift across platforms — and still fails everything that
 * matters: a texture built from a different photo scores 0.870, an 8px quad
 * shift 0.853, a 90°-rotated corner order 0.806.
 *
 * SSIM is deliberately blunt about 1–2 px shifts, so it is NOT the geometry
 * check; `MAX_CORNER_ERROR_PX` in the test suite is. See the header of
 * `test/pipeline.test.mjs`.
 */
export const GOLDEN_SSIM_THRESHOLD = 0.88;

// ── Sheet ──────────────────────────────────────────────────────────────────

/** Where the drawing lives on the printed sheet, in page mm. */
export function guideBoxMm(): { x: number; y: number; size: number } {
  const l = computeLayout();
  return l.guide;
}

/** The drawable quad's corners in sheet pixels, clockwise from top-left. */
export function sheetQuad(pxPerMm: number): Quad {
  const l = computeLayout();
  const { x, y, size } = l.quad;
  return [
    { x: x * pxPerMm, y: y * pxPerMm },
    { x: (x + size) * pxPerMm, y: y * pxPerMm },
    { x: (x + size) * pxPerMm, y: (y + size) * pxPerMm },
    { x: x * pxPerMm, y: (y + size) * pxPerMm },
  ];
}

/** Rasterizes the template and composites the seeded drawing into its guide box. */
export function renderFilledSheet(seed: number, pxPerMm = SHEET_PX_PER_MM): ImageDataLike {
  const sheet = rasterizeTemplate(pxPerMm);
  const guide = guideBoxMm();
  const map: DrawMapping = {
    originX: guide.x * pxPerMm,
    originY: guide.y * pxPerMm,
    scale: guide.size * pxPerMm,
  };
  drawStrokes(sheet, createDrawing(seed), map);
  return sheet;
}

/**
 * The same drawing rendered DIRECTLY into texture space — no warp, no photo,
 * no cleanup. This is the independent ground truth the goldens are checked
 * against, and it is the reason a bug in the homography code cannot hide by
 * corrupting the golden and the result equally.
 *
 * The drawing box is `TEXTURE_SAFE_AREA`, which is the printed guide box by
 * construction (both are `safeAreaInset` inside the drawable quad).
 */
export function renderDrawingTexture(seed: number): ImageDataLike {
  const img = createFilledImage(TEXTURE.width, TEXTURE.height, 255);
  drawStrokes(img, createDrawing(seed), {
    originX: TEXTURE_SAFE_AREA.x,
    originY: TEXTURE_SAFE_AREA.y,
    scale: TEXTURE_SAFE_AREA.width,
  });
  return img;
}

/**
 * The golden: an ideal deskew of the undistorted sheet using the quad's
 * ANALYTIC corners (from the frozen template layout), then the same cleanup
 * pass a real photo gets. No detection involved — the golden answers "what
 * should this drawing look like as a texture", not "what did the detector
 * do".
 */
export function renderGoldenTexture(seed: number, pxPerMm = SHEET_PX_PER_MM): ImageDataLike {
  const sheet = renderFilledSheet(seed, pxPerMm);
  const raw = warpQuadToTexture(sheet, sheetQuad(pxPerMm), TEXTURE_DEST_POINTS, {
    width: TEXTURE.width,
    height: TEXTURE.height,
    supersample: 'auto',
  });
  // Same two cleanup steps `processPhoto` runs, in the same order — a golden
  // is "the ideal output of the pipeline", not "the ideal warp".
  return clearTemplateMargin(cleanupLevels(raw), TEXTURE_SAFE_AREA);
}

// ── Photo synthesis ────────────────────────────────────────────────────────

/** Pads the sheet with a "desk" surround so the warp has something to show. */
function onDesk(sheet: ImageDataLike, rng: () => number): { image: ImageDataLike; offsetX: number; offsetY: number } {
  const margin = Math.round(Math.max(sheet.width, sheet.height) * 0.22);
  const width = sheet.width + margin * 2;
  const height = sheet.height + margin * 2;
  const base = 96 + Math.round(rng() * 60);
  const img = createFilledImage(width, height, base);
  // Give the desk a slight wood-ish tint and a coarse grain.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const grain = Math.sin(y * 0.11 + Math.sin(x * 0.017) * 2) * 6;
      img.data[i] = (img.data[i] as number) + 18 + grain;
      img.data[i + 1] = (img.data[i + 1] as number) + 6 + grain;
      img.data[i + 2] = (img.data[i + 2] as number) - 6 + grain;
    }
  }
  // Composite the sheet, with a soft drop shadow so its edge reads as an edge.
  for (let y = 0; y < sheet.height; y++) {
    for (let x = 0; x < sheet.width; x++) {
      const s = (y * sheet.width + x) * 4;
      const d = ((y + margin) * width + (x + margin)) * 4;
      img.data[d] = sheet.data[s] as number;
      img.data[d + 1] = sheet.data[s + 1] as number;
      img.data[d + 2] = sheet.data[s + 2] as number;
      img.data[d + 3] = 255;
    }
  }
  return { image: img, offsetX: margin, offsetY: margin };
}

/** Paints an opaque, soft-edged "thumb" over a marker, for the failure fixture. */
function occlude(img: ImageDataLike, centre: Point, radius: number): void {
  const x0 = Math.max(0, Math.floor(centre.x - radius));
  const x1 = Math.min(img.width - 1, Math.ceil(centre.x + radius));
  const y0 = Math.max(0, Math.floor(centre.y - radius));
  const y1 = Math.min(img.height - 1, Math.ceil(centre.y + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - centre.x, y - centre.y) / radius;
      if (d > 1) continue;
      const a = Math.min(1, (1 - d) * 4);
      const i = (y * img.width + x) * 4;
      img.data[i] = (img.data[i] as number) * (1 - a) + 196 * a;
      img.data[i + 1] = (img.data[i + 1] as number) * (1 - a) + 150 * a;
      img.data[i + 2] = (img.data[i + 2] as number) * (1 - a) + 132 * a;
    }
  }
}

/** Separable box blur repeated 3× — a good-enough Gaussian. */
function blurImage(img: ImageDataLike, radius: number): ImageDataLike {
  const r = Math.round(radius);
  if (r < 1) return img;
  let src = img;
  for (let pass = 0; pass < 3; pass++) {
    const tmp = cloneImage(src);
    // Horizontal.
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        let sr = 0, sg = 0, sb = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = Math.min(src.width - 1, Math.max(0, x + k));
          const i = (y * src.width + xx) * 4;
          sr += src.data[i] as number;
          sg += src.data[i + 1] as number;
          sb += src.data[i + 2] as number;
          n++;
        }
        const o = (y * src.width + x) * 4;
        tmp.data[o] = sr / n;
        tmp.data[o + 1] = sg / n;
        tmp.data[o + 2] = sb / n;
      }
    }
    const out = cloneImage(tmp);
    // Vertical.
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        let sr = 0, sg = 0, sb = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = Math.min(src.height - 1, Math.max(0, y + k));
          const i = (yy * src.width + x) * 4;
          sr += tmp.data[i] as number;
          sg += tmp.data[i + 1] as number;
          sb += tmp.data[i + 2] as number;
          n++;
        }
        const o = (y * src.width + x) * 4;
        out.data[o] = sr / n;
        out.data[o + 1] = sg / n;
        out.data[o + 2] = sb / n;
      }
    }
    src = out;
  }
  return src;
}

/** Box–Muller, driven by the seeded RNG so noise is reproducible. */
function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Camera grain: Gaussian noise generated at half resolution and bilinearly
 * upsampled.
 *
 * This is both more realistic and dramatically cheaper to store than
 * independent per-pixel noise. Real sensor noise is spatially correlated by
 * demosaicing and then by JPEG, so it comes out as grain rather than
 * dust — and grain is what PNG's predictive filters can compress. Measured on
 * fixture 01: white noise at σ=2 → 3.1 MB; grain at the same σ → ~0.9 MB,
 * with detection difficulty unchanged.
 */
function grainField(width: number, height: number, sigma: number, rng: () => number): Float32Array {
  const gw = Math.ceil(width / 2) + 1;
  const gh = Math.ceil(height / 2) + 1;
  const coarse = new Float32Array(gw * gh);
  for (let i = 0; i < coarse.length; i++) coarse[i] = gaussian(rng) * sigma;

  const field = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const fy = y / 2;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    const y1 = Math.min(gh - 1, y0 + 1);
    for (let x = 0; x < width; x++) {
      const fx = x / 2;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const x1 = Math.min(gw - 1, x0 + 1);
      const a = coarse[y0 * gw + x0] as number;
      const b = coarse[y0 * gw + x1] as number;
      const c = coarse[y1 * gw + x0] as number;
      const d = coarse[y1 * gw + x1] as number;
      field[y * width + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return field;
}

export interface Fixture {
  spec: FixtureSpec;
  photo: ImageDataLike;
  /** Where the drawable quad ended up in the photo — the detector's answer key. */
  trueQuad: Quad;
}

/** Renders one fixture photo. Deterministic in `spec.seed`. */
export function generateFixture(spec: FixtureSpec, pxPerMm = SHEET_PX_PER_MM): Fixture {
  const rng = createRng(spec.seed);
  const sheet = renderFilledSheet(spec.seed, pxPerMm);
  const { image: desk, offsetX, offsetY } = onDesk(sheet, rng);

  // ── Geometry: where the sheet's four page corners land in the photo ──────
  const cx = PHOTO_WIDTH / 2;
  const cy = PHOTO_HEIGHT / 2;
  const theta = (spec.rotationDeg * Math.PI) / 180;
  // Scale so the sheet's LONG side spans `fill` of the frame's long side once
  // rotated. For the 90°-rotated fixture that means fitting across the width.
  const sheetW = sheet.width;
  const sheetH = sheet.height;
  const rotatedW = Math.abs(sheetW * Math.cos(theta)) + Math.abs(sheetH * Math.sin(theta));
  const rotatedH = Math.abs(sheetW * Math.sin(theta)) + Math.abs(sheetH * Math.cos(theta));
  const scale = Math.min((PHOTO_WIDTH * spec.fill) / rotatedW, (PHOTO_HEIGHT * spec.fill) / rotatedH);

  // Four page corners, rotated about the frame centre, then pushed by a
  // seeded perspective: one edge is moved closer to the camera than the other.
  const halfW = (sheetW * scale) / 2;
  const halfH = (sheetH * scale) / 2;
  const local: Point[] = [
    { x: -halfW, y: -halfH },
    { x: halfW, y: -halfH },
    { x: halfW, y: halfH },
    { x: -halfW, y: halfH },
  ];
  const tiltAxis = rng() * Math.PI * 2;
  const dest: Point[] = local.map((p) => {
    // Perspective: shrink the corners on the far side of a random axis.
    const along = (p.x * Math.cos(tiltAxis) + p.y * Math.sin(tiltAxis)) / Math.max(halfW, halfH);
    const k = 1 - spec.perspective * along;
    const rx = p.x * k;
    const ry = p.y * k;
    const jitterX = (rng() - 0.5) * 0.02 * halfW;
    const jitterY = (rng() - 0.5) * 0.02 * halfH;
    return {
      x: cx + (rx * Math.cos(theta) - ry * Math.sin(theta)) + jitterX,
      y: cy + (rx * Math.sin(theta) + ry * Math.cos(theta)) + jitterY,
    };
  });

  const deskCorners: Point[] = [
    { x: offsetX, y: offsetY },
    { x: offsetX + sheetW, y: offsetY },
    { x: offsetX + sheetW, y: offsetY + sheetH },
    { x: offsetX, y: offsetY + sheetH },
  ];
  const h = getPerspectiveTransform(deskCorners, dest);

  let photo = warpPerspective(desk, h, {
    width: PHOTO_WIDTH,
    height: PHOTO_HEIGHT,
    supersample: 2,
  });

  // Where the drawable quad now sits — used by the tests as the answer key.
  const quadInDesk = sheetQuad(pxPerMm).map((p) => ({ x: p.x + offsetX, y: p.y + offsetY }));
  const trueQuad = quadInDesk.map((p) => {
    const w = (h[6] as number) * p.x + (h[7] as number) * p.y + (h[8] as number);
    return {
      x: ((h[0] as number) * p.x + (h[1] as number) * p.y + (h[2] as number)) / w,
      y: ((h[3] as number) * p.x + (h[4] as number) * p.y + (h[5] as number)) / w,
    };
  }) as unknown as Quad;

  // ── Occlusion (failure fixture) ─────────────────────────────────────────
  if (spec.occludeMarker !== undefined) {
    const l = computeLayout();
    const m = l.markers.find((mk) => mk.id === spec.occludeMarker);
    if (m) {
      const centreDesk = {
        x: (m.x + m.size / 2) * pxPerMm + offsetX,
        y: (m.y + m.size / 2) * pxPerMm + offsetY,
      };
      const w = (h[6] as number) * centreDesk.x + (h[7] as number) * centreDesk.y + (h[8] as number);
      const centre = {
        x: ((h[0] as number) * centreDesk.x + (h[1] as number) * centreDesk.y + (h[2] as number)) / w,
        y: ((h[3] as number) * centreDesk.x + (h[4] as number) * centreDesk.y + (h[5] as number)) / w,
      };
      const q = trueQuad as readonly Point[];
      const quadEdge = Math.hypot((q[1] as Point).x - (q[0] as Point).x, (q[1] as Point).y - (q[0] as Point).y);
      occlude(photo, centre, quadEdge * 0.1);
    }
  }

  // ── Lighting: a directional gradient plus a vignette ─────────────────────
  const lightAngle = rng() * Math.PI * 2;
  const lx = Math.cos(lightAngle);
  const ly = Math.sin(lightAngle);
  const cast = 1 + (rng() - 0.5) * 0.06; // warm/cool paper cast
  for (let y = 0; y < PHOTO_HEIGHT; y++) {
    const ny = (y / PHOTO_HEIGHT) * 2 - 1;
    for (let x = 0; x < PHOTO_WIDTH; x++) {
      const nx = (x / PHOTO_WIDTH) * 2 - 1;
      const directional = 1 - spec.lighting * ((nx * lx + ny * ly) * 0.5 + 0.5);
      const vignette = 1 - spec.lighting * 0.45 * Math.min(1, (nx * nx + ny * ny) / 2);
      const gain = directional * vignette;
      const i = (y * PHOTO_WIDTH + x) * 4;
      photo.data[i] = (photo.data[i] as number) * gain * cast;
      photo.data[i + 1] = (photo.data[i + 1] as number) * gain;
      photo.data[i + 2] = (photo.data[i + 2] as number) * gain * (2 - cast);
    }
  }

  // ── Optics then sensor ──────────────────────────────────────────────────
  photo = blurImage(photo, spec.blur);
  if (spec.noise > 0) {
    // Two grain fields: a shared luma one and a weaker chroma one, so the
    // noise is coloured the way a real sensor's is.
    const luma = grainField(PHOTO_WIDTH, PHOTO_HEIGHT, spec.noise, rng);
    const chroma = grainField(PHOTO_WIDTH, PHOTO_HEIGHT, spec.noise * 0.4, rng);
    for (let p = 0, i = 0; p < luma.length; p++, i += 4) {
      const n = luma[p] as number;
      const c = chroma[p] as number;
      photo.data[i] = (photo.data[i] as number) + n + c;
      photo.data[i + 1] = (photo.data[i + 1] as number) + n;
      photo.data[i + 2] = (photo.data[i + 2] as number) + n - c;
      photo.data[i + 3] = 255;
    }
  }

  if (PHOTO_QUANTIZE > 1) {
    for (let i = 0; i < photo.data.length; i += 4) {
      photo.data[i] = Math.round((photo.data[i] as number) / PHOTO_QUANTIZE) * PHOTO_QUANTIZE;
      photo.data[i + 1] = Math.round((photo.data[i + 1] as number) / PHOTO_QUANTIZE) * PHOTO_QUANTIZE;
      photo.data[i + 2] = Math.round((photo.data[i + 2] as number) / PHOTO_QUANTIZE) * PHOTO_QUANTIZE;
      photo.data[i + 3] = 255;
    }
  }

  return { spec, photo, trueQuad };
}

/** Mean absolute luminance difference between two same-sized images, 0–255. */
export function meanAbsoluteDifference(a: ImageDataLike, b: ImageDataLike): number {
  if (a.width !== b.width || a.height !== b.height) throw new RangeError('size mismatch');
  let sum = 0;
  const n = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    const la = luminance(a.data[i] as number, a.data[i + 1] as number, a.data[i + 2] as number);
    const lb = luminance(b.data[i] as number, b.data[i + 1] as number, b.data[i + 2] as number);
    sum += Math.abs(la - lb);
  }
  return sum / n;
}

export type { Stroke };
export { TEMPLATE_MM };
