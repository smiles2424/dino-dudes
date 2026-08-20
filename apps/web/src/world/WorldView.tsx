/**
 * The shared 3D world: ground, sky, light and N dinos rendered straight from a
 * state object — the same shape Colyseus syncs.
 *
 * This canvas is a screenshot assertion surface, so nothing in it may vary: no
 * `Math.random()` (every wobble comes from the lobby's motion seed and the
 * player id, and its *time* from the server, so two browsers render the same
 * frame while the dinos move), and no text inside the canvas (nameplates are
 * DOM, so font rasterisation cannot move a pixel). `frozen` additionally stops
 * the clock at t = 0, disables the controls, pins DPR to 1 and drops MSAA.
 *
 * The camera frames itself — see `camera-fit.ts`.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { BackSide, PerspectiveCamera, Vector3 } from 'three';
import type { PlayerState } from '@dino/shared';
import { Dino } from './Dino.js';
import { dinoHeight } from './dino-geometry.js';
import { fitShotToPoints, type CameraShot, type Point3 } from './camera-fit.js';
import { makeCheckerTexture, makeGradientTexture } from './textures.js';
import { motionBounds, poseAt, type MotionSource } from './world-motion.js';
import {
  refreshWorldReadiness,
  setMotionTimeSource,
  setWorldStateLoaded,
  worldDebug,
} from './world-debug.js';

export interface WorldViewProps {
  players: readonly PlayerState[];
  /** Maps a texture hash to a URL. `null` = this player has no drawing yet. */
  resolveTextureUrl: (hash: string) => string | null;
  /** Screenshot mode: freeze motion, pin DPR, drop AA. */
  frozen?: boolean;
  /** Whether the caller has finished loading the state (drives `ready`). */
  stateLoaded?: boolean;
  className?: string;
  /**
   * The shared motion clock of a live lobby. Omitted by `/debug/world`, which
   * has no server and keeps timing the wander from its own page clock.
   */
  motion?: MotionSource;
  /**
   * Camera override for the capture flow's single-dino preview, which needs a
   * close-up. Supplying either one also switches fit-to-bounds off: the preview
   * knows exactly what it wants to show.
   */
  cameraPosition?: readonly [number, number, number];
  cameraTarget?: readonly [number, number, number];
}

/** The hand-tuned projector shot. Fit-to-bounds only ever dollies it back. */
const BASE_SHOT: CameraShot = {
  position: [0.6, 3.6, 11.5],
  target: [0, 1.3, 0],
  fov: 42,
};
const HORIZON = '#cfe2f0';
/** Headroom above a dino that must also stay in frame (nameplates are DOM). */
const HEAD_MARGIN = 0.4;

/** Fixed scenery, so the world has depth cues. Hand-placed, never random. */
const TREES: readonly { x: number; z: number; scale: number }[] = [
  { x: -9.5, z: -6.5, scale: 1.25 },
  { x: -6.2, z: -10.5, scale: 0.95 },
  { x: 1.5, z: -12.5, scale: 1.5 },
  { x: 7.8, z: -8.5, scale: 1.1 },
  { x: 11.5, z: -3.5, scale: 1.35 },
  { x: -12.5, z: -1.5, scale: 1.05 },
  { x: 13.5, z: 3.5, scale: 0.9 },
  { x: -13.5, z: 4.5, scale: 1.2 },
];

export function WorldView({
  players,
  resolveTextureUrl,
  frozen = false,
  stateLoaded = true,
  className,
  motion,
  cameraPosition,
  cameraTarget,
}: WorldViewProps): JSX.Element {
  const override: CameraShot | null =
    cameraPosition || cameraTarget
      ? {
          position: cameraPosition ?? BASE_SHOT.position,
          target: cameraTarget ?? BASE_SHOT.target,
          fov: BASE_SHOT.fov,
        }
      : null;

  return (
    <Canvas
      className={className}
      flat
      dpr={frozen ? 1 : [1, 2]}
      gl={{
        antialias: !frozen,
        alpha: false,
        preserveDrawingBuffer: frozen,
        powerPreference: 'default',
      }}
      camera={{
        position: [...(override?.position ?? BASE_SHOT.position)],
        fov: BASE_SHOT.fov,
        near: 0.1,
        far: 600,
      }}
      data-testid="world-canvas"
    >
      <WorldScene
        players={players}
        resolveTextureUrl={resolveTextureUrl}
        frozen={frozen}
        stateLoaded={stateLoaded}
        motion={motion}
        override={override}
      />
    </Canvas>
  );
}

