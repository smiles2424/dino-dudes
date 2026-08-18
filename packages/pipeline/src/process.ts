/**
 * The whole WS-A pipeline, end to end: photo → texture.
 *
 *   detect (js-aruco2)  →  extract drawable quad  →  perspective warp  →
 *   levels cleanup  →  canonical 1024×1024 RGBA
 *
 * ── Calling this from the browser (Wave 4) ─────────────────────────────────
 *
 *   const bitmap = await createImageBitmap(fileFromCameraInput);
 *   const c = new OffscreenCanvas(bitmap.width, bitmap.height);
 *   const ctx = c.getContext('2d')!;
 *   ctx.drawImage(bitmap, 0, 0);
 *   const photo = ctx.getImageData(0, 0, c.width, c.height);   // ImageDataLike
 *
 *   try {
 *     const { texture, quality } = processPhoto(photo);
 *     const out = new OffscreenCanvas(texture.width, texture.height);
 *     out.getContext('2d')!.putImageData(new ImageData(texture.data, 1024, 1024), 0, 0);
 *     const png = await out.convertToBlob({ type: 'image/png' });   // → POST /api/avatars
 *   } catch (err) {
 *     if (err instanceof PipelineError) showRetakeUi(err.payload.corners);
 *   }
 *
 * There is no async step and no WASM to await, so this can run on the main
 * thread; at ~12 MP it is still worth a Web Worker to keep the UI responsive.
 * Everything on this path is pure typed-array maths — no Node builtins.
 */
import {
  MARKERS,
  PIPELINE_QUALITY,
  TEXTURE,
  TEXTURE_DEST_POINTS,
  TEXTURE_SAFE_AREA,
  type PipelineQuality,
} from '@dino/shared';
import { detectDrawableQuad, quadGeometryQuality, type DetectionResult } from './detect.js';
import { cleanupLevels, meanLuminance, sharpness, type LevelsOptions } from './levels.js';
import type { ImageDataLike } from './image.js';
import { autoSupersample, warpQuadToTexture } from './warp.js';

export interface ProcessOptions {
  /** Passed through to js-aruco2. */
  maxHammingDistance?: number;
  /** Overrides for the cleanup pass; `null` disables cleanup entirely. */
  levels?: LevelsOptions | null;
  /** Warp supersampling; `'auto'` (default) picks from the quad's source size. */
  supersample?: number | 'auto';
}

export interface ProcessResult {
  /** The canonical texture: `TEXTURE.width` × `TEXTURE.height`, RGBA, opaque. */
  texture: ImageDataLike;
  /** The same raster before `cleanupLevels` — handy for debugging goldens. */
  rawTexture: ImageDataLike;
  detection: DetectionResult;
  quality: PipelineQuality;
  /** Non-fatal advisories, already thresholded against `PIPELINE_QUALITY`. */
  warnings: ('blurry' | 'too_far')[];
}

/**
 * Runs the full pipeline.
 *
 * @throws {PipelineError} — always with a four-entry per-corner diagnostic, so
 *   the caller can say exactly which corner of the sheet to re-shoot.
 */
export function processPhoto(photo: ImageDataLike, options: ProcessOptions = {}): ProcessResult {
  const detection = detectDrawableQuad(photo, {
    maxHammingDistance: options.maxHammingDistance ?? 0,
  });

  const supersample =
    options.supersample === undefined || options.supersample === 'auto'
      ? autoSupersample(detection.quad, Math.max(TEXTURE.width, TEXTURE.height))
      : options.supersample;

  const rawTexture = warpQuadToTexture(photo, detection.quad, TEXTURE_DEST_POINTS, {
    width: TEXTURE.width,
    height: TEXTURE.height,
    supersample,
  });

  const texture =
    options.levels === null ? rawTexture : cleanupLevels(rawTexture, options.levels ?? {});

  const geometry = quadGeometryQuality(detection.quad, photo);
  const quality: PipelineQuality = {
    // Sharpness is read off the CLEANED texture: on the raw one the Laplacian
    // variance mostly tracks how well-lit the photo was, so a dim sheet scored
    // "sharper" than a bright one. After levels, contrast is normalised and
    // the number tracks detail.
    sharpness: sharpness(texture),
    // Exposure, though, is a property of the photo — measure it before cleanup.
    meanLuminance: meanLuminance(rawTexture),
    ...geometry,
  };

  const warnings: ProcessResult['warnings'] = [];
  if (quality.sharpness < PIPELINE_QUALITY.blurWarnBelow) warnings.push('blurry');
  if (quality.quadAreaFraction < PIPELINE_QUALITY.quadAreaWarnBelow) warnings.push('too_far');

  return { texture, rawTexture, detection, quality, warnings };
}

/**
 * The safe area, restated for consumers. WS-C's UV unwrap must stay inside
 * this box; the printed sheet's dashed guide maps exactly onto it.
 */
export const SAFE_AREA = TEXTURE_SAFE_AREA;

/** Marker order the quad is always reported in. */
export const QUAD_ORDER = MARKERS.order;
