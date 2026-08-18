/**
 * One dinosaur: shared geometry + a private material whose `map` is hot-swapped
 * when the player's drawing changes.
 *
 * The material instance is created once and never replaced, so a texture swap
 * costs one `material.map = texture` — no model reload, no remount, no lost
 * position. `window.__world` is updated only once a texture is really on the
 * material, which is what the E2E asserts.
 */
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
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
}

export function Dino({ player, textureUrl, frozen }: DinoProps): JSX.Element {
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
  useLayoutEffect(() => {
    applyPose(0);
    function applyPose(time: number): void {
      const pose = poseAt(player, time);
      groupRef.current?.position.set(pose.x, pose.y, pose.z);
      if (groupRef.current) groupRef.current.rotation.y = pose.rotationY;
      shadowRef.current?.position.set(pose.x, 0.015, pose.z);
    }
  }, [player]);

  useFrame((state) => {
    if (frozen) return;
    const pose = poseAt(player, state.clock.elapsedTime);
    const group = groupRef.current;
    if (group) {
      group.position.set(pose.x, pose.y, pose.z);
      group.rotation.y = pose.rotationY;
    }
    shadowRef.current?.position.set(pose.x, 0.015, pose.z);
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
