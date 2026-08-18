/**
 * `GET /api/textures/:hash` — the content-addressed texture CDN.
 *
 * Redis is the cache, Postgres the store. Because the URL *is* the sha256 of
 * the bytes, the response can be immutable-cached forever: a different drawing
 * is a different URL, so no client ever has to revalidate.
 */
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { API_ROUTES, GetTextureParamsSchema, TEXTURE } from '@dino/shared';
import { avatars, db, hasDatabase } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { redis } from '../redis.js';

/** One year, the maximum browsers honour, plus `immutable` to kill revalidation. */
export const TEXTURE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export async function registerTextureRoutes(app: FastifyInstance): Promise<void> {
  app.get(API_ROUTES.getTexture, async (request, reply) => {
    const parsed = GetTextureParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      throw badRequest('invalid texture hash', parsed.error.flatten().fieldErrors);
    }
    const { hash } = parsed.data;
    const etag = `"${hash}"`;

    // Content-addressed: if the client already has this hash it has the bytes.
    if (request.headers['if-none-match'] === etag) {
      return reply.code(304).header('cache-control', TEXTURE_CACHE_CONTROL).header('etag', etag).send();
    }

    let bytes: Buffer | null = null;
    try {
      bytes = await redis.getTexture(hash);
    } catch (err) {
      // A cache that is down is a slow read, never a failed one.
      request.log.warn({ err, hash }, 'redis texture lookup failed; falling back to postgres');
    }

    if (!bytes && hasDatabase()) {
      const [row] = await db()
        .select({ texture: avatars.texture })
        .from(avatars)
        .where(eq(avatars.textureHash, hash))
        .limit(1);
      if (row) {
        bytes = row.texture;
        // Re-warm the cache so the next reader (every other phone in the lobby,
        // seconds later) is served from Redis.
        try {
          await redis.setTexture(hash, bytes);
        } catch (err) {
          request.log.warn({ err, hash }, 'failed to re-warm texture cache');
        }
      }
    }

    if (!bytes) throw notFound(`no texture with hash ${hash}`, { hash });

    return reply
      .header('content-type', TEXTURE.mimeType)
      .header('cache-control', TEXTURE_CACHE_CONTROL)
      .header('etag', etag)
      .header('content-length', String(bytes.length))
      .send(bytes);
  });
}