interface SceneProps {
  players: readonly PlayerState[];
  resolveTextureUrl: (hash: string) => string | null;
  frozen: boolean;
  stateLoaded: boolean;
  motion: MotionSource | undefined;
  /** A caller-pinned shot (the capture preview); `null` == fit to the world. */
  override: CameraShot | null;
}

function WorldScene({
  players,
  resolveTextureUrl,
  frozen,
  stateLoaded,
  motion,
  override,
}: SceneProps): JSX.Element {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const clock = useThree((state) => state.clock);
  const sky = useMemo(() => makeGradientTexture([236, 240, 226], [110, 168, 224]), []);
  const ground = useMemo(() => makeCheckerTexture([116, 152, 74], [104, 140, 68], 60), []);

  const seed = motion?.seed ?? '';
  const aspect = size.height > 0 ? size.width / size.height : 1.6;

  // Framed from where the dinos can *walk*, not where they stand now, so the
  // camera never moves again while the lobby's membership is stable.
  const shot = useMemo(
    () => (override ? override : fitShotToPoints(BASE_SHOT, framePoints(players, seed), { aspect })),
    [override, players, seed, aspect],
  );

  const [camX, camY, camZ] = shot.position;
  const [targetX, targetY, targetZ] = shot.target;

  useLayoutEffect(() => {
    (camera as PerspectiveCamera).fov = shot.fov;
    camera.position.set(camX, camY, camZ);
    camera.lookAt(targetX, targetY, targetZ);
    camera.updateProjectionMatrix();
    worldDebug.camera = {
      position: [camX, camY, camZ],
      target: [targetX, targetY, targetZ],
      fov: shot.fov,
      aspect,
    };
  }, [camera, camX, camY, camZ, targetX, targetY, targetZ, shot.fov, aspect]);

  // ── The shared clock ──────────────────────────────────────────────────────
  // Live: server epoch + estimated clock offset. Harness: the renderer's own
  // clock, exactly as before. `frozen` pins it at 0 in both.
  const motionTime = useMemo<() => number>(() => {
    if (frozen) return () => 0;
    if (motion) return motion.nowSeconds;
    return () => clock.elapsedTime;
  }, [frozen, motion, clock]);

  useEffect(() => {
    setMotionTimeSource(motionTime);
    worldDebug.motion = motion
      ? {
          source: 'server',
          seed: motion.seed,
          epoch: motion.epoch,
          offsetMs: motion.offsetMs,
          samples: motion.samples,
        }
      : { source: 'local', seed: '', epoch: 0, offsetMs: 0, samples: 0 };
  }, [motionTime, motion]);

  useEffect(() => {
    worldDebug.frozen = frozen;
    worldDebug.dinoCount = players.length;
    // The state as handed to the renderer — server-assigned in live mode, so
    // two clients in one lobby must report identical values (see world-debug).
    worldDebug.players = Object.fromEntries(
      players.map((player) => [
        player.id,
        {
          x: player.position.x,
          y: player.position.y,
          z: player.position.z,
          heading: player.heading,
          modelSlug: player.modelSlug,
        },
      ]),
    );
    for (const id of Object.keys(worldDebug.poses)) {
      if (!players.some((player) => player.id === id)) delete worldDebug.poses[id];
    }
    // Deterministic cross-client sampling: two clients can be compared at an
    // agreed motion time instead of at whatever instant each was polled.
    worldDebug.poseAtTime = (playerId, t) => {
      const player = players.find((candidate) => candidate.id === playerId);
      if (!player) return null;
      const pose = poseAt(player, t, seed);
      return { x: pose.x, y: pose.y, z: pose.z, rotationY: pose.rotationY, t };
    };
    setWorldStateLoaded(stateLoaded);
    return () => {
      delete worldDebug.poseAtTime;
    };
  }, [players, frozen, stateLoaded, seed]);

  // Sampled across a whole wander period, this is how E2E #2 proves the framing
  // holds at every instant rather than the one the test happened to catch.
  useEffect(() => {
    const scratch = new Vector3();
    worldDebug.playerOnScreen = (playerId, t) => {
      const player = players.find((candidate) => candidate.id === playerId);
      if (!player) return null;
      const pose = poseAt(player, t, seed);
      const perspective = camera as PerspectiveCamera;
      const top = pose.y + dinoHeight(player.modelSlug);
      return (
        inView(scratch.set(pose.x, pose.y, pose.z), perspective) &&
        inView(scratch.set(pose.x, top, pose.z), perspective)
      );
    };
    return () => {
      delete worldDebug.playerOnScreen;
    };
  }, [players, seed, camera]);

  return (
    <>
      <fogExp2 attach="fog" args={[HORIZON, 0.014]} />
      <ambientLight intensity={0.55} />
      <hemisphereLight args={['#dbeaff', '#4c5c30', 0.7]} />
      <directionalLight position={[7, 12, 6]} intensity={1.15} />

      {/* Sky dome — a gradient on the inside of a big sphere. */}
      <mesh>
        <sphereGeometry args={[260, 24, 16]} />
        <meshBasicMaterial map={sky} side={BackSide} fog={false} depthWrite={false} />
      </mesh>

      {/* Ground. */}
      <mesh rotation-x={-Math.PI / 2}>
        <planeGeometry args={[600, 600]} />
        <meshStandardMaterial map={ground} roughness={1} metalness={0} />
      </mesh>

      {TREES.map((tree) => (
        <Tree key={`${tree.x},${tree.z}`} {...tree} />
      ))}

      {players.map((player) => (
        <Dino
          key={player.id}
          player={player}
          textureUrl={player.textureHash ? resolveTextureUrl(player.textureHash) : null}
          frozen={frozen}
          seed={seed}
          motionTime={motionTime}
        />
      ))}

      {!frozen && (
        <OrbitControls
          target={[targetX, targetY, targetZ]}
          enablePan={false}
          enableDamping={false}
          minDistance={4}
          maxDistance={60}
          maxPolarAngle={Math.PI / 2.1}
        />
      )}

      <FrameTicker players={players} />
    </>
  );
}

