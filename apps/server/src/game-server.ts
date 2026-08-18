/**
 * Colyseus wiring, factored out of `index.ts` so the integration test boots the
 * **real** thing (same room definition, same matchmaking filter, same fan-out
 * registration) instead of a lookalike.
 *
 * Colyseus shares Fastify's underlying `http.Server`: one process, one port,
 * REST and WebSocket side by side (docs/ARCHITECTURE.md §1). The caller decides
 * who calls `listen()` — `index.ts` lets Fastify bind, `@colyseus/testing`'s
 * `boot()` lets the game server bind.
 */
import { Server as ColyseusServer } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import type { FastifyInstance } from 'fastify';
import { LOBBY_ROOM_FILTER, LOBBY_ROOM_NAME } from '@dino/shared';
import { setAvatarBroadcaster } from './avatar-events.js';
import { LobbyRoom, applyAvatarUpdate } from './rooms/LobbyRoom.js';

/**
 * Defines `LobbyRoom` on a Colyseus server and connects the REST→room fan-out.
 *
 * `filterBy(LOBBY_ROOM_FILTER)` is what makes "one room per lobby code" work:
 * `joinOrCreate('lobby', { code })` reuses the room already serving that code
 * and only creates one when there is none.
 */
export function defineRooms(gameServer: ColyseusServer): ColyseusServer {
  gameServer.define(LOBBY_ROOM_NAME, LobbyRoom).filterBy(LOBBY_ROOM_FILTER as string[]);

  // ⚑ The Chunk 3.2 hook: `POST /api/avatars` awaits this after committing.
  // Errors are already caught and logged by `emitAvatarUpdated`.
  setAvatarBroadcaster(async (update) => {
    await applyAvatarUpdate(update);
  });

  return gameServer;
}

/** A Colyseus server sharing `app.server` with Fastify, rooms already defined. */
export function createGameServer(app: FastifyInstance): ColyseusServer {
  return defineRooms(
    new ColyseusServer({
      transport: new WebSocketTransport({ server: app.server }),
    }),
  );
}
