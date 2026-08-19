/**
 * A token bucket, in process, for `POST /api/avatars` (Wave 5, Chunk 5.2).
 *
 * The threat model here is not an attacker — it is one phone in a school hall
 * with a stuck retry loop (or a bored ten-year-old holding "send") filling Neon
 * with megabyte PNGs. So this is deliberately the cheapest thing that works:
 * a `Map` of buckets in this process, no Redis round-trip on the hot path, no
 * dependency. v1 runs a single server; if 5.3 ever runs two, each gets its own
 * bucket and the effective limit doubles, which is fine for this purpose.
 *
 * Two buckets are consumed per upload (see `routes/avatars.ts`):
 *   • by client IP, *before* the multipart body is read — so a flood costs the
 *     server a header parse rather than 2 MB of buffering;
 *   • by IP + lobby + player name, after the fields parse — the person.
 *
 * The per-IP allowance is deliberately **ten times** the per-person one: at the
 * venue an entire class shares one Wi-Fi NAT, so a strict per-IP limit would
 * refuse a room full of children legitimately uploading at once. The per-person
 * bucket is what actually stops one phone hammering the server.
 *
 * Refill is continuous (fractional tokens), not a fixed window, so a child who
 * uploads, thinks, and uploads again is never told to wait.
 */
import { env } from './env.js';

export interface RateLimitDecision {
  ok: boolean;
  /** Whole tokens left after this call (0 when refused). */
  remaining: number;
  /** Seconds until one token is available again; 0 when `ok`. */
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  /** Tokens added per minute — also the sustained rate. `0` disables entirely. */
  perMinute: number;
  /** Bucket size, i.e. how big a burst is allowed. Defaults to `perMinute`. */
  burst?: number;
  /** Injectable clock, so tests do not have to sleep. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimiter {
  /** Spends one token for `key`. */
  take(key: string): RateLimitDecision;
  /** True when this limiter is turned off (`perMinute <= 0`). */
  readonly disabled: boolean;
  /** Live bucket count — diagnostics and the sweep test. */
  readonly size: number;
  reset(): void;
}

/** Idle buckets are dropped after this long; a full bucket carries no state. */
const IDLE_SWEEP_MS = 10 * 60_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const perMinute = options.perMinute;
  const capacity = Math.max(1, options.burst ?? perMinute);
  const now = options.now ?? Date.now;
  const perMs = perMinute / 60_000;
  const buckets = new Map<string, Bucket>();
  const disabled = perMinute <= 0;

  const sweep = (at: number): void => {
    for (const [key, bucket] of buckets) {
      if (at - bucket.updatedAt > IDLE_SWEEP_MS) buckets.delete(key);
    }
  };

  return {
    disabled,
    get size() {
      return buckets.size;
    },
    reset() {
      buckets.clear();
    },
    take(key: string): RateLimitDecision {
      if (disabled) return { ok: true, remaining: capacity, retryAfterSeconds: 0 };

      const at = now();
      const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: at };
      bucket.tokens = Math.min(capacity, bucket.tokens + (at - bucket.updatedAt) * perMs);
      bucket.updatedAt = at;

      // Cheap housekeeping: a party is tens of keys, so an occasional full scan
      // costs nothing and keeps a long-running server from growing a map of
      // every IP that ever uploaded.
      if (buckets.size > 256) sweep(at);

      if (bucket.tokens < 1) {
        buckets.set(key, bucket);
        return {
          ok: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000)),
        };
      }

      bucket.tokens -= 1;
      buckets.set(key, bucket);
      return { ok: true, remaining: Math.floor(bucket.tokens), retryAfterSeconds: 0 };
    },
  };
}

/**
 * Per **person** (IP + lobby + name) — the limiter that matters.
 *
 * `AVATAR_UPLOAD_LIMIT_PER_MIN` (see `env.ts`) defaults to 0 — off — under
 * `NODE_ENV=test`, because E2E specs upload as fast as they can and a flaky
 * 429 would make the suite lie. Everywhere else it defaults to 12/min with a
 * burst of 6, which is far more than a child retaking a photo will ever need.
 */
export const uploadLimiter: RateLimiter = createRateLimiter({
  perMinute: env.AVATAR_UPLOAD_LIMIT_PER_MIN,
  burst: Math.max(1, Math.ceil(env.AVATAR_UPLOAD_LIMIT_PER_MIN / 2)),
});

/** How much more one *address* may do than one person. See the file header. */
export const IP_LIMIT_MULTIPLIER = 10;

/** Per source address — the cheap flood guard, not the fairness rule. */
export const ipUploadLimiter: RateLimiter = createRateLimiter({
  perMinute: env.AVATAR_UPLOAD_LIMIT_PER_MIN * IP_LIMIT_MULTIPLIER,
  burst: Math.max(1, Math.ceil((env.AVATAR_UPLOAD_LIMIT_PER_MIN * IP_LIMIT_MULTIPLIER) / 2)),
});
