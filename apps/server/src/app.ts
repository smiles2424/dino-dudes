/**
 * Fastify app factory. Kept separate from `index.ts` so integration tests
 * (`fastify.inject`) and `@colyseus/testing` can build an app without binding
 * a port.
 */
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { API_ROUTES, ApiErrorSchema, HealthSchema, TEXTURE, type ApiError, type Health } from '@dino/shared';
import { dbPing } from './db.js';
import { env, hasDatabase } from './env.js';
import { ApiProblem } from './errors.js';
import { redis } from './redis.js';
import { registerAvatarRoutes } from './routes/avatars.js';
import { registerLobbyRoutes } from './routes/lobbies.js';
import { registerTextureRoutes } from './routes/textures.js';

const startedAt = Date.now();
const VERSION: string = process.env['npm_package_version'] ?? '0.1.0';

export async function buildApp(): Promise<FastifyInstance> {
  // `NODE_TEST_CONTEXT` is set by `node --test`, so integration runs are quiet
  // without every test file having to remember to set NODE_ENV (which is
  // awkward to do cross-platform from an npm script).
  const quiet = env.NODE_ENV === 'test' || Boolean(process.env['NODE_TEST_CONTEXT']);
  const app = Fastify({
    logger: { level: quiet ? 'warn' : 'info' },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',').map((s) => s.trim()),
  });

  await app.register(multipart, {
    limits: {
      // The Texture Spec's ceiling. `throwFileSizeLimit: false` hands us a
      // truncated stream instead of an exception, so the route can answer with
      // the contract's `texture_too_large` rather than a plugin error.
      fileSize: TEXTURE.maxBytes,
      files: 2, // `texture` + the optional `sourcePhoto`
      fields: 8,
    },
    throwFileSizeLimit: false,
  });

  // ── Every error a client sees is `ApiErrorSchema` ────────────────────────
  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ApiProblem) {
      request.log.info({ err: error, code: error.code }, 'api problem');
      return reply.code(error.statusCode).send(ApiErrorSchema.parse(error.toBody()));
    }

    const err = error as { statusCode?: number; message?: string };
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) request.log.error({ err: error }, 'unhandled route error');

    const body: ApiError = {
      error: status === 400 ? 'bad_request' : status === 404 ? 'not_found' : 'internal',
      // 5xx messages can carry internals (Drizzle embeds the whole query,
      // including texture bytes, in its message) — never echo those out.
      message: status >= 500 ? 'internal server error' : (err.message ?? 'request failed'),
    };
    return reply.code(status).send(ApiErrorSchema.parse(body));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(
      ApiErrorSchema.parse({
        error: 'not_found',
        message: `no route for ${request.method} ${request.url}`,
      } satisfies ApiError),
    ),
  );

  app.get(API_ROUTES.health, async (): Promise<Health> => {
    // `null` == "not configured in this environment" (CI / secret-less dev),
    // which is deliberately NOT the same as "configured but unreachable" —
    // that distinction is what keeps E2E #1 green without secrets.
    const [redisOk, postgresOk] = await Promise.all([
      redis.configured ? redis.ping() : Promise.resolve(null),
      hasDatabase() ? dbPing() : Promise.resolve(null),
    ]);

    const body: Health = {
      status: redisOk === false || postgresOk === false ? 'degraded' : 'ok',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      version: VERSION,
      checks: { redis: redisOk, postgres: postgresOk },
    };
    // Parsing our own response keeps the server honest against the frozen contract.
    return HealthSchema.parse(body);
  });

  await registerLobbyRoutes(app);
  await registerAvatarRoutes(app);
  await registerTextureRoutes(app);

  return app;
}
