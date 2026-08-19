/**
 * `window.__world` — the test/observability surface of the 3D world.
 *
 * Deliberately shipped in production builds: the `/debug/world` harness and
 * every later wave's Playwright test assert against this object instead of
 * pixel-peeping. It is a single mutable object, so `page.evaluate` always sees
 * the live values.
 */

/** Texture lifecycle for one player, as the renderer sees it. */
export type TextureStatus = 'none' | 'loading' | 'applied' | 'error';

/**
 * Where one dino stands, exactly as the state the renderer was handed says —
 * server-assigned and synchronized in live mode, straight from the JSON in the
 * harness. This is the *home* position, not the animated transform; for the
 * latter see {@link WorldDebug.poses}.
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
 * The **animated** transform of one dino, rewritten every frame (Wave 5,
 * Chunk 5.1). In a live lobby the wander is derived from the room's motion seed
 * and the server's clock, so two browsers must report the same values here at
 * the same wall-clock moment — that is what closes PLAN.md's "two-client world
 * consistency" follow-up with the dinos actually moving.
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

/** How this page is timing the wander. */
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
  /**
   * Bumped if the shape below ever changes. `2` added
   * {@link WorldDebug.players}; `3` added {@link WorldDebug.poses},
   * {@link WorldDebug.motion}, {@link WorldDebug.camera},
   * {@link WorldDebug.offscreen} and {@link WorldDebug.motionTime}.
   */
  readonly version: number;
  /** True once the state is loaded and every requested texture has resolved. */
  ready: boolean;
  /** True when `?static=1` froze all motion (screenshot mode). */
  frozen: boolean;
  /** Number of dinos currently mounted in the scene. */
  dinoCount: number;
  /**
   * `playerId → position/heading` as synchronized (Wave 4, Chunk 4.3). Lets a
   * test prove two browsers in one lobby are looking at the *same* world.
   */
  players: Record<string, WorldDebugPlayer>;
  /** `playerId → animated transform`, updated every rendered frame. */
  poses: Record<string, WorldDebugPose>;
  /** How the wander is being timed. */
  motion: WorldDebugMotion;
  /** The camera the scene is rendered from. */
  camera: WorldDebugCamera;
  /**
   * How many dinos are currently outside the viewport — the number PLAN.md's
   * "every dino must be on screen" follow-up is about. Must be 0.
   */
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
   * The current motion time in seconds: `(serverNow - epoch) / 1000` in a live
   * lobby, the r3f clock in the harness. Two synced clients must agree.
   */
  motionTime: () => number;
  /**
   * The pose this client computes for `playerId` at motion time `t` —
   * analytical, so it answers for any `t` even on a page whose clock is frozen.
   * Deterministic and frame-independent, so two clients can be compared without
   * either of them having to be sampled at the same instant.
   */
  poseAtTime?: (playerId: string, t: number) => WorldDebugPose | null;
  /**
   * Would this dino be completely inside the frame at motion time `t` (feet
   * and head)? `null` if the player is unknown. Sampling it across a whole
   * wander period is how a test proves "every dino on screen" holds at every
   * instant rather than at the one it happened to look.
   */
  playerOnScreen?: (playerId: string, t: number) => boolean | null;
  /**
   * Harness-only hook: repoint one player at another texture hash at runtime,
   * exactly as a Colyseus `avatar-updated` message will in Wave 3. Installed
   * by `/debug/world`; undefined elsewhere.
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
 * every texture transition and on every frame while not ready, so `ready` goes
 * back to `false` for the duration of a runtime texture swap and returns to
 * `true` only once the new skin is really on the material.
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
