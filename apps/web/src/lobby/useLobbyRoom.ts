/**
 * `useLobbyRoom` — one live Colyseus lobby, exposed as plain render data.
 *
 * ── The texture gate ───────────────────────────────────────────────────────
 * The server does two things when someone's drawing lands: it patches
 * `players[*].textureHash` in synchronized state **and** it broadcasts
 * `avatar-updated`. The broadcast exists precisely so a client can start
 * fetching the PNG before it commits the patch, so this hook:
 *
 *   1. starts `loadWorldTexture(<the hash's URL>)` the instant the broadcast
 *      arrives (and for every already-drawn player on join);
 *   2. keeps rendering the player's *previous* hash until those bytes are in
 *      the texture cache;
 *   3. then releases the new hash, so `<Dino>`'s swap resolves from cache and
 *      the skin appears in the same frame it is applied.
 *
 * A failed or slow fetch releases the gate anyway (see `PREFETCH_TIMEOUT_MS`):
 * a broken drawing must show a placeholder dino, never stall the projector.
 *
 * ── Sharing with `/debug/world` ────────────────────────────────────────────
 * The hook's output is `PlayerState[]` + a `resolveTextureUrl` function — byte
 * for byte the props `<WorldView>` already takes from the static harness. All
 * of `window.__world` is maintained inside `WorldView`/`Dino`, so it is exactly
 * as accurate here as it is there, with no live-mode-specific bookkeeping.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AvatarUpdatedMessageSchema,
  ROOM_MESSAGES,
  type LobbyJoinOptions,
  type PlayerState,
} from '@dino/shared';
import { loadWorldTexture } from '../world/textures.js';
import { describeRoomError, joinLobby, readPlayers, textureUrlFor } from './room.js';

/** Longest a drawing may hold up its own dino before we render it anyway. */
const PREFETCH_TIMEOUT_MS = 4000;

export type LobbyStatus = 'connecting' | 'connected' | 'error' | 'closed';

export interface LobbyConnection {
  status: LobbyStatus;
  /** Live players, ready to hand straight to `<WorldView players=…>`. */
  players: PlayerState[];
  /** Set whenever `status` is `error`. `code` is a `ROOM_ERROR_CODES` value. */
  error: { code: number | null; message: string } | null;
  /** Our own `sessionId`, or `null` while connecting / when spectating. */
  sessionId: string | null;
  /** Re-run the join from scratch. */
  retry: () => void;
}

export function useLobbyRoom(options: LobbyJoinOptions | null): LobbyConnection {
  const [status, setStatus] = useState<LobbyStatus>('connecting');
  const [players, setPlayers] = useState<PlayerState[]>([]);
  const [error, setError] = useState<LobbyConnection['error']>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  /** Hashes whose bytes are in the texture cache (or known to be broken). */
  const readyHashes = useRef(new Set<string>());
  /** Hashes currently being prefetched. */
  const inFlight = useRef(new Set<string>());
  /** playerId → the hash we are currently *showing* (lags during a prefetch). */
  const shown = useRef(new Map<string, string>());
  /** The newest untouched snapshot, so a finished prefetch can re-gate it. */
  const latest = useRef<PlayerState[]>([]);

  // Re-joining must not be triggered by an unstable object identity.
  const key = options ? JSON.stringify(options) : null;

  /**
   * `regate` and `prefetch` are mutually recursive. The ref breaks the cycle so
   * neither has to be re-created on every render (which would re-run the join).
   */
  const prefetchRef = useRef<(hash: string) => void>(() => undefined);

  const regate = useCallback((): void => {
    setPlayers(
      latest.current.map((player) => {
        const hash = player.textureHash;
        if (hash === '' || readyHashes.current.has(hash)) {
          shown.current.set(player.id, hash);
          return player;
        }
        prefetchRef.current(hash);
        // Hold the previous skin (usually the placeholder) one beat longer.
        return { ...player, textureHash: shown.current.get(player.id) ?? '' };
      }),
    );
  }, []);

  const prefetch = useCallback(
    (hash: string): void => {
      if (hash === '' || readyHashes.current.has(hash) || inFlight.current.has(hash)) return;
      inFlight.current.add(hash);

      const release = (): void => {
        inFlight.current.delete(hash);
        // Even a failure counts as "resolved": `<Dino>` retries and records the
        // real reason in `window.__world.textureErrors`.
        readyHashes.current.add(hash);
        regate();
      };

      void Promise.race([
        loadWorldTexture(textureUrlFor(hash)),
        new Promise((resolve) => setTimeout(resolve, PREFETCH_TIMEOUT_MS)),
      ]).then(release, release);
    },
    [regate],
  );

  prefetchRef.current = prefetch;

  useEffect(() => {
    if (key === null) {
      setStatus('connecting');
      return;
    }

    let cancelled = false;
    let room: Awaited<ReturnType<typeof joinLobby>> | null = null;

    setStatus('connecting');
    setError(null);
    setPlayers([]);
    latest.current = [];
    shown.current.clear();

    void joinLobby(JSON.parse(key) as LobbyJoinOptions)
      .then((joined) => {
        room = joined;
        // StrictMode's double-mount (dev only) lands here: leave immediately
        // rather than leaving a ghost spectator in the room.
        if (cancelled) {
          void joined.leave();
          return;
        }

        setSessionId(joined.sessionId);
        setStatus('connected');

        joined.onStateChange((state: unknown) => {
          const snapshot = readPlayers((state as { toJSON: () => unknown }).toJSON());
          if (snapshot.error) {
            console.warn('[lobby]', snapshot.error);
            return;
          }
          latest.current = snapshot.players;
          // Everyone already wearing a drawing when we walked in.
          for (const player of snapshot.players) prefetchRef.current(player.textureHash);
          regate();
        });

        joined.onMessage(ROOM_MESSAGES.avatarUpdated, (raw: unknown) => {
          const message = AvatarUpdatedMessageSchema.safeParse(raw);
          if (!message.success) return;
          // The whole reason this broadcast exists: get the bytes moving before
          // the state patch that needs them is applied.
          prefetchRef.current(message.data.textureHash);
        });

        joined.onError((code: number, message?: string) => {
          setError(describeRoomError({ code, message }));
          setStatus('error');
        });

        joined.onLeave(() => {
          if (cancelled) return;
          setStatus((current) => (current === 'error' ? current : 'closed'));
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(describeRoomError(cause));
        setStatus('error');
      });

    return () => {
      cancelled = true;
      void room?.leave();
    };
  }, [key, attempt, regate]);

  const retry = useCallback((): void => setAttempt((n) => n + 1), []);

  return useMemo(
    () => ({ status, players, error, sessionId, retry }),
    [status, players, error, sessionId, retry],
  );
}
