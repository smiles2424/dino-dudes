/**
 * Framing: **every dino on screen** (Wave 5, Chunk 5.1).
 *
 * `spawnFor` puts players on a 4–8 m ring around the origin and the classic
 * projector shot (`[0.6, 3.6, 11.5]`, 42° fov) only covers about ±7 m at that
 * depth — the flagship E2E measured ~17 % of the ring falling outside the
 * frame, i.e. roughly one child in six not seeing their dinosaur. That is a
 * product bug, not a test threshold.
 *
 * The fix is a fit-to-bounds: keep the hand-tuned *direction* and field of view
 * of the projector shot (it is what makes the world look like a diorama rather
 * than a map) and simply dolly the camera back along that same axis until every
 * point it must show is inside the frustum, with a margin.
 *
 * Properties that matter elsewhere:
 *   • **clamped at 1×** — an empty or one-dino lobby gets exactly the framing it
 *     had before, so a lonely first dinosaur is never a speck;
 *   • **pure and deterministic** — two clients holding the same room state
 *     compute the same camera, which is what keeps the flagship's cross-client
 *     canvas comparison meaningful;
 *   • **quantised** — the scale is rounded, so a millimetre of state noise can
 *     never produce a visibly different frame on one screen only.
 */

export interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface CameraShot {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  /** Vertical field of view, degrees. */
  readonly fov: number;
}

export interface FitOptions {
  /** Canvas aspect ratio (width / height). */
  readonly aspect: number;
  /**
   * Fraction of the half-frame a point may occupy. 0.88 keeps a dino a
   * comfortable distance from the edge instead of shaving its nose.
   */
  readonly margin?: number;
  /** Never dolly further than this multiple of the base distance. */
  readonly maxScale?: number;
  /** Widen the lens no further than this (degrees) once dollying saturates. */
  readonly maxFov?: number;
}

const DEFAULT_MARGIN = 0.88;
const DEFAULT_MAX_SCALE = 3;
const DEFAULT_MAX_FOV = 80;
/** Dolly steps. 4 % is finer than the eye and keeps the search ~28 iterations. */
const STEP = 1.04;
/** Lens steps, once the dolly has run out. */
const FOV_STEP = 2;

/**
 * The base shot, dollied back far enough to contain `points`.
 *
 * `points` are world-space positions that must be visible — callers pass the
 * corners of each dino's reachable box at foot *and* head height, so the
 * guarantee holds for every instant of the wander, not just for right now.
 */
export function fitShotToPoints(
  base: CameraShot,
  points: readonly Point3[],
  options: FitOptions,
): CameraShot {
  const margin = options.margin ?? DEFAULT_MARGIN;
  const maxScale = options.maxScale ?? DEFAULT_MAX_SCALE;
  const maxFov = options.maxFov ?? DEFAULT_MAX_FOV;
  if (points.length === 0) return base;

  const aspect = Math.max(options.aspect, 0.1);
  const fits = (scale: number, fov: number): boolean => {
    const tanV = Math.tan(((fov / 2) * Math.PI) / 180) * margin;
    return contains(base, points, scale, tanV * aspect, tanV);
  };

  // 1. Dolly back along the hand-tuned axis. Cheap, and it preserves the shot.
  let scale = 1;
  while (scale < maxScale && !fits(scale, base.fov)) {
    scale = Math.min(scale * STEP, maxScale);
  }

  // 2. A portrait viewport (a phone on `/play`) has a horizontal field so
  //    narrow that no reasonable distance contains a 16 m field — the lens has
  //    to widen too. Landscape projectors never reach this branch.
  let fov = base.fov;
  while (fov < maxFov && !fits(scale, fov)) {
    fov = Math.min(fov + FOV_STEP, maxFov);
  }

  if (scale === 1 && fov === base.fov) return base;
  const rounded = Math.round(scale * 100) / 100;
  const [tx, ty, tz] = base.target;
  const [px, py, pz] = base.position;
  return {
    fov,
    target: base.target,
    position: [
      round(tx + (px - tx) * rounded),
      round(ty + (py - ty) * rounded),
      round(tz + (pz - tz) * rounded),
    ],
  };
}

/** Every point inside the frustum of `base` dollied out by `scale`? */
function contains(
  base: CameraShot,
  points: readonly Point3[],
  scale: number,
  tanH: number,
  tanV: number,
): boolean {
  const [tx, ty, tz] = base.target;
  const [px, py, pz] = base.position;
  const eye = { x: tx + (px - tx) * scale, y: ty + (py - ty) * scale, z: tz + (pz - tz) * scale };

  const forward = normalise({ x: tx - eye.x, y: ty - eye.y, z: tz - eye.z });
  // Y-up, exactly as three.js builds a look-at basis.
  const right = normalise(cross(forward, { x: 0, y: 1, z: 0 }));
  const up = cross(right, forward);

  for (const point of points) {
    const v = { x: point.x - eye.x, y: point.y - eye.y, z: point.z - eye.z };
    const depth = dot(v, forward);
    if (depth <= 0.1) return false;
    if (Math.abs(dot(v, right)) > tanH * depth) return false;
    if (Math.abs(dot(v, up)) > tanV * depth) return false;
  }
  return true;
}

const dot = (a: Point3, b: Point3): number => a.x * b.x + a.y * b.y + a.z * b.z;

const cross = (a: Point3, b: Point3): Point3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function normalise(v: Point3): Point3 {
  const length = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;
