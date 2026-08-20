/**
 * An in-process token bucket for `POST /api/avatars`.
 *
 * The threat model is not an attacker — it is one phone in a school hall with a
 * stuck retry loop filling Neon with megabyte PNGs — so this is deliberately
 * the cheapest thing that works: a `Map` in this process, no Redis on the hot
 * path. v1 runs one server; a second instance would get its own buckets and
 * double the effective limit, which is acceptable for this purpose.
 *
 * The per-IP allowance is ten times the per-person one because an entire class
 * shares one Wi-Fi NAT at the venue, so a strict per-IP limit would refuse a
 * room full of children uploading legitimately. The per-person bucket is what
 * actually stops one phone hammering the server. Refill is continuous rather
 * than a fixed window, so a child who uploads, thinks, then uploads again is
 * never told to wait.
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

      // A party is tens of keys, so an occasional full scan costs nothing and
      // keeps a long-running server from growing a map of every IP it ever saw.
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
 * Defaults to off under `NODE_ENV=test`, because E2E specs upload as fast as
 * they can and a flaky 429 would make the suite lie. Elsewhere 12/min with a
 * burst of 6, far more than a child retaking a photo will ever need.
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
