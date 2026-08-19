/**
 * The shared 3D world: ground, sky, light, and N dinos rendered straight from
 * a state object (the same shape Colyseus will sync in Wave 3).
 *
 * Determinism rules, because this canvas is a screenshot assertion surface:
 *   • no `Math.random()` — every wobble comes from the player id;
 *   • no text inside the canvas — nameplates are DOM (drei `<Html>`), so OS
 *     font rasterisation can never move a pixel of the render;
 *   • `frozen` (from `?static=1`) stops the clock at t = 0, disables the
 *     orbit controls, pins DPR to 1 and turns MSAA off.
 */
import { useEffect, useLayoutEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { BackSide } from 'three';
import type { PlayerState } from '@dino/shared';
import { Dino } from './Dino.js';
import { makeCheckerTexture, makeGradientTexture } from './textures.js';
import { refreshWorldReadiness, setWorldStateLoaded, worldDebug } from './world-debug.js';

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
   * Camera override (added Chunk 4.2 for the capture flow's single-dino
   * preview, which needs a close-up). Both default to the wide projector shot
   * `/play` and `/debug/world` use, so the screenshot baseline is untouched.
   */
  cameraPosition?: readonly [number, number, number];
  cameraTarget?: readonly [number, number, number];
}

const CAMERA_POSITION: [number, number, number] = [0.6, 3.6, 11.5];
const CAMERA_TARGET: [number, number, number] = [0, 1.3, 0];
const HORIZON = '#cfe2f0';

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
  cameraPosition = CAMERA_POSITION,
  cameraTarget = CAMERA_TARGET,
}: WorldViewProps): JSX.Element {
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
      camera={{ position: [...cameraPosition], fov: 42, near: 0.1, far: 600 }}
      data-testid="world-canvas"
    >
      <WorldScene
        players={players}
        resolveTextureUrl={resolveTextureUrl}
        frozen={frozen}
        stateLoaded={stateLoaded}
        cameraPosition={cameraPosition}
        cameraTarget={cameraTarget}
      />
    </Canvas>
  );
}

function WorldScene({
  players,
  resolveTextureUrl,
  frozen,
  stateLoaded,
  cameraPosition,
  cameraTarget,
}: Required<Omit<WorldViewProps, 'className'>>): JSX.Element {
  const camera = useThree((state) => state.camera);
  const sky = useMemo(() => makeGradientTexture([236, 240, 226], [110, 168, 224]), []);
  const ground = useMemo(() => makeCheckerTexture([116, 152, 74], [104, 140, 68], 60), []);
  const [camX, camY, camZ] = cameraPosition;
  const [targetX, targetY, targetZ] = cameraTarget;

  useLayoutEffect(() => {
    camera.position.set(camX, camY, camZ);
    camera.lookAt(targetX, targetY, targetZ);
    camera.updateProjectionMatrix();
  }, [camera, camX, camY, camZ, targetX, targetY, targetZ]);

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
    setWorldStateLoaded(stateLoaded);
  }, [players, frozen, stateLoaded]);

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
        />
      ))}

      {!frozen && (
        <OrbitControls
          target={[targetX, targetY, targetZ]}
          enablePan={false}
          enableDamping={false}
          minDistance={4}
          maxDistance={30}
          maxPolarAngle={Math.PI / 2.1}
        />
      )}

      <FrameTicker />
    </>
  );
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

/** Counts rendered frames and re-evaluates `window.__world.ready`. */
function FrameTicker(): null {
  useFrame(() => {
    worldDebug.frames += 1;
    if (!worldDebug.ready) refreshWorldReadiness();
  });
  return null;
}
