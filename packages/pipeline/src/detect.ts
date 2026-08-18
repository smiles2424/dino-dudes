/**
 * Step 1 of the pipeline: find the four corner markers in a photo and turn
 * them into the drawable quad.
 *
 * ── The inner-corner rule ──────────────────────────────────────────────────
 * Which corner of a marker is a corner of the drawable quad? The spec freezes
 * it as `MARKERS.innerCornerRule`: *the marker corner nearest the centroid of
 * all four marker centres*. That rule needs no orientation heuristics — it is
 * invariant under rotation, mirroring and perspective, because the four
 * markers always straddle the quad and their centroid always lands inside it.
 * Fixture `photo-07-upsidedown` exists to prove exactly that.
 *
 * ── The retry ladder ───────────────────────────────────────────────────────
 * A single js-aruco2 pass over the raw photo finds all four markers in good
 * light and nothing else. Real photos are not good light. Measured against the
 * synthetic fixture set, one raw pass finds all four markers in 8 of 10; the
 * two failures are a dim/shadowed sheet and a soft-focus one, and they are
 * rescued by two cheap extra passes:
 *
 *   1. `raw`             — the photo as given. Best corner precision.
 *   2. `normalized`      — the same flat-field + levels cleanup the texture
 *                          gets, run BEFORE detection. Kills lighting
 *                          gradients, which is what defeats the adaptive
 *                          threshold on dim and harshly-lit sheets.
 *   3. `halfNormalized`  — normalized and box-downscaled 2×. js-aruco2's
 *                          adaptive threshold uses a fixed 7-pixel window; on
 *                          a large, slightly out-of-focus photo the marker
 *                          edges are softer than that window, and halving the
 *                          resolution brings them back into range.
 *
 * Passes run in order and stop as soon as all four are found; a marker already
 * located by an earlier pass keeps that pass's (more precise) corners.
 *
 * Isomorphic: no Node builtins on this path.
 */
import { MARKERS, TEXTURE, type CornerName } from '@dino/shared';
import { createDetector } from './aruco.js';
import { pipelineError, PipelineError } from './errors.js';
import { isConvexQuad, signedArea } from './homography.js';
import { downscaleImage, type ImageDataLike, type Point, type Quad } from './image.js';
import { cleanupLevels } from './levels.js';

/** Smallest photo we will even try. Below this, markers are a few pixels wide. */
export const MIN_SOURCE_DIMENSION = 320;

export type DetectPass = 'raw' | 'normalized' | 'halfNormalized';

export const DEFAULT_PASSES: readonly DetectPass[] = ['raw', 'normalized', 'halfNormalized'];

/**
 * Cleanup settings used to normalise a photo *for detection*. Same flat-field
 * as the texture pass, but with the paper knockout disabled (256 is
 * unreachable): snapping near-white to pure white would erase the soft grey
 * ramp at a marker's edge that the contour finder needs.
 */
const DETECTION_LEVELS = { fieldGrid: 16, paperKnockout: 256 } as const;

export interface DetectedMarker {
  id: number;
  corner: CornerName;
  /** The marker's four polygon corners in SOURCE-image pixels, clockwise. */
  polygon: Point[];
  centre: Point;
  /** The corner of `polygon` nearest the centroid of all marker centres. */
  innerCorner: Point;
  /** Which ladder pass located this marker. */
  pass: DetectPass;
}

export interface DetectionResult {
  /** Exactly the spec's ids 0–3, in `MARKERS.order`. */
  markers: DetectedMarker[];
  /** Inner corners in `MARKERS.order`, i.e. clockwise from texture top-left. */
  quad: Quad;
  /** Every marker id seen, ascending, including ids outside the spec. */
  detectedMarkerIds: number[];
  /** Ladder passes actually run. Length > 1 means the photo was marginal. */
  passesUsed: DetectPass[];
}

export interface DetectOptions {
  /** Passed to js-aruco2. 0 (exact match only) is the default and the spec. */
  maxHammingDistance?: number;
  /** Override the retry ladder — e.g. `['raw']` for a fast preview path. */
  passes?: readonly DetectPass[];
}

