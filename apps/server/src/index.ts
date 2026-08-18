/**
 * Server entrypoint — Fastify (REST) + Colyseus (WebSocket) in one process.
 *
 * Colyseus needs a long-lived stateful process, so both live together and share
 * Fastify's underlying `http.Server`. Wave 3 adds the real API routes; Wave 1
 * ships `/healthz` and an empty `LobbyRoom`.
 */
import { Server as ColyseusServer } from 'colyseus';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { API_ROUTES, HealthSchema, LOBBY_ROOM_NAME, type Health } from '@dino/shared';
import { buildApp } from './app.js';
import { env } from './env.js';
import { redisTarget } from './redis.js';
import { LobbyRoom } from './rooms/LobbyRoom.js';

async function main(): Promise<void> {
  const app = await buildApp();

  // Fastify must be listening before Colyseus can attach to its http.Server.
  await app.listen({ port: env.PORT, host: env.HOST });

  const gameServer = new ColyseusServer({
    transport: new WebSocketTransport({ server: app.server }),
  });
  gameServer.define(LOBBY_ROOM_NAME, LobbyRoom);

  app.log.info(
    { port: env.PORT, redis: redisTarget(), colyseus: LOBBY_ROOM_NAME },
    'dino-dudes server ready',
  );

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      await gameServer.gracefullyShutdown(false);
    } catch (err) {
      app.log.warn({ err }, 'colyseus shutdown failed');
    }
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error('fatal:', err);
  process.exit(1);
});

export { API_ROUTES, HealthSchema, type Health };
