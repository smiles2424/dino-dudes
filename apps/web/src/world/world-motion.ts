/**
 * Idle/wander motion.
 *
 * Every number below is derived from a **seed plus the player's id** — no
 * `Math.random()` anywhere — so the world is identical on every machine and on
 * every reload, and freezing time at t = 0 (the `?static=1` screenshot mode)
 * puts every dino exactly on the position/heading its state says it has.
 *
 * Wave 5 Chunk 5.1 added the seed and made the *time* shared too: in a live
 * lobby the seed comes from room state (`motionSeed`) and `time` is measured
 * from the server's `motionEpoch` on the server's clock, so two browsers watch
 * the same dinosaur take the same step at the same moment. `/debug/world` has
 * no server, passes no seed, and keeps its old page-local behaviour.
 */
import type { PlayerState } from '@dino/shared';

export interface Pose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Rotation about Y, radians. The model faces +X at rotation 0. */
  readonly rotationY: number;
}

/**
 * Where the wander's numbers come from. Supplied by a live lobby
 * (`useLobbyRoom`); absent in the `/debug/world` harness, which falls back to
 * the renderer's own clock and an empty seed.
 */
export interface MotionSource {
  /** The lobby's server-issued motion seed. */
  readonly seed: string;
  /** Motion time in **seconds** on the shared (server) clock. */
  readonly nowSeconds: () => number;
  /** Server-clock epoch the time above is measured from, ms. */
  readonly epoch: number;
  /** Estimated `serverClock - localClock`, ms. */
  readonly offsetMs: number;
  /** How many `serverTime` samples the offset was refined from. */
  readonly samples: number;
}

/** The box a player's wander can ever reach, in world metres. */
export interface MotionBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** FNV-1a over the id, normalised to [0, 1). Stable across engines. */
export function seedFromId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x100000000;
}

interface Wander {
  readonly radiusX: number;
  readonly radiusZ: number;
  readonly speed: number;
  readonly phase: number;
  readonly bobRate: number;
  readonly bobHeight: number;
}

const wanderCache = new Map<string, Wander>();

/**
 * Wander parameters for one player in one lobby.
 *
 * The lobby's `seed` is mixed in so the same child rejoining a different lobby
 * does not retrace yesterday's path — and, far more importantly, so that every
 * client of *this* lobby derives the same path from state it was given rather
 * than from anything local.
 */
function wanderFor(id: string, seed: string): Wander {
  const key = seed === '' ? id : `${seed}:${id}`;
  const cached = wanderCache.get(key);
  if (cached) return cached;

  const a = seedFromId(key);
  const b = seedFromId(`${key}#2`);
  const wander: Wander = {
    // Amplitudes are deliberately modest: the camera has to frame every dino's
    // whole reachable box (see `camera-fit.ts`), and a 4.6 m excursion pushed
    // the projector so far back that the animals became specks.
    radiusX: 0.55 + a * 0.75,
    radiusZ: 0.35 + b * 0.5,
    speed: 0.16 + b * 0.14,
    phase: a * Math.PI * 2,
    bobRate: 1.6 + a * 1.2,
    bobHeight: 0.04 + b * 0.05,
  };
  wanderCache.set(key, wander);
  return wander;
}

/**
 * Where a dino is at `time` seconds. The orbit is offset so that t = 0 is
 * exactly the player's stored position — freeze the clock and the scene equals
 * its JSON.
 */
export function poseAt(player: PlayerState, time: number, seed = ''): Pose {
  const home = player.position;
  if (time === 0) {
    return { x: home.x, y: home.y, z: home.z, rotationY: player.heading };
  }

  const wander = wanderFor(player.id, seed);
  const angle = wander.phase + time * wander.speed;
  const x = home.x + (Math.cos(angle) - Math.cos(wander.phase)) * wander.radiusX;
  const z = home.z + (Math.sin(angle) - Math.sin(wander.phase)) * wander.radiusZ;

  // Tangent of the ellipse == the direction of travel.
  const dx = -Math.sin(angle) * wander.radiusX;
  const dz = Math.cos(angle) * wander.radiusZ;

  return {
    x,
    y: home.y + Math.abs(Math.sin(time * wander.bobRate)) * wander.bobHeight,
    z,
    rotationY: Math.atan2(-dz, dx),
  };
}

/**
 * Everywhere this dino can ever stand, for every t.
 *
 * `poseAt` offsets the orbit by its own phase, so the reachable interval in x
 * is `home.x + [-(1 + cos φ)·rx, (1 - cos φ)·rx]` (and the same in z with sin).
 * The camera frames *this*, not the current pose, so nobody walks off screen a
 * minute after they arrive.
 */
export function motionBounds(player: PlayerState, seed = ''): MotionBounds {
  const wander = wanderFor(player.id, seed);
  const cosP = Math.cos(wander.phase);
  const sinP = Math.sin(wander.phase);
  return {
    minX: player.position.x - (1 + cosP) * wander.radiusX,
    maxX: player.position.x + (1 - cosP) * wander.radiusX,
    minZ: player.position.z - (1 + sinP) * wander.radiusZ,
    maxZ: player.position.z + (1 - sinP) * wander.radiusZ,
  };
}
