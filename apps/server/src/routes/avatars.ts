/**
 * `POST /api/avatars` — the multipart upload at the heart of the app.
 *
 * Order of operations (each step's failure mode matters):
 *   0. rate limit by IP              → 429 `rate_limited`, body never read
 *   1. read the multipart body       → structured error, nothing persisted
 *   2. validate PNG + Texture Spec   → structured error, nothing persisted
 *   3. sha256 → content address      → the texture's identity
 *   3b. rate limit by IP + player    → 429 `rate_limited`, nothing persisted
 *   4. lobby lookup                  → 404 / lobby_closed
 *   5. player row (reused if this name is already in this lobby)
 *   6. texture row (shared, content-addressed) + this player's wearer row
 *   7. lobby membership (Postgres + Redis)
 *   8. cache texture bytes in memory + Redis
 *   9. ⚑ in-process fan-out hook for Chunk 3.3
 *
 * Steps 7–9 are best-effort: once the rows are committed the upload has
 * succeeded, and a Redis blip must not tell the phone to re-shoot the drawing.
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  API_ROUTES,
  CreateAvatarFieldsSchema,
  CreateAvatarResponseSchema,
  TEXTURE,
  textureUrlPath,
  type CreateAvatarResponse,
} from '@dino/shared';
import { emitAvatarUpdated } from '../avatar-events.js';
import { avatars, db, hasDatabase, lobbies, lobbyMembers, players, textures } from '../db.js';
import {
  badRequest,
  lobbyClosed,
  notConfigured,
  notFound,
  rateLimited,
  textureInvalid,
  textureTooLarge,
} from '../errors.js';
import { env } from '../env.js';
import { checkTexturePng } from '../png.js';
import {
  IP_LIMIT_MULTIPLIER,
  ipUploadLimiter,
  uploadLimiter,
  type RateLimitDecision,
} from '../rate-limit.js';
import { redis } from '../redis.js';
import { rememberTexture } from '../texture-cache.js';

/** Postgres `unique_violation`. Drizzle nests the driver error under `cause`. */
const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (err: unknown): boolean => {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === UNIQUE_VIOLATION || e?.cause?.code === UNIQUE_VIOLATION;
};

interface MultipartUpload {
  fields: Record<string, string>;
  texture?: Buffer;
  sourcePhoto?: Buffer;
}

/**
 * Drains the whole multipart body before validating anything: field order is
 * the client's choice, so we cannot assume `lobbyCode` arrives before the file.
 */
async function readUpload(request: FastifyRequest): Promise<MultipartUpload> {
  const upload: MultipartUpload = { fields: {} };

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      // `throwFileSizeLimit: false` (see app.ts) means an oversize file arrives
      // silently truncated — the flag is the only way to notice.
      if (part.file.truncated) {
        throw textureTooLarge(`${part.fieldname} exceeds the ${TEXTURE.maxBytes}-byte limit`, {
          field: part.fieldname,
          maxBytes: TEXTURE.maxBytes,
        });
      }
      if (part.fieldname === 'texture') upload.texture = buffer;
      else if (part.fieldname === 'sourcePhoto') upload.sourcePhoto = buffer;
      // Unknown file parts are ignored on purpose (forward compatibility).
    } else {
      upload.fields[part.fieldname] = String(part.value);
    }
  }

  return upload;
}

/**
 * Turns a refused token-bucket decision into the contract's `rate_limited`
 * error, with the `Retry-After` header a well-behaved client honours.
 */
function refuseIfLimited(
  reply: { header(name: string, value: string): unknown },
  decision: RateLimitDecision,
  details: { scope: 'ip' | 'player'; limitPerMinute: number },
): void {
  if (decision.ok) return;
  reply.header('retry-after', String(decision.retryAfterSeconds));
  throw rateLimited('too many uploads — wait a moment and send the drawing again', {
    ...details,
    retryAfterSeconds: decision.retryAfterSeconds,
  });
}

