/**
 * Server entrypoint — Fastify (REST) + Colyseus (WebSocket) in one process.
 *
 * Colyseus needs a long-lived stateful process, so both live together and share
 * Fastify's underlying `http.Server`. Wave 3 adds the real API routes; Wave 1
 * ships `/healthz` and an empty `LobbyRoom`.
 */
import { API_ROUTES, HealthSchema, LOBBY_ROOM_NAME, type Health } from '@dino/shared';
import { buildApp } from './app.js';
import { env } from './env.js';
import { createGameServer } from './game-server.js';
import { redisTarget } from './redis.js';

async function main(): Promise<void> {
  const app = await buildApp();

  // Fastify must be listening before Colyseus can attach to its http.Server.
  await app.listen({ port: env.PORT, host: env.HOST });

  // Defines `LobbyRoom` (filtered by lobby code) and registers the
  // `POST /api/avatars` → room fan-out. See `game-server.ts`.
  const gameServer = createGameServer(app);

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
