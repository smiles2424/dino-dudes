/**
 * The client half of the Colyseus contract (Wave 4, Chunk 4.1).
 *
 * Everything that knows about `colyseus.js` lives here or in
 * {@link ./useLobbyRoom.ts}; React components only ever see plain
 * {@link PlayerState} objects — the exact same shape `/debug/world` feeds the
 * renderer from a static JSON file. That is what makes the harness and the
 * live game view share 100 % of the rendering code.
 *
 * `colyseus.js` is pinned to the **0.16** line on purpose: 0.17 drags in
 * `@colyseus/core@0.17`, which cannot talk to the server's `colyseus@0.16.5`.
 */
import { Client, type Room } from 'colyseus.js';
import { z } from 'zod';
import {
  LOBBY_ROOM_NAME,
  LobbyJoinOptionsSchema,
  LobbyStateSchema,
  PlayerStateSchema,
  ROOM_ERROR_CODES,
  textureUrlPath,
  type LobbyJoinOptions,
  type PlayerState,
} from '@dino/shared';
import { API_BASE } from '../api.js';

/**
 * Colyseus endpoint. Defaults to the API origin with the scheme swapped, so a
 * deployment only has to set `VITE_API_URL` — REST and WebSocket are served by
 * one `http.Server` (docs/ARCHITECTURE.md §2).
 */
export const WS_BASE: string =
  import.meta.env['VITE_WS_URL'] ?? API_BASE.replace(/^http/, 'ws');

/** Where a content-addressed drawing lives. Immutable, cacheable forever. */
export const textureUrlFor = (hash: string): string => `${API_BASE}${textureUrlPath(hash)}`;

/**
 * The live state, parsed with the frozen contract but with **`name` relaxed**.
 *
 * `PlayerStateSchema.name` is `min(1)` because a person always has a name, yet
 * the room legitimately creates a nameless entry for a heartbeat: when an
 * HTTP-only uploader is faned out before their Postgres row can be read back,
 * `receiveAvatarUpdate` sets `name = ''` and fills it in a moment later. That
 * is a real, renderable dino (blank nameplate), not drift — so it is relaxed
 * here rather than being allowed to blank the whole projector.
 */
const LivePlayerSchema = PlayerStateSchema.extend({ name: z.string() });
const LiveStateSchema = LobbyStateSchema.extend({
  players: z.record(z.string(), LivePlayerSchema),
});

/** The room's shared motion clock, as carried in state (Wave 5, Chunk 5.1). */
export interface LiveMotion {
  seed: string;
  /** Server-clock ms the wander is timed from. `0` == no server clock. */
  epoch: number;
  /** The server's wall clock as of this patch. `0` == not set yet. */
  serverTime: number;
}

export interface LiveSnapshot {
  players: PlayerState[];
  motion: LiveMotion;
  error: string | null;
}

/**
 * Turn a Colyseus state snapshot into the renderer's player list plus the
 * lobby's motion clock.
 *
 * Order is stable (sorted by player id) so React never remounts a dino just
 * because the server's map iteration order changed.
 */
export function readPlayers(snapshot: unknown): LiveSnapshot {
  const parsed = LiveStateSchema.safeParse(snapshot);
  if (!parsed.success) {
    return {
      players: [],
      motion: { seed: '', epoch: 0, serverTime: 0 },
      error: `room state does not match the shared contract: ${parsed.error.issues
        .map((issue) => issue.path.join('.'))
        .join(', ')}`,
    };
  }
  const players = Object.values(parsed.data.players).sort((a, b) => a.id.localeCompare(b.id));
  return {
    players,
    motion: {
      seed: parsed.data.motionSeed,
      epoch: parsed.data.motionEpoch,
      serverTime: parsed.data.serverTime,
    },
    error: null,
  };
}

/** A live room handle. The state type is read through {@link readPlayers}. */
export type LobbyRoomHandle = Room<unknown>;

/** Open a room for `options.code`. Rejects with a Colyseus `ServerError`. */
export async function joinLobby(options: LobbyJoinOptions): Promise<LobbyRoomHandle> {
  const parsed = LobbyJoinOptionsSchema.parse(options);
  const client = new Client(WS_BASE);
  return client.joinOrCreate(LOBBY_ROOM_NAME, parsed);
}

/**
 * A room error the human can act on.
 *
 * The server refuses a join with a structured `ServerError` (`ROOM_ERROR_CODES`),
 * which `colyseus.js` surfaces as `err.code`. Anything else — a dead server, a
 * dropped Wi-Fi — has no code, and the honest message is "we lost the server".
 */
export function describeRoomError(cause: unknown): { code: number | null; message: string } {
  const err = cause as { code?: unknown; message?: unknown };
  const code = typeof err?.code === 'number' ? err.code : null;

  switch (code) {
    case ROOM_ERROR_CODES.lobbyNotFound:
      return { code, message: 'No lobby with that code. Check the code on the big screen.' };
    case ROOM_ERROR_CODES.lobbyClosed:
      return { code, message: 'That lobby has been closed.' };
    case ROOM_ERROR_CODES.invalidJoinOptions:
      return { code, message: 'That join code is not a valid lobby code.' };
    default:
      return {
        code,
        message:
          typeof err?.message === 'string' && err.message
            ? `Could not reach the game server: ${err.message}`
            : 'Could not reach the game server.',
      };
  }
}
