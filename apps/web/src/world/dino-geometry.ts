/**
 * Procedural low-poly dino geometry.
 *
 * The boxes and the unwrap live in `@dino/shared` (`dino-models.ts`) so the
 * template generator can print an outline that matches exactly; this file is
 * only the three.js realisation of that data:
 *
 *   boxes → taper → rotate → translate → mirror → merge → planar UVs
 *
 * The UVs are a mirrored planar side projection squeezed into
 * `TEXTURE_SAFE_AREA`, i.e. `sideProjectionUv()` applied to each vertex's
 * (x, y). Geometry is built once per slug and shared by every dino of that
 * kind — a texture swap never touches it.
 */
import { BoxGeometry, BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  DINO_PARTS,
  dinoSideBounds,
  sideProjectionUv,
  type DinoPart,
  type ModelSlug,
} from '@dino/shared';
import { worldDebug } from './world-debug.js';

const cache = new Map<ModelSlug, BufferGeometry>();

/** The merged, UV-unwrapped geometry for a slug. Cached; never rebuilt. */
export function getDinoGeometry(slug: ModelSlug): BufferGeometry {
  const cached = cache.get(slug);
  if (cached) return cached;

  const parts: BufferGeometry[] = [];
  for (const part of DINO_PARTS[slug]) {
    parts.push(buildPart(part, false));
    if (part.mirrorZ) parts.push(buildPart(part, true));
  }

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error(`failed to merge geometry for ${slug}`);

  applySideProjectionUvs(merged, slug);
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  merged.computeBoundingSphere();

  cache.set(slug, merged);
  worldDebug.geometryBuilds += 1;
  return merged;
}

/** Height of the animal in metres — used to float the nameplate above it. */
export function dinoHeight(slug: ModelSlug): number {
  return dinoSideBounds(slug).maxY;
}

/** Half-length of the animal — used to size its contact shadow. */
export function dinoRadius(slug: ModelSlug): number {
  const bounds = dinoSideBounds(slug);
  return (bounds.maxX - bounds.minX) / 2;
}

function buildPart(part: DinoPart, mirrored: boolean): BufferGeometry {
  const [width, height, depth] = part.size;
  const geometry = new BoxGeometry(width, height, depth);

  const [taperMin, taperMax] = part.taper ?? [1, 1];
  if (taperMin !== 1 || taperMax !== 1) {
    const position = geometry.attributes['position'];
    if (!position) throw new Error('box geometry has no position attribute');
    for (let i = 0; i < position.count; i += 1) {
      const t = width === 0 ? 0.5 : (position.getX(i) + width / 2) / width;
      const scale = taperMin + (taperMax - taperMin) * t;
      position.setY(i, position.getY(i) * scale);
      position.setZ(i, position.getZ(i) * scale);
    }
    position.needsUpdate = true;
  }

  if (part.rotZ) geometry.rotateZ(part.rotZ);

  const [cx, cy, cz] = part.center;
  geometry.translate(cx, cy, mirrored ? -cz : cz);
  return geometry;
}

function applySideProjectionUvs(geometry: BufferGeometry, slug: ModelSlug): void {
  const bounds = dinoSideBounds(slug);
  const position = geometry.attributes['position'];
  const uv = geometry.attributes['uv'];
  if (!position || !uv) throw new Error('merged geometry is missing position/uv');

  for (let i = 0; i < position.count; i += 1) {
    const [u, v] = sideProjectionUv(position.getX(i), position.getY(i), bounds);
    uv.setXY(i, u, v);
  }
  uv.needsUpdate = true;
}
