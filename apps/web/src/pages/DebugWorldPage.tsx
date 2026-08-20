/**
 * `/debug/world` — the development harness and the E2E assertion surface. It
 * renders the real {@link WorldView} from a static JSON state plus local
 * texture files: no backend, no Colyseus, no pipeline, so anything that works
 * here works in a live room.
 *
 * `?static=1` freezes motion and pins DPR/AA for screenshots, `?size=800x500`
 * forces an exact canvas size whatever the window is, and `?state=/path` loads
 * a different same-origin state file. `window.__world.setTexture()` repoints one
 * dino at another texture, exactly as an `avatar-updated` broadcast does live.
 *
 * This page ships in production builds on purpose.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LobbyStateSchema, type LobbyState, type PlayerState } from '@dino/shared';
import { WorldView } from '../world/WorldView.js';
import { worldDebug } from '../world/world-debug.js';

const DEFAULT_STATE_URL = '/debug/world.json';
const TEXTURE_DIR = '/debug/textures';

/** Screenshot mode renders at a fixed size so the baseline can't drift. */
const STATIC_SIZE = { width: 800, height: 500 };

export function DebugWorldPage(): JSX.Element {
  const { frozen, stateUrl, size } = useMemo(readParams, []);
  const [state, setState] = useState<LobbyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** playerId → hash, applied on top of the JSON (runtime swap). */
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetch(stateUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error(`${stateUrl} → HTTP ${response.status}`);
        return LobbyStateSchema.parse(await response.json());
      })
      .then((parsed) => {
        if (!cancelled) setState(parsed);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [stateUrl]);

  // Expose the runtime texture swap to tests and to the on-page buttons.
  useEffect(() => {
    worldDebug.setTexture = (playerId: string, textureHash: string): void => {
      setOverrides((previous) => ({ ...previous, [playerId]: textureHash }));
    };
    return () => {
      delete worldDebug.setTexture;
    };
  }, []);

  const players: PlayerState[] = useMemo(() => {
    const all = Object.values(state?.players ?? {});
    return all.map((player) => {
      const override = overrides[player.id];
      return override === undefined ? player : { ...player, textureHash: override };
    });
  }, [state, overrides]);

  const resolveTextureUrl = useCallback(
    (hash: string): string => `${TEXTURE_DIR}/${hash}.png`,
    [],
  );

  return (
    <main
      className={
        frozen
          ? 'debug-world debug-world--static'
          : size
            ? 'debug-world debug-world--pinned'
            : 'debug-world'
      }
    >
      <div
        className="world-frame"
        data-testid="world-frame"
        style={size ?? (frozen ? STATIC_SIZE : undefined)}
      >
        {error ? (
          <p className="error" data-testid="world-error">
            {error}
          </p>
        ) : (
          <WorldView
            players={players}
            resolveTextureUrl={resolveTextureUrl}
            frozen={frozen}
            stateLoaded={state !== null}
          />
        )}
      </div>

      <aside className="debug-hud" data-testid="world-hud">
        <h1>/debug/world</h1>
        <p>
          {frozen ? 'static (motion frozen)' : 'live (drag to orbit)'} ·{' '}
          <span data-testid="hud-dino-count">{players.length}</span> dinos · state{' '}
          <code>{stateUrl}</code>
        </p>
        <ul>
          {players.map((player) => (
            <li key={player.id}>
              <strong>{player.name}</strong> <em>{player.modelSlug}</em>{' '}
              <code data-testid={`hud-hash-${player.modelSlug}`}>
                {player.textureHash ? player.textureHash.slice(0, 12) : 'no drawing yet'}
              </code>
            </li>
          ))}
        </ul>
      </aside>
    </main>
  );
}

function readParams(): {
  frozen: boolean;
  stateUrl: string;
  size: { width: number; height: number } | null;
} {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('state');
  // Same-origin paths only — this page is shipped to production.
  const stateUrl = requested && requested.startsWith('/') ? requested : DEFAULT_STATE_URL;
  /*
   * `?size=WxH` pins the canvas to an exact pixel size. The camera frames itself
   * from the canvas *aspect*, and the shape that needs proving is a phone in
   * portrait — which this page's own CSS never produces. Capped so a typo cannot
   * ask the GPU for a 100 000 px buffer.
   */
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(params.get('size') ?? '');
  const size = match
    ? { width: Number(match[1]), height: Number(match[2]) }
    : null;
  return { frozen: params.get('static') === '1', stateUrl, size };
}