const centroidOf = (points: readonly Point[]): Point => ({
  x: points.reduce((s, p) => s + p.x, 0) / points.length,
  y: points.reduce((s, p) => s + p.y, 0) / points.length,
});

interface Candidate {
  polygon: Point[];
  centre: Point;
  area: number;
  pass: DetectPass;
}

function makeCandidate(corners: readonly Point[], scale: number, pass: DetectPass): Candidate {
  const polygon = corners.map((c) => ({ x: c.x * scale, y: c.y * scale }));
  return { polygon, centre: centroidOf(polygon), area: Math.abs(signedArea(polygon)), pass };
}

/** Builds the working image for a ladder pass, plus the scale back to source px. */
function preparePass(image: ImageDataLike, pass: DetectPass): { image: ImageDataLike; scale: number } {
  switch (pass) {
    case 'raw':
      return { image, scale: 1 };
    case 'normalized':
      return { image: cleanupLevels(image, DETECTION_LEVELS), scale: 1 };
    case 'halfNormalized':
      return { image: downscaleImage(cleanupLevels(image, DETECTION_LEVELS), 2), scale: 2 };
  }
}

/**
 * Runs the ladder. Returns the best candidate per spec id, every id seen, and
 * any id that was found TWICE IN ONE PASS at genuinely different places —
 * which means two sheets (or a reflection) are in frame.
 *
 * js-aruco2 routinely reports the same physical marker twice (the outer and
 * inner edge of its black border show up as separate contours). Those are
 * merged, keeping the larger polygon, because the printed geometry defines the
 * quad corner as a corner of the marker's OUTER square.
 */
function runLadder(
  image: ImageDataLike,
  options: DetectOptions,
): { best: Map<number, Candidate>; allIds: number[]; conflicts: Set<number>; passesUsed: DetectPass[] } {
  const detector = createDetector(options.maxHammingDistance ?? 0);
  const wanted = new Set<number>(MARKERS.order);
  const best = new Map<number, Candidate>();
  const allIds = new Set<number>();
  const conflicts = new Set<number>();
  const passesUsed: DetectPass[] = [];

  for (const pass of options.passes ?? DEFAULT_PASSES) {
    passesUsed.push(pass);
    const prepared = preparePass(image, pass);
    const found = detector.detectImage(prepared.image.width, prepared.image.height, prepared.image.data);

    // Group this pass's sightings by id first, so "same marker seen twice" and
    // "two different markers with the same id" can be told apart.
    const thisPass = new Map<number, Candidate[]>();
    for (const m of found) {
      allIds.add(m.id);
      if (!wanted.has(m.id)) continue;
      const candidate = makeCandidate(m.corners, prepared.scale, pass);
      const list = thisPass.get(m.id);
      if (list) list.push(candidate);
      else thisPass.set(m.id, [candidate]);
    }

    for (const [id, candidates] of thisPass) {
      // Sort largest first; the outer contour of the black border is the one
      // whose corners are the printed marker's corners.
      candidates.sort((a, b) => b.area - a.area);
      const primary = candidates[0] as Candidate;
      const markerSize = Math.sqrt(primary.area);
      for (const other of candidates.slice(1)) {
        const gap = Math.hypot(other.centre.x - primary.centre.x, other.centre.y - primary.centre.y);
        if (gap > markerSize) conflicts.add(id);
      }
      // An earlier (higher-precision) pass wins.
      if (!best.has(id)) best.set(id, primary);
    }

    if (best.size === wanted.size) break;
  }

  return { best, allIds: [...allIds].sort((a, b) => a - b), conflicts, passesUsed };
}

/**
 * Detects the four spec markers and extracts the drawable quad.
 *
 * @throws {PipelineError} — always carrying a four-entry per-corner diagnostic.
 */
