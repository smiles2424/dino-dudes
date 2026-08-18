/**
 * `@dino/pipeline` — WS-A.
 *
 * Wave 1 shipped the template generator. Wave 2A adds the other direction:
 * photo → canonical texture, via js-aruco2 detection and a perspective warp.
 *
 * ── Everything exported here is ISOMORPHIC ─────────────────────────────────
 * Nothing on this entry point imports a Node builtin, so `apps/web` can import
 * it directly and run the whole pipeline in the browser (Wave 4). The Node-only
 * bits — PNG encode/decode and writing fixtures/goldens to disk — live behind
 * `@dino/pipeline/node`.
 *
 * Typical browser use is documented on `processPhoto` in `process.ts`.
 */

// ── Photo → texture (Wave 2A) ──────────────────────────────────────────────
export { processPhoto, QUAD_ORDER, SAFE_AREA, type ProcessOptions, type ProcessResult } from './process.js';
export {
  detectDrawableQuad,
  quadGeometryQuality,
  MIN_SOURCE_DIMENSION,
  type DetectOptions,
  type DetectedMarker,
  type DetectionResult,
} from './detect.js';
export { PipelineError, buildCornerDiagnostics } from './errors.js';
export {
  cleanupLevels,
  clearTemplateMargin,
  estimateIlluminationField,
  meanLuminance,
  sharpness,
  DEFAULT_LEVELS,
  MARGIN_OVERRUN_PX,
  type LevelsOptions,
} from './levels.js';
export {
  autoSupersample,
  warpPerspective,
  warpQuadToTexture,
  type WarpOptions,
} from './warp.js';
export {
  applyHomography,
  getPerspectiveTransform,
  invertHomography,
  isConvexQuad,
  signedArea,
  type Homography,
} from './homography.js';
export { ssim, ssimDetailed, type SsimResult } from './ssim.js';
export {
  clampedIndex,
  cloneImage,
  createFilledImage,
  createImage,
  luminance,
  sampleBilinear,
  toLuminancePlane,
  type ImageDataLike,
  type Point,
  type Quad,
} from './image.js';

// ── Synthetic fixtures (Wave 2A) ───────────────────────────────────────────
export {
  FIXTURE_SPECS,
  GOLDEN_FIXTURES,
  GOLDEN_SSIM_THRESHOLD,
  PHOTO_QUANTIZE,
  PHOTO_HEIGHT,
  PHOTO_WIDTH,
  SHEET_PX_PER_MM,
  generateFixture,
  guideBoxMm,
  meanAbsoluteDifference,
  renderDrawingTexture,
  renderFilledSheet,
  renderGoldenTexture,
  sheetQuad,
  type Fixture,
  type FixtureSpec,
} from './synth.js';
export { createDrawing, createRng, drawStroke, drawStrokes, type DrawMapping, type Stroke } from './draw.js';

// ── Template generator (Wave 1) ────────────────────────────────────────────
export { DICT_4X4_50_SIZE, createDetector, markerBits, markerGrid } from './aruco.js';
export {
  computeLayout,
  renderTemplatePdf,
  renderTemplateSvg,
  type MarkerPlacement,
  type TemplateLayout,
  type TemplateOptions,
} from './template.js';
export { buildPdf, type PdfDocument, type PdfOp } from './pdf.js';
export { rasterizeTemplate, type RasterImage, type RasterizeOptions } from './rasterize.js';