/**
 * The corners of every dino's reachable box, at foot and head height — the
 * points the camera has to keep in frame for "every dino on screen" to be true
 * at every instant, not just at spawn.
 */
function framePoints(players: readonly PlayerState[], seed: string): Point3[] {
  const points: Point3[] = [];
  for (const player of players) {
    const bounds = motionBounds(player, seed);
    const top = player.position.y + dinoHeight(player.modelSlug) + HEAD_MARGIN;
    for (const x of [bounds.minX, bounds.maxX]) {
      for (const z of [bounds.minZ, bounds.maxZ]) {
        points.push({ x, y: player.position.y, z });
        points.push({ x, y: top, z });
      }
    }
  }
  return points;
}

function Tree({ x, z, scale }: { x: number; z: number; scale: number }): JSX.Element {
  return (
    <group position={[x, 0, z]} scale={scale}>
      <mesh position={[0, 0.9, 0]}>
        <cylinderGeometry args={[0.16, 0.22, 1.8, 6]} />
        <meshStandardMaterial color="#6b4c2f" roughness={1} flatShading />
      </mesh>
      <mesh position={[0, 2.5, 0]}>
        <coneGeometry args={[1.15, 2.6, 7]} />
        <meshStandardMaterial color="#3f6b34" roughness={1} flatShading />
      </mesh>
    </group>
  );
}

/**
 * Counts rendered frames, re-evaluates `window.__world.ready`, and keeps
 * `offscreen` honest by projecting every dino into the viewport each frame.
 */
function FrameTicker({ players }: { players: readonly PlayerState[] }): null {
  const scratch = useRef(new Vector3());

  useFrame((state) => {
    worldDebug.frames += 1;
    if (!worldDebug.ready) refreshWorldReadiness();

    const camera = state.camera as PerspectiveCamera;
    let offscreen = 0;
    for (const player of players) {
      const pose = worldDebug.poses[player.id];
      if (!pose) continue;
      const top = pose.y + dinoHeight(player.modelSlug);
      if (!inView(scratch.current.set(pose.x, pose.y, pose.z), camera)) offscreen += 1;
      else if (!inView(scratch.current.set(pose.x, top, pose.z), camera)) offscreen += 1;
    }
    worldDebug.offscreen = offscreen;
  });
  return null;
}

/** Is this world point inside the camera's frame? (NDC, with a hair of slack.) */
function inView(point: Vector3, camera: PerspectiveCamera): boolean {
  const ndc = point.project(camera);
  return Math.abs(ndc.x) <= 1.001 && Math.abs(ndc.y) <= 1.001 && ndc.z <= 1;
}