export function detectDrawableQuad(
  image: ImageDataLike,
  options: DetectOptions = {},
): DetectionResult {
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0 ||
    image.data.length !== image.width * image.height * 4
  ) {
    throw pipelineError('image_invalid', 'The image is not a valid RGBA raster.', new Map(), []);
  }
  if (Math.min(image.width, image.height) < MIN_SOURCE_DIMENSION) {
    throw pipelineError(
      'image_too_small',
      `The photo is only ${image.width}x${image.height}; at least ${MIN_SOURCE_DIMENSION}px on the short side is needed.`,
      new Map(),
      [],
    );
  }

  const { best, allIds, conflicts, passesUsed } = runLadder(image, options);

  // The inner-corner rule needs the centroid of the marker centres, so it can
  // only be evaluated once we know which markers we have.
  const innerCorners = new Map<number, Point>();
  if (best.size > 0) {
    const centroid = centroidOf([...best.values()].map((c) => c.centre));
    for (const [id, candidate] of best) {
      let chosen = candidate.polygon[0] as Point;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const p of candidate.polygon) {
        const d = (p.x - centroid.x) ** 2 + (p.y - centroid.y) ** 2;
        if (d < bestDist) {
          bestDist = d;
          chosen = p;
        }
      }
      innerCorners.set(id, chosen);
    }
  }

  if (conflicts.size > 0) {
    throw pipelineError(
      'markers_duplicated',
      `Corner marker ${[...conflicts].sort((a, b) => a - b).join(', ')} appears more than once — make sure only one template sheet is in the photo.`,
      innerCorners,
      allIds,
    );
  }
  if (best.size === 0) {
    throw pipelineError(
      'markers_not_found',
      'No template corner squares were found. Make sure the whole printed sheet is in the photo and in focus.',
      innerCorners,
      allIds,
    );
  }
  if (best.size < MARKERS.order.length) {
    throw pipelineError(
      'markers_incomplete',
      `Only ${best.size} of ${MARKERS.order.length} corner squares were found.`,
      innerCorners,
      allIds,
    );
  }

  const quadPoints = MARKERS.order.map((id) => innerCorners.get(id) as Point);
  const quad = quadPoints as unknown as Quad;

  // A photo of a flat sheet always yields a convex, non-trivial quad. Anything
  // else means the detector latched onto something that isn't our template.
  const area = Math.abs(signedArea(quadPoints));
  if (!isConvexQuad(quadPoints) || area < image.width * image.height * 1e-4) {
    throw pipelineError(
      'quad_degenerate',
      'The four corner squares do not form a plausible sheet outline. Re-shoot the whole sheet flat.',
      innerCorners,
      allIds,
    );
  }

  const markers: DetectedMarker[] = MARKERS.order.map((id) => {
    const candidate = best.get(id) as Candidate;
    return {
      id,
      corner: cornerNameFor(id),
      polygon: candidate.polygon,
      centre: candidate.centre,
      innerCorner: innerCorners.get(id) as Point,
      pass: candidate.pass,
    };
  });

  return { markers, quad, detectedMarkerIds: allIds, passesUsed };
}

function cornerNameFor(id: number): CornerName {
  switch (id) {
    case MARKERS.ids.topLeft:
      return 'topLeft';
    case MARKERS.ids.topRight:
      return 'topRight';
    case MARKERS.ids.bottomRight:
      return 'bottomRight';
    default:
      return 'bottomLeft';
  }
}

/**
 * Quality signals derived purely from the quad's geometry, used to warn the
 * user before they commit to a bad photo.
 */
export function quadGeometryQuality(
  quad: Quad,
  image: ImageDataLike,
): { quadAreaFraction: number; perspectiveSkew: number } {
  const points = quad as readonly Point[];
  const area = Math.abs(signedArea(points));
  const edges = points.map((p, i) => {
    const q = points[(i + 1) % 4] as Point;
    return Math.hypot(q.x - p.x, q.y - p.y);
  });
  const mean = edges.reduce((s, e) => s + e, 0) / edges.length;
  // The true quad is a square, so edge-length spread is a direct read on how
  // oblique the shot was: 0 head-on, growing with the angle.
  const skew = mean > 0 ? Math.max(...edges.map((e) => Math.abs(e - mean))) / mean : 0;
  return {
    quadAreaFraction: Math.min(1, area / (image.width * image.height)),
    perspectiveSkew: skew,
  };
}

/** The canonical destination raster size, restated for convenience. */
export const TEXTURE_SIZE = { width: TEXTURE.width, height: TEXTURE.height } as const;

export { PipelineError };
