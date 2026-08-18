/**
 * The pipeline's one failure type. It carries the frozen
 * `PipelineErrorPayload` from `@dino/shared`, so Wave 4's capture UI can
 * render per-corner retake hints straight off `err.payload.corners` and the
 * server can forward it verbatim.
 */
import {
  CORNER_BY_MARKER_ID,
  CORNER_NAMES,
  MARKERS,
  missingCornerHint,
  type CornerDiagnostic,
  type CornerName,
  type PipelineErrorCode,
  type PipelineErrorPayload,
} from '@dino/shared';
import type { Point } from './image.js';

export class PipelineError extends Error {
  readonly payload: PipelineErrorPayload;

  constructor(payload: PipelineErrorPayload) {
    super(payload.message);
    this.name = 'PipelineError';
    this.payload = payload;
  }

  get code(): PipelineErrorCode {
    return this.payload.error;
  }

  /** Corners the photo failed to show — what the retake UI highlights. */
  get missingCorners(): CornerName[] {
    return this.payload.corners.filter((c) => !c.found).map((c) => c.corner);
  }

  /** JSON-serialisable form, validated by `PipelineErrorSchema`. */
  toJSON(): PipelineErrorPayload {
    return this.payload;
  }
}

/** Marker id for a corner name, from the frozen spec. */
const MARKER_ID_BY_CORNER: Record<CornerName, number> = {
  topLeft: MARKERS.ids.topLeft,
  topRight: MARKERS.ids.topRight,
  bottomRight: MARKERS.ids.bottomRight,
  bottomLeft: MARKERS.ids.bottomLeft,
};

/**
 * Builds the always-four-entries corner diagnostic array from whatever inner
 * corners were successfully located.
 */
export function buildCornerDiagnostics(found: ReadonlyMap<number, Point>): CornerDiagnostic[] {
  return CORNER_NAMES.map((corner) => {
    const markerId = MARKER_ID_BY_CORNER[corner];
    const point = found.get(markerId);
    return {
      corner,
      markerId,
      found: point !== undefined,
      point: point ? { x: point.x, y: point.y } : null,
      hint: point ? '' : missingCornerHint(corner),
    };
  });
}

export function pipelineError(
  error: PipelineErrorCode,
  message: string,
  found: ReadonlyMap<number, Point>,
  detectedMarkerIds: number[],
): PipelineError {
  return new PipelineError({
    error,
    message,
    corners: buildCornerDiagnostics(found),
    detectedMarkerIds: [...detectedMarkerIds].sort((a, b) => a - b),
  });
}

export { CORNER_BY_MARKER_ID, MARKER_ID_BY_CORNER };
