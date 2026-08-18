/**
 * Fastify app factory. Kept separate from `index.ts` so Wave 3's
 * `@colyseus/testing` integration tests can build an app without binding a port.
 */
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { API_ROUTES, HealthSchema, type Health } from '@dino/shared';
import { env, hasDatabase } from './env.js';
import { redis } from './redis.js';

const startedAt = Date.now();
const VERSION: string = process.env['npm_package_version'] ?? '0.1.0';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'test' ? 'warn' : 'info' },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
  });

  app.get(API_ROUTES.health, async (): Promise<Health> => {
    // `null` == "not configured in this environment" (CI / secret-less dev),
    // which is deliberately NOT the same as "configured but unreachable".
    const redisOk = redis.configured ? await redis.ping() : null;
    // Wave 3 replaces this with a real `SELECT 1` once Drizzle is wired up.
    const postgresOk = hasDatabase() ? null : null;

    const body: Health = {
      status: redisOk === false ? 'degraded' : 'ok',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      version: VERSION,
      checks: { redis: redisOk, postgres: postgresOk },
    };
    // Parsing our own response keeps the server honest against the frozen contract.
    return HealthSchema.parse(body);
  });

  return app;
}
