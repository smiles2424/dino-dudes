/**
 * One dinosaur: shared geometry + a private material whose `map` is hot-swapped
 * when the player's drawing changes.
 *
 * The material instance is created once and never replaced, so a texture swap
 * costs one `material.map = texture` — no model reload, no remount, no lost
 * position. `window.__world` is updated only once a texture is really on the
 * material, which is what the E2E asserts.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { DoubleSide, Group, Mesh, MeshStandardMaterial } from 'three';
import type { PlayerState } from '@dino/shared';
import { dinoHeight, dinoRadius, getDinoGeometry } from './dino-geometry.js';
import { getFallbackTexture, loadWorldTexture } from './textures.js';
import { poseAt } from './world-motion.js';
import { refreshWorldReadiness, worldDebug } from './world-debug.js';

export interface DinoProps {
  player: PlayerState;
  /** Where this player's drawing lives, or `null` while they have none. */
  textureUrl: string | null;
  /** Freeze all motion at t = 0 (screenshot mode). */
  frozen: boolean;
  /** The lobby's motion seed (`''` in the server-less harness). */
  seed: string;
  /** Motion time in seconds — the *server's* clock in a live lobby. */
  motionTime: () => number;
}

export function Dino({ player, textureUrl, frozen, seed, motionTime }: DinoProps): JSX.Element {
  const groupRef = useRef<Group>(null);
  const shadowRef = useRef<Mesh>(null);

  const geometry = useMemo(() => getDinoGeometry(player.modelSlug), [player.modelSlug]);
  const material = useMemo(() => {
    worldDebug.materialBuilds += 1;
    return new MeshStandardMaterial({
      map: getFallbackTexture(player.modelSlug),
      roughness: 0.92,
      metalness: 0,
      flatShading: true,
      side: DoubleSide,
    });
  }, [player.modelSlug]);

  useEffect(() => () => material.dispose(), [material]);

  const height = dinoHeight(player.modelSlug);
  const radius = dinoRadius(player.modelSlug);
  const hash = player.textureHash;

  // ── Runtime texture swap ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    if (!textureUrl || !hash) {
      material.map = getFallbackTexture(player.modelSlug);
      material.needsUpdate = true;
      delete worldDebug.appliedTextures[player.id];
      delete worldDebug.textureErrors[player.id];
      worldDebug.textureStatus[player.id] = 'none';
      refreshWorldReadiness();
      return;
    }

    worldDebug.textureStatus[player.id] = 'loading';
    delete worldDebug.textureErrors[player.id];
    refreshWorldReadiness();

    void loadWorldTexture(textureUrl)
      .then((texture) => {
        if (cancelled) return;
        // The one line that matters: the model is untouched, only its skin.
        material.map = texture;
        material.needsUpdate = true;
        worldDebug.appliedTextures[player.id] = hash;
        worldDebug.textureStatus[player.id] = 'applied';
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Keep the placeholder skin on: a broken drawing must not blank a dino.
        worldDebug.textureStatus[player.id] = 'error';
        worldDebug.textureErrors[player.id] =
          error instanceof Error ? error.message : String(error);
        delete worldDebug.appliedTextures[player.id];
      })
      .finally(() => {
        if (!cancelled) refreshWorldReadiness();
      });

    return () => {
      cancelled = true;
    };
  }, [textureUrl, hash, material, player.id, player.modelSlug]);

  // ── Placement ───────────────────────────────────────────────────────────
  // `applyPose` also publishes the *animated* transform to `window.__world`,
  // which is how the flagship E2E compares two browsers mid-wander.
  const applyPose = useCallback(
    (time: number): void => {
      const pose = poseAt(player, time, seed);
      const group = groupRef.current;
      if (group) {
        group.position.set(pose.x, pose.y, pose.z);
        group.rotation.y = pose.rotationY;
      }
      shadowRef.current?.position.set(pose.x, 0.015, pose.z);
      worldDebug.poses[player.id] = {
        x: pose.x,
        y: pose.y,
        z: pose.z,
        rotationY: pose.rotationY,
        t: time,
      };
    },
    [player, seed],
  );

  useLayoutEffect(() => {
    applyPose(frozen ? 0 : motionTime());
  }, [applyPose, frozen, motionTime]);

  useEffect(() => {
    const id = player.id;
    return () => {
      delete worldDebug.poses[id];
    };
  }, [player.id]);

  useFrame(() => {
    if (frozen) return;
    applyPose(motionTime());
  });

  return (
    <>
      <mesh ref={shadowRef} rotation-x={-Math.PI / 2} renderOrder={-1}>
        <circleGeometry args={[radius * 0.75, 24]} />
        <meshBasicMaterial color="#2f3d24" transparent opacity={0.22} depthWrite={false} />
      </mesh>

      <group ref={groupRef}>
        <mesh geometry={geometry} material={material} castShadow={false} receiveShadow={false} />
        <Html
          position={[0, height + 0.55, 0]}
          center
          zIndexRange={[20, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="nameplate" data-testid="nameplate" data-player-id={player.id}>
            {player.name}
          </div>
        </Html>
      </group>
    </>
  );
}
