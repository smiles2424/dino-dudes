/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PIPELINE RESULT SPEC — ADDITIVE (Wave 2A)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Nothing in the Wave 1 contracts is changed here; this file only ADDS the
 * shape of what `@dino/pipeline` hands back to its callers.
 *
 * Two consumers:
 *   • Wave 4 (WS-D) capture flow — renders the per-corner hints as retake UX
 *     ("we couldn't see the bottom-left corner square").
 *   • Wave 2A's own golden tests — assert the failure path is structured, not
 *     a bare `Error`.
 *
 * The pipeline is all-or-nothing: all four markers must be found, because the
 * drawable quad has four corners and there is no sane way to guess a missing
 * one. So a failure always reports the status of EVERY corner, which is what
 * lets the UI say exactly which corner of the sheet to re-shoot.
 */
import { z } from 'zod';
import { MARKERS } from './texture-spec.js';

// ── Corners ────────────────────────────────────────────────────────────────

/** The four drawable-quad corners, clockwise from top-left — same order as `MARKERS.order`. */
export const CORNER_NAMES = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'] as const;
export type CornerName = (typeof CORNER_NAMES)[number];
export const CornerNameSchema = z.enum(CORNER_NAMES);

/** Marker id → corner name. The inverse of `MARKERS.ids`. */
export const CORNER_BY_MARKER_ID: Readonly<Record<number, CornerName>> = {
  [MARKERS.ids.topLeft]: 'topLeft',
  [MARKERS.ids.topRight]: 'topRight',
  [MARKERS.ids.bottomRight]: 'bottomRight',
  [MARKERS.ids.bottomLeft]: 'bottomLeft',
};

/** Human-facing name of where a corner physically sits on the printed sheet. */
export const CORNER_LABELS: Readonly<Record<CornerName, string>> = {
  topLeft: 'top-left',
  topRight: 'top-right',
  bottomRight: 'bottom-right',
  bottomLeft: 'bottom-left',
};

// ── Errors ─────────────────────────────────────────────────────────────────

/**
 * Why a photo could not be turned into a texture.
 *
 * - `markers_not_found`   — zero markers detected (wrong sheet? way too blurry?)
 * - `markers_incomplete`  — 1–3 of the 4 corner markers detected
 * - `markers_duplicated`  — the same marker id was detected more than once
 *   (two sheets in frame, or a reflection)
 * - `quad_degenerate`     — all four found, but the quad they span is
 *   self-intersecting / near-zero area — an impossible photo of a flat sheet
 * - `image_too_small`     — source image below the minimum usable resolution
 * - `image_invalid`       — not a decodable RGBA raster of the stated size
 */
export const PipelineErrorCodeSchema = z.enum([
  'markers_not_found',
  'markers_incomplete',
  'markers_duplicated',
  'quad_degenerate',
  'image_too_small',
  'image_invalid',
]);
export type PipelineErrorCode = z.infer<typeof PipelineErrorCodeSchema>;

/** Per-corner outcome. Always four of these, in `CORNER_NAMES` order. */
export const CornerDiagnosticSchema = z.object({
  corner: CornerNameSchema,
  /** The ArUco id printed at this corner. */
  markerId: z.number().int().min(0),
  found: z.boolean(),
  /** Where the marker's inner corner landed in source-image pixels, when found. */
  point: z.object({ x: z.number(), y: z.number() }).nullable(),
  /** Actionable, user-facing sentence. Empty string when `found`. */
  hint: z.string(),
});
export type CornerDiagnostic = z.infer<typeof CornerDiagnosticSchema>;

/** The structured payload carried by every pipeline failure. */
export const PipelineErrorSchema = z.object({
  error: PipelineErrorCodeSchema,
  message: z.string(),
  /** Always length 4, in `CORNER_NAMES` order. */
  corners: z.array(CornerDiagnosticSchema).length(4),
  /** Marker ids detected in the photo, ascending. */
  detectedMarkerIds: z.array(z.number().int()),
});
export type PipelineErrorPayload = z.infer<typeof PipelineErrorSchema>;

/** Default copy for a corner whose marker was not detected. */
export const missingCornerHint = (corner: CornerName): string =>
  `Couldn't see the ${CORNER_LABELS[corner]} corner square. Re-shoot the sheet flat with all four black squares fully in frame and unobscured.`;

// ── Success ────────────────────────────────────────────────────────────────

/**
 * Non-fatal quality signals about a successful run. Wave 4 turns these into
 * "looks blurry, retake?" nudges without blocking the user.
 */
export const PipelineQualitySchema = z.object({
  /**
   * Variance of the Laplacian over the finished texture. Low == blurry.
   * Compare against {@link PIPELINE_QUALITY.blurWarnBelow}.
   */
  sharpness: z.number().nonnegative(),
  /** Mean luminance (0–255) of the warped texture *before* cleanup — exposure. */
  meanLuminance: z.number(),
  /**
   * Area of the detected quad as a fraction of the source image. Tiny values
   * mean the sheet was shot from far away and the texture will be soft.
   */
  quadAreaFraction: z.number().min(0).max(1),
  /**
   * How far the detected quad is from a perfect square, 0 == square. Big
   * values mean an extreme angle; the deskew still works but detail is lost
   * on the far edge.
   */
  perspectiveSkew: z.number().nonnegative(),
});
export type PipelineQuality = z.infer<typeof PipelineQualitySchema>;

/**
 * Advisory thresholds. PROVISIONAL: calibrated in Wave 2A against the ten
 * synthetic fixtures, all of which are photos a user should be allowed to
 * keep — so the thresholds sit just below the worst of them. Wave 4 should
 * retune once real phone photos exist; nothing blocks on these, they only
 * decide whether a "looks a bit soft, retake?" nudge is shown.
 */
export const PIPELINE_QUALITY = {
  /**
   * Below this Laplacian variance, warn the photo looks blurry. The ten
   * fixtures land in 69–95; a photo soft enough to drop below 60 is close to
   * failing marker detection outright.
   */
  blurWarnBelow: 60,
  /**
   * Below this fraction of the frame, warn they stood too far back. The two
   * deliberately-distant fixtures sit near 0.14.
   */
  quadAreaWarnBelow: 0.08,
} as const;
