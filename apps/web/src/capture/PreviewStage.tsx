/**
 * "Here's your dinosaur" — the freshly processed drawing on the real 3D model,
 * before anything is uploaded.
 *
 * This is the *same* `<WorldView>` the projector and `/debug/world` use, fed a
 * one-entry `PlayerState[]` and a `resolveTextureUrl` that hands back the blob
 * URL of the PNG we are about to POST. So what the phone shows here is exactly
 * what the big screen will show — same geometry, same unwrap, same texture
 * bytes — with no round trip through the server.
 *
 * Motion is frozen: a wandering dino would walk out of a 20-rem-tall box, and
 * a still model is also what you want to judge a drawing on.
 */
import { useCallback, useMemo } from 'react';
import type { ModelSlug, PlayerState } from '@dino/shared';
import { dinoHeight, dinoRadius } from '../world/dino-geometry.js';
import { WorldView } from '../world/WorldView.js';

/** Stable id for the not-yet-real player, so nothing collides with a live one. */
export const PREVIEW_PLAYER_ID = 'capture-preview';

export interface PreviewStageProps {
  name: string;
  modelSlug: ModelSlug;
  /** Blob URL of the processed texture. */
  textureUrl: string;
  /** Content address of that blob, used as the renderer's swap key. */
  textureKey: string;
}

export function PreviewStage({
  name,
  modelSlug,
  textureUrl,
  textureKey,
}: PreviewStageProps): JSX.Element {
  const players = useMemo<PlayerState[]>(
    () => [
      {
        id: PREVIEW_PLAYER_ID,
        name,
        modelSlug,
        textureHash: textureKey,
        position: { x: 0, y: 0, z: 0 },
        // The unwrap is a side projection, so the drawing lives on the flanks:
        // face the model along +X and the camera at +Z sees all of it, with a
        // few degrees of turn for depth.
        heading: 0.2,
      } as PlayerState,
    ],
    [name, modelSlug, textureKey],
  );

  const resolve = useCallback(() => textureUrl, [textureUrl]);

  // Frame the animal rather than the world: the projector's wide shot would
  // leave the drawing a thumbnail on a phone.
  const height = dinoHeight(modelSlug);
  const distance = Math.max(height, dinoRadius(modelSlug) * 2) * 2.05;
  const cameraPosition: readonly [number, number, number] = [
    distance * 0.2,
    height * 0.78,
    distance * 0.98,
  ];
  const cameraTarget: readonly [number, number, number] = [0, height * 0.5, 0];

  return (
    <div className="preview-stage" data-testid="capture-preview-stage">
      <WorldView
        players={players}
        resolveTextureUrl={resolve}
        frozen
        stateLoaded
        cameraPosition={cameraPosition}
        cameraTarget={cameraTarget}
      />
    </div>
  );
}
