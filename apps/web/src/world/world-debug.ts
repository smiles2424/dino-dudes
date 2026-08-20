/**
 * `window.__world` — the test/observability surface of the 3D world.
 *
 * Deliberately shipped in production builds: the harness and every Playwright
 * spec assert against this instead of pixel-peeping. One mutable object, so
 * `page.evaluate` always sees live values.
 */

/** Texture lifecycle for one player, as the renderer sees it. */
export type TextureStatus = 'none' | 'loading' | 'applied' | 'error';

/**
 * A dino's *home* position as the synchronized state gives it — not the
 * animated transform, which is {@link WorldDebug.poses}.
 */
export interface WorldDebugPlayer {
  x: number;
  y: number;
  z: number;
  /** Y-axis rotation in radians. */
  heading: number;
  modelSlug: string;
}

/**
 * The **animated** transform of one dino, rewritten every frame. In a live
 * lobby the wander derives from the room's motion seed and the server's clock,
 * so two browsers must report the same values at the same wall-clock moment.
 */
export interface WorldDebugPose {
  x: number;
  y: number;
  z: number;
  /** Y-axis rotation in radians. */
  rotationY: number;
  /** The motion time (seconds) this pose was evaluated at. */
  t: number;
}

export interface WorldDebugMotion {
  /** `server` once a room supplied a seed + epoch; `local` in the harness. */
  source: 'server' | 'local';
  /** The lobby's motion seed (`''` when local). */
  seed: string;
  /** Server-clock epoch motion time is measured from (0 when local). */
  epoch: number;
  /** Estimated `serverClock - localClock`, in ms (0 when local). */
  offsetMs: number;
  /** How many `serverTime` samples the offset has been refined from. */
  samples: number;
}

/** The shot the world is being rendered from, after fit-to-bounds. */
export interface WorldDebugCamera {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  /** Canvas aspect the fit was computed for. */
  aspect: number;
}

export interface WorldDebug {
  /** Bumped whenever the shape below changes; specs assert against it. */
  readonly version: number;
  /** True once the state is loaded and every requested texture has resolved. */
  ready: boolean;
  /** True when `?static=1` froze all motion (screenshot mode). */
  frozen: boolean;
  dinoCount: number;
  /**
   * `playerId → position/heading` as synchronized. Lets a spec prove that two
   * browsers in one lobby are looking at the *same* world.
   */
  players: Record<string, WorldDebugPlayer>;
  poses: Record<string, WorldDebugPose>;
  motion: WorldDebugMotion;
  camera: WorldDebugCamera;
  /** Dinos currently outside the viewport. Must be 0. */
  offscreen: number;
  /** `playerId → textureHash` for textures ACTUALLY applied to a material. */
  appliedTextures: Record<string, string>;
  /** `playerId → status`, including the ones still in flight. */
  textureStatus: Record<string, TextureStatus>;
  /** Textures still being fetched. `ready` implies this is 0. */
  pendingTextures: number;
  /** `playerId → message` for failed texture loads (the fallback stays on). */
  textureErrors: Record<string, string>;
  /** How many times a slug's geometry has been built. Never grows on a swap. */
  geometryBuilds: number;
  /** How many dino materials have been created. Never grows on a swap. */
  materialBuilds: number;
  /** Frames rendered since load — proves the canvas is actually drawing. */
  frames: number;
  /**
   * Current motion time in seconds: `(serverNow - epoch) / 1000` live, the r3f
   * clock in the harness. Two synced clients must agree on it.
   */
  motionTime: () => number;
  /**
   * The pose this client computes for `playerId` at motion time `t`. Analytical
   * rather than sampled, so it answers for any `t` even on a frozen page — two
   * clients can be compared without catching them at the same instant.
   */
  poseAtTime?: (playerId: string, t: number) => WorldDebugPose | null;
  /**
   * Is this dino completely inside the frame (feet and head) at motion time
   * `t`? `null` if unknown. Sampled across a whole wander period, this is how a
   * spec proves "every dino on screen" at every instant, not just one.
   */
  playerOnScreen?: (playerId: string, t: number) => boolean | null;
  /**
   * Harness-only hook: repoint one player at another texture hash at runtime,
   * as an `avatar-updated` message does live. Undefined outside `/debug/world`.
   */
  setTexture?: (playerId: string, textureHash: string) => void;
}

declare global {
  // eslint-disable-next-line no-var
  var __world: WorldDebug | undefined;
}

/** Replaced by `<WorldView>` on every render; called by {@link motionTime}. */
let motionTimeSource: () => number = () => 0;

export function setMotionTimeSource(source: () => number): void {
  motionTimeSource = source;
}

export const worldDebug: WorldDebug = {
  version: 3,
  ready: false,
  frozen: false,
  dinoCount: 0,
  players: {},
  poses: {},
  motion: { source: 'local', seed: '', epoch: 0, offsetMs: 0, samples: 0 },
  camera: { position: [0, 0, 0], target: [0, 0, 0], fov: 0, aspect: 0 },
  offscreen: 0,
  appliedTextures: {},
  textureStatus: {},
  pendingTextures: 0,
  textureErrors: {},
  geometryBuilds: 0,
  materialBuilds: 0,
  frames: 0,
  motionTime: () => motionTimeSource(),
};

if (typeof window !== 'undefined') {
  window.__world = worldDebug;
}

let stateLoaded = false;

/** The page tells us when its state JSON has arrived. */
export function setWorldStateLoaded(loaded: boolean): void {
  stateLoaded = loaded;
  refreshWorldReadiness();
}

/**
 * Recompute `pendingTextures` / `ready` from the per-player statuses. Called on
 * every texture transition and every frame while not ready, so `ready` drops to
 * `false` for the duration of a runtime swap and returns only once the new skin
 * is really on the material.
 */
export function refreshWorldReadiness(): void {
  const statuses = Object.values(worldDebug.textureStatus);
  worldDebug.pendingTextures = statuses.filter((status) => status === 'loading').length;
  worldDebug.ready =
    stateLoaded &&
    worldDebug.dinoCount > 0 &&
    worldDebug.pendingTextures === 0 &&
    worldDebug.frames > 0;
}
