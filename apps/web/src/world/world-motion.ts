/**
 * Idle/wander motion.
 *
 * Every number below is derived from the player's id — no `Math.random()`
 * anywhere — so the world is identical on every machine and on every reload,
 * and freezing time at t = 0 (the `?static=1` screenshot mode) puts every dino
 * exactly on the position/heading its state says it has.
 */
import type { PlayerState } from '@dino/shared';

export interface Pose {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Rotation about Y, radians. The model faces +X at rotation 0. */
  readonly rotationY: number;
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

function wanderFor(id: string): Wander {
  const cached = wanderCache.get(id);
  if (cached) return cached;

  const seed = seedFromId(id);
  const seed2 = seedFromId(`${id}#2`);
  const wander: Wander = {
    radiusX: 0.9 + seed * 1.4,
    radiusZ: 0.5 + seed2 * 0.9,
    speed: 0.16 + seed2 * 0.14,
    phase: seed * Math.PI * 2,
    bobRate: 1.6 + seed * 1.2,
    bobHeight: 0.04 + seed2 * 0.05,
  };
  wanderCache.set(id, wander);
  return wander;
}

/**
 * Where a dino is at `time` seconds. The orbit is offset so that t = 0 is
 * exactly the player's stored position — freeze the clock and the scene equals
 * its JSON.
 */
export function poseAt(player: PlayerState, time: number): Pose {
  const home = player.position;
  if (time === 0) {
    return { x: home.x, y: home.y, z: home.z, rotationY: player.heading };
  }

  const wander = wanderFor(player.id);
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