export async function registerAvatarRoutes(app: FastifyInstance): Promise<void> {
  app.post(API_ROUTES.createAvatar, async (request, reply) => {
    if (!hasDatabase()) throw notConfigured('DATABASE_URL');
    if (!request.isMultipart()) {
      throw badRequest('expected multipart/form-data', {
        contentType: request.headers['content-type'] ?? null,
      });
    }

    // 0. rate limit by IP ---------------------------------------------------
    // Before the body is drained on purpose: a phone stuck in a retry loop
    // should cost this server a header parse, not 2 MB of buffering per try.
    // Ten times the per-person allowance, because a whole class shares one
    // school Wi-Fi NAT and must be able to upload at once.
    const ip = request.ip;
    refuseIfLimited(reply, ipUploadLimiter.take(`ip:${ip}`), {
      scope: 'ip',
      limitPerMinute: env.AVATAR_UPLOAD_LIMIT_PER_MIN * IP_LIMIT_MULTIPLIER,
    });

    // 1. body ---------------------------------------------------------------
    const upload = await readUpload(request);

    const fields = CreateAvatarFieldsSchema.safeParse(upload.fields);
    if (!fields.success) {
      throw badRequest('invalid avatar fields', fields.error.flatten().fieldErrors);
    }
    const { lobbyCode, playerName, modelSlug } = fields.data;

    if (!upload.texture) {
      throw badRequest('missing the `texture` file part', { expectedField: 'texture' });
    }

    // 2. texture ------------------------------------------------------------
    const check = checkTexturePng(upload.texture);
    if (!check.ok) {
      const message =
        check.reason === 'too_large'
          ? `texture exceeds ${TEXTURE.maxBytes} bytes`
          : check.reason === 'wrong_dimensions'
            ? `texture must be exactly ${TEXTURE.width}x${TEXTURE.height}`
            : 'texture must be a PNG';
      throw check.reason === 'too_large'
        ? textureTooLarge(message, check.details)
        : textureInvalid(message, { reason: check.reason, ...(check.details as object) });
    }

    // 3. content address ----------------------------------------------------
    const textureBytes = upload.texture;
    const textureHash = createHash('sha256').update(textureBytes).digest('hex');
    if (fields.data.textureHash && fields.data.textureHash !== textureHash) {
      throw textureInvalid('textureHash does not match the uploaded bytes', {
        claimed: fields.data.textureHash,
        actual: textureHash,
      });
    }

    // 3b. rate limit by person ----------------------------------------------
    // The fairness rule: one child cannot spend the hall's whole allowance.
    refuseIfLimited(reply, uploadLimiter.take(`player:${ip}:${lobbyCode}:${playerName}`), {
      scope: 'player',
      limitPerMinute: env.AVATAR_UPLOAD_LIMIT_PER_MIN,
    });

    // 4. lobby --------------------------------------------------------------
    const [lobby] = await db().select().from(lobbies).where(eq(lobbies.code, lobbyCode)).limit(1);
    if (!lobby) throw notFound(`no lobby with code ${lobbyCode}`, { lobbyCode });
    if (lobby.closedAt) throw lobbyClosed(`lobby ${lobbyCode} is closed`, { lobbyCode });

    // 5. player -------------------------------------------------------------
    // A retake is the same human uploading again, so reuse the player row that
    // is already in this lobby under this name instead of cloning the person.
    const [existingMember] = await db()
      .select({ id: players.id, name: players.name, createdAt: players.createdAt })
      .from(lobbyMembers)
      .innerJoin(players, eq(players.id, lobbyMembers.playerId))
      .where(and(eq(lobbyMembers.lobbyId, lobby.id), eq(players.name, playerName)))
      .limit(1);

    const player =
      existingMember ??
      (
        await db()
          .insert(players)
          .values({ name: playerName })
          .returning({ id: players.id, name: players.name, createdAt: players.createdAt })
      )[0];
    if (!player) throw new Error('failed to create player row');

    // 6a. texture -----------------------------------------------------------
    // The blob is content-addressed and **shared** (Wave 5, Chunk 5.2): the row
    // is keyed by the sha256 of its own bytes and says nothing about who drew
    // it, so storing it twice is a no-op rather than a fight over ownership.
    // `onConflictDoNothing` is race-safe against a simultaneous identical
    // upload in a way a SELECT-then-INSERT is not, and the bytes are never
    // rewritten — a different drawing is by definition a different hash.
    await db()
      .insert(textures)
      .values({ hash: textureHash, bytes: textureBytes })
      .onConflictDoNothing({ target: textures.hash });

    // 6b. avatar (the wearer record) ------------------------------------------
    // One row per player — `avatars.player_id` is UNIQUE — so a retake replaces
    // what this child is wearing instead of stacking up history, and two
    // children who upload byte-identical pixels simply *both* point at the same
    // texture. Before the 5.2 split this upserted on `texture_hash`, which made
    // the second uploader steal the first player's only avatar row and left
    // them with no drawing whenever the lobby was rehydrated from Postgres.
    // `source_photo` is only overwritten when this upload actually carried one.
    let avatarRow: typeof avatars.$inferSelect | undefined;
    try {
      [avatarRow] = await db()
        .insert(avatars)
        .values({
          playerId: player.id,
          modelSlug,
          textureHash,
          sourcePhoto: upload.sourcePhoto ?? null,
        })
        .onConflictDoUpdate({
          target: avatars.playerId,
          set: {
            modelSlug,
            textureHash,
            createdAt: new Date(),
            ...(upload.sourcePhoto ? { sourcePhoto: upload.sourcePhoto } : {}),
          },
        })
        .returning();
    } catch (err) {
      // Belt and braces: never surface a 23505 as a 500.
      if (!isUniqueViolation(err)) throw err;
    }
    if (!avatarRow) {
      [avatarRow] = await db().select().from(avatars).where(eq(avatars.playerId, player.id)).limit(1);
    }
    if (!avatarRow) throw new Error('avatar row vanished after a unique-violation retry');

    // 7. membership ---------------------------------------------------------
    await db()
      .insert(lobbyMembers)
      .values({ lobbyId: lobby.id, playerId: player.id })
      .onConflictDoNothing();

    // 8. cache + live membership (best effort) -------------------------------
    // Memory first, and unconditionally: every screen in the lobby is about to
    // ask this process for exactly these bytes, and that fetch is nearly all of
    // the five-second "drawing on the projector" budget.
    rememberTexture(textureHash, textureBytes);
    try {
      await redis.setTexture(textureHash, textureBytes);
      await redis.addLobbyMember(lobbyCode, player.id);
      await redis.publishAvatarUpdate({ lobbyCode, playerId: player.id, modelSlug, textureHash });
    } catch (err) {
      // The row is committed and `GET /api/textures/:hash` falls back to
      // Postgres, so a Redis outage is a slow read, not a lost drawing.
      request.log.warn({ err, textureHash }, 'redis side-effects failed after avatar upload');
    }

    // 9. ⚑ CHUNK 3.3 HOOK — in-process Colyseus fan-out.
    //    No-op until `setAvatarBroadcaster()` is called at boot; see
    //    `src/avatar-events.ts` for exactly what 3.3 needs to register.
    await emitAvatarUpdated({ lobbyCode, playerId: player.id, modelSlug, textureHash });

    const body: CreateAvatarResponse = {
      player: {
        id: player.id,
        name: player.name,
        createdAt: player.createdAt.toISOString(),
      },
      avatar: {
        id: avatarRow.id,
        // Always this uploader since the Chunk 5.2 split: the wearer row is
        // keyed by player, so a duplicate texture can no longer move it.
        playerId: avatarRow.playerId,
        modelSlug,
        textureHash: avatarRow.textureHash,
        createdAt: avatarRow.createdAt.toISOString(),
      },
      textureUrl: textureUrlPath(textureHash),
    };
    return reply.code(201).send(CreateAvatarResponseSchema.parse(body));
  });
}
