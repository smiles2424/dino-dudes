/**
 * `@dino/pipeline` — WS-A. Wave 1 ships the template generator; Wave 2A adds
 * marker detection (js-aruco2) and the OpenCV.js perspective warp.
 */
export { DICT_4X4_50_SIZE, markerBits, markerGrid } from './aruco.js';
export {
  computeLayout,
  renderTemplatePdf,
  renderTemplateSvg,
  type MarkerPlacement,
  type TemplateLayout,
  type TemplateOptions,
} from './template.js';
export { buildPdf, type PdfDocument, type PdfOp } from './pdf.js';
export { rasterizeTemplate, type RasterImage } from './rasterize.js';
