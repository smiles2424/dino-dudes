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
 * harness. Deliberately NOT the animated transform: the wander is client-local
 * (each page seeds it from the player id and times it from its own load clock),
 * so only these values can be compared across two clients.
 */
export interface WorldDebugPlayer {
  x: number;
  y: number;
  z: number;
  /** Y-axis rotation in radians. */
  heading: number;
  modelSlug: string;
}

export interface WorldDebug {
  /** Bumped if the shape below ever changes. `2` added {@link WorldDebug.players}. */
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

export const worldDebug: WorldDebug = {
  version: 2,
  ready: false,
  frozen: false,
  dinoCount: 0,
  players: {},
  appliedTextures: {},
  textureStatus: {},
  pendingTextures: 0,
  textureErrors: {},
  geometryBuilds: 0,
  materialBuilds: 0,
  frames: 0,
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
