/**
 * Thin Redis adapter — the *only* module in the server that knows which Redis
 * client we use.
 *
 * v1 talks to Upstash over its **REST API on port 443** (`@upstash/redis`).
 * This is not a preference: ProtonVPN's tunnel on the dev machine blackholes
 * TCP 6379, so `ioredis`/`node-redis` cannot connect at all (see PLAN.md's
 * Progress Log, 2026-08-18). REST works and round-trips binary data fine.
 *
 * Wave 3 (WS-B) grows this file to the full ~6-function surface:
 *     getTexture / setTexture / addLobbyMember / removeLobbyMember /
 *     listLobbyMembers / publishAvatarUpdate
 * Wave 5 may swap the implementation to `ioredis` on a deploy host with an open
 * 6379 (needed only for multi-instance Colyseus presence) — because everything
 * else imports this interface rather than a client, that stays a one-file change.
 *
 * Wave 1 needs only `ping()`, for `/healthz`.
 */
import { Redis } from '@upstash/redis';
import { env, hasUpstash, requireUpstash } from './env.js';

export interface RedisAdapter {
  /** True when credentials are configured; `/healthz` reports `null` when false. */
  readonly configured: boolean;
  /** Round-trips a PING. Resolves false on any error rather than throwing. */
  ping(): Promise<boolean>;
  /**
   * Escape hatch for Wave 3 while the adapter surface is still growing.
   * Throws when Redis is not configured.
   */
  client(): Redis;
}

class UpstashAdapter implements RedisAdapter {
  readonly configured = true;
  #client: Redis | undefined;

  client(): Redis {
    if (!this.#client) {
      const { url, token } = requireUpstash();
      this.#client = new Redis({ url, token });
    }
    return this.#client;
  }

  async ping(): Promise<boolean> {
    try {
      const pong = await this.client().ping();
      return String(pong).toUpperCase() === 'PONG';
    } catch (err) {
      console.warn('[redis] ping failed:', err instanceof Error ? err.message : err);
      return false;
    }
  }
}

/**
 * Used when no credentials are present (CI, forked PRs, Wave 1–2 local dev).
 * Keeps the server bootable instead of crashing on a missing secret.
 */
class UnconfiguredAdapter implements RedisAdapter {
  readonly configured = false;
  async ping(): Promise<boolean> {
    return false;
  }
  client(): Redis {
    throw new Error('Redis is not configured (UPSTASH_REDIS_REST_URL / _TOKEN missing)');
  }
}

export const redis: RedisAdapter = hasUpstash() ? new UpstashAdapter() : new UnconfiguredAdapter();

/** Handy for logs at boot without leaking the token. */
export const redisTarget = (): string =>
  hasUpstash() ? new URL(env.UPSTASH_REDIS_REST_URL as string).host : 'not configured';
