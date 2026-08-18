/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TEXTURE SPEC — FROZEN CONTRACT (Wave 1)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The interface between three modules:
 *   • WS-A `packages/pipeline` — generates the printable template AND deskews
 *     photos of it into the canonical texture.
 *   • WS-C `apps/web` / `assets/models` — the dino GLB's UV unwrap must lay out
 *     the dino's flanks inside this texture's SAFE AREA.
 *   • WS-B `apps/server` — validates uploaded textures against these dimensions.
 *
 * Additive changes only. Any change to a dimension here invalidates printed
 * templates, goldens, and UV unwraps — propose it in PLAN.md's Progress Log.
 *
 * ── The physical → digital mapping ─────────────────────────────────────────
 *
 *   A4 portrait sheet, four ArUco 4x4_50 markers, one per corner, IDs 0–3
 *   clockwise from top-left. Each marker's INNER corner (the corner nearest the
 *   sheet's centre) is a corner of the DRAWABLE QUAD. The drawable quad is
 *   square and maps 1:1 onto the 1024×1024 texture:
 *
 *      id 0 inner corner ─────────────── id 1 inner corner
 *      (0, 0) in texture                 (1024, 0) in texture
 *          ┌───────────────────────────────────┐
 *          │  ┌ ─ ─ ─ ─ ─ safe area ─ ─ ─ ─ ┐  │   ← 10 mm / 64 px inset;
 *          │  │                             │  │     drawings live in here so
 *          │  │      the drawing goes       │  │     they never encroach on a
 *          │  │           in here           │  │     marker's quiet zone
 *          │  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │
 *          └───────────────────────────────────┘
 *      id 3 inner corner                 id 2 inner corner
 *      (0, 1024) in texture              (1024, 1024) in texture
 *
 *   Distinct marker IDs give orientation for free: whichever way the photo is
 *   rotated, id 0 is always texture-space top-left.
 */

/** Canonical texture raster. */
export const TEXTURE = {
  width: 1024,
  height: 1024,
  /** Only `image/png` is accepted by the API. */
  mimeType: 'image/png',
  /** Generous ceiling for a 1024² PNG; the API rejects anything larger. */
  maxBytes: 2 * 1024 * 1024,
} as const;

/** ArUco fiducials. `4x4_50` == OpenCV `DICT_4X4_50` == first 50 codes of `ARUCO_4X4_1000`. */
export const MARKERS = {
  /** Human/spec name. */
  dictionary: '4x4_50',
  /** The dictionary key inside js-aruco2 (`AR.DICTIONARIES`). IDs 0–49 of it are 4x4_50. */
  jsAruco2Dictionary: 'ARUCO_4X4_1000',
  /** Data cells per side (excludes the 1-cell black border). */
  gridSize: 4,
  /** Total cells per side including the mandatory 1-cell black border. */
  cellsWithBorder: 6,
  /**
   * Corner assignment. The order is clockwise starting at top-left, and it is
   * the same order used for the perspective transform's source points.
   */
  ids: {
    topLeft: 0,
    topRight: 1,
    bottomRight: 2,
    bottomLeft: 3,
  },
  /** Clockwise from top-left — the canonical iteration order. */
  order: [0, 1, 2, 3],
  /**
   * How to pick a detected marker's "inner" corner: of the marker's four
   * corners, take the one closest to the centroid of all four marker centres.
   * Robust under any rotation/perspective, no orientation heuristics needed.
   */
  innerCornerRule: 'nearest-to-centroid-of-marker-centres',
} as const;

/** Printed sheet geometry, in millimetres. A4 portrait. */
export const TEMPLATE_MM = {
  page: { width: 210, height: 297 },
  /** Outer side length of one marker, i.e. the 6-cell block including its black border. */
  markerSize: 18,
  /** Mandatory white margin around each marker so detection works. */
  markerQuietZone: 3,
  /** Side length of the square drawable quad (marker inner corner → marker inner corner). */
  drawableQuad: 160,
  /** Inset from the quad edge to the printed "draw inside here" guide box. */
  safeAreaInset: 10,
  /** Top-left of the content block (markers + quad) on the page. */
  contentOrigin: { x: 7, y: 46 },
} as const;

/** Derived page coordinates (mm) of the drawable quad's corners, clockwise from top-left. */
export const TEMPLATE_QUAD_MM = {
  x: TEMPLATE_MM.contentOrigin.x + TEMPLATE_MM.markerSize,
  y: TEMPLATE_MM.contentOrigin.y + TEMPLATE_MM.markerSize,
  size: TEMPLATE_MM.drawableQuad,
} as const;

/**
 * Safe area in texture pixels — the region the dino's UV unwrap must stay
 * inside. 10 mm of a 160 mm quad == 64 px of 1024 px.
 */
const SAFE_INSET_PX = Math.round(
  (TEMPLATE_MM.safeAreaInset / TEMPLATE_MM.drawableQuad) * TEXTURE.width,
);

export const TEXTURE_SAFE_AREA = {
  inset: SAFE_INSET_PX,
  x: SAFE_INSET_PX,
  y: SAFE_INSET_PX,
  width: TEXTURE.width - SAFE_INSET_PX * 2,
  height: TEXTURE.height - SAFE_INSET_PX * 2,
} as const;

/**
 * Destination points for `getPerspectiveTransform`, in texture pixel space,
 * clockwise from top-left — index i corresponds to `MARKERS.order[i]`.
 */
export const TEXTURE_DEST_POINTS: readonly (readonly [number, number])[] = [
  [0, 0],
  [TEXTURE.width, 0],
  [TEXTURE.width, TEXTURE.height],
  [0, TEXTURE.height],
] as const;

/** Effective print resolution of the drawable area, for reference. */
export const TEXTURE_PIXELS_PER_MM = TEXTURE.width / TEMPLATE_MM.drawableQuad;

/** Everything above, bundled. `version` bumps only on a breaking change. */
export const TEXTURE_SPEC = {
  version: 1,
  texture: TEXTURE,
  markers: MARKERS,
  templateMm: TEMPLATE_MM,
  quadMm: TEMPLATE_QUAD_MM,
  safeArea: TEXTURE_SAFE_AREA,
  destPoints: TEXTURE_DEST_POINTS,
  pixelsPerMm: TEXTURE_PIXELS_PER_MM,
} as const;

/** Dino models available in v1. `modelSlug` values are drawn from this list. */
export const MODEL_SLUGS = ['trex', 'stego', 'raptor', 'bronto'] as const;
export type ModelSlug = (typeof MODEL_SLUGS)[number];
