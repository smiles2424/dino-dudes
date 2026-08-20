/**
 * One live Colyseus lobby, exposed as plain render data.
 *
 * The interesting part is the **texture gate**. The server both patches
 * `players[*].textureHash` and broadcasts `avatar-updated`; the broadcast
 * exists so a client can fetch the PNG *before* committing the patch. So this
 * hook keeps rendering a player's previous hash until the new bytes are in the
 * texture cache, then releases it — which makes `<Dino>`'s swap resolve from
 * cache and the skin appear in the same frame it is applied. A slow or failed
 * fetch releases the gate anyway ({@link PREFETCH_TIMEOUT_MS}): a broken
 * drawing must show a placeholder, never stall the projector.
 *
 * The output is deliberately the same `PlayerState[]` + `resolveTextureUrl`
 * that `<WorldView>` already takes from the static harness, so live mode needs
 * no bookkeeping of its own and `window.__world` is equally accurate in both.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AvatarUpdatedMessageSchema,
  ROOM_MESSAGES,
  type LobbyJoinOptions,
  type PlayerState,
} from '@dino/shared';
import { loadWorldTexture } from '../world/textures.js';
import type { MotionSource } from '../world/world-motion.js';
import { describeRoomError, joinLobby, readPlayers, textureUrlFor, type LiveMotion } from './room.js';

/** Longest a drawing may hold up its own dino before we render it anyway. */
const PREFETCH_TIMEOUT_MS = 4000;

export type LobbyStatus = 'connecting' | 'connected' | 'error' | 'closed';

export interface LobbyConnection {
  status: LobbyStatus;
  /** Live players, ready to hand straight to `<WorldView players=…>`. */
  players: PlayerState[];
  /**
   * The lobby's shared motion clock. `null` until the room publishes a seed and
   * epoch — or forever against an older server, in which case the wander falls
   * back to page-local timing.
   */
  motion: MotionSource | null;
  /** Set whenever `status` is `error`. `code` is a `ROOM_ERROR_CODES` value. */
  error: { code: number | null; message: string } | null;
  /** Our own `sessionId`, or `null` while connecting / when spectating. */
  sessionId: string | null;
  /** Re-run the join from scratch. */
  retry: () => void;
}

/** What the shared clock looks like to React. Refs carry the live values. */
interface MotionSync {
  seed: string;
  epoch: number;
  offsetMs: number;
  samples: number;
}

const NO_MOTION: MotionSync = { seed: '', epoch: 0, offsetMs: 0, samples: 0 };

export function useLobbyRoom(options: LobbyJoinOptions | null): LobbyConnection {
  const [status, setStatus] = useState<LobbyStatus>('connecting');
  const [players, setPlayers] = useState<PlayerState[]>([]);
  const [sync, setSync] = useState<MotionSync>(NO_MOTION);
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

  /**
   * The live clock estimate. Held in a ref as well as in state so the
   * `nowSeconds` closure handed to the renderer never goes stale between
   * renders — it is called on every frame.
   */
  const syncRef = useRef<MotionSync>(NO_MOTION);
  /** The last `serverTime` seen, so a repeated patch is not a new sample. */
  const lastServerTime = useRef(0);

  /**
   * Re-estimate the offset between the server's clock and ours.
   *
   * `serverTime` is written immediately before the patch is serialized, so a
   * received value is late by at most one network hop — which makes the
   * *largest* offset seen the most accurate, exactly as NTP keeps the sample
   * with the smallest delay. Converges within one server tick.
   */
  const observeClock = useCallback((motion: LiveMotion): void => {
    if (motion.epoch <= 0 || motion.serverTime <= 0) return;
    const current = syncRef.current;

    // A new room (or the first patch) starts the estimate from scratch.
    if (motion.epoch !== current.epoch || motion.seed !== current.seed) {
      lastServerTime.current = motion.serverTime;
      const next: MotionSync = {
        seed: motion.seed,
        epoch: motion.epoch,
        offsetMs: motion.serverTime - Date.now(),
        samples: 1,
      };
      syncRef.current = next;
      setSync(next);
      return;
    }

    if (motion.serverTime === lastServerTime.current) return;
    lastServerTime.current = motion.serverTime;
    const offsetMs = Math.max(current.offsetMs, motion.serverTime - Date.now());
    const next: MotionSync = { ...current, offsetMs, samples: current.samples + 1 };
    syncRef.current = next;
    setSync(next);
  }, []);

  // Re-joining must not be triggered by an unstable object identity.
  const key = options ? JSON.stringify(options) : null;

  /**
   * `regate` and `prefetch` are mutually recursive; the ref breaks the cycle so
   * neither is re-created per render, which would re-run the join.
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
    setSync(NO_MOTION);
    syncRef.current = NO_MOTION;
    lastServerTime.current = 0;
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
          observeClock(snapshot.motion);
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
  }, [key, attempt, regate, observeClock]);

  const retry = useCallback((): void => setAttempt((n) => n + 1), []);

  /**
   * The renderer's view of the shared clock. `nowSeconds` reads the ref, so it
   * stays correct between renders and costs one `Date.now()` per frame.
   */
  const motion = useMemo<MotionSource | null>(() => {
    if (sync.epoch <= 0) return null;
    return {
      seed: sync.seed,
      epoch: sync.epoch,
      offsetMs: sync.offsetMs,
      samples: sync.samples,
      nowSeconds: () =>
        (Date.now() + syncRef.current.offsetMs - syncRef.current.epoch) / 1000,
    };
  }, [sync]);

  return useMemo(
    () => ({ status, players, motion, error, sessionId, retry }),
    [status, players, motion, error, sessionId, retry],
  );
}
