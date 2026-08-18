/**
 * Thin Redis adapter — the *only* module in the server that knows which Redis
 * client we use.
 *
 * v1 talks to Upstash over its **REST API on port 443** (`@upstash/redis`).
 * This is not a preference: ProtonVPN's tunnel on the dev machine blackholes
 * TCP 6379, so `ioredis`/`node-redis` cannot connect at all (see PLAN.md's
 * Progress Log, 2026-08-18). REST works and round-trips binary data fine.
 *
 * Wave 5 may swap the implementation to `ioredis` on a deploy host with an open
 * 6379 (needed only for multi-instance Colyseus presence) — because everything
 * else imports this interface rather than a client, that stays a one-file change.
 *
 * Keyspace (docs/ARCHITECTURE.md §3):
 *   texture:{hash}         → PNG bytes, base64-wrapped, TTL 24 h
 *   lobby:{code}:players   → SET of player ids
 *   channel avatar:updates → pub/sub {lobbyCode, playerId, modelSlug, textureHash}
 */
import { Redis } from '@upstash/redis';
import { env, hasUpstash, requireUpstash } from './env.js';

/** TTL for cached texture bytes. Content-addressed, so expiry is only a cost control. */
export const TEXTURE_TTL_SECONDS = 24 * 60 * 60;

/** Channel name for avatar fan-out. Colyseus subscribes to this once we go multi-instance. */
export const AVATAR_UPDATES_CHANNEL = 'avatar:updates';

export const textureKey = (hash: string): string => `texture:${hash}`;
export const lobbyPlayersKey = (code: string): string => `lobby:${code}:players`;

/** Payload published on `avatar:updates`. Shape fixed by docs/ARCHITECTURE.md §3. */
export interface AvatarUpdate {
  lobbyCode: string;
  playerId: string;
  modelSlug: string;
  textureHash: string;
}

/**
 * Binary safety: Upstash's REST transport is JSON, so bytes travel as base64.
 * The `b64:` prefix guarantees the stored value can never be mistaken for JSON
 * by the client's automatic deserialization (a bare base64 string of only
 * digits would otherwise come back as a `number`).
 */
const B64_PREFIX = 'b64:';
const encodeBytes = (bytes: Buffer): string => B64_PREFIX + bytes.toString('base64');
const decodeBytes = (value: string): Buffer =>
  Buffer.from(value.startsWith(B64_PREFIX) ? value.slice(B64_PREFIX.length) : value, 'base64');

export interface RedisAdapter {
  /** True when credentials are configured; `/healthz` reports `null` when false. */
  readonly configured: boolean;
  /** Round-trips a PING. Resolves false on any error rather than throwing. */
  ping(): Promise<boolean>;

  /** Cached texture bytes for a sha256 content hash, or `null` on a cache miss. */
  getTexture(hash: string): Promise<Buffer | null>;
  /** Caches texture bytes under its content hash. `ttlSeconds` defaults to 24 h. */
  setTexture(hash: string, bytes: Buffer, ttlSeconds?: number): Promise<void>;

  /** Adds a player to a lobby's live membership set. Returns true if newly added. */
  addLobbyMember(lobbyCode: string, playerId: string): Promise<boolean>;
  /** Removes a player from a lobby's live membership set. Returns true if present. */
  removeLobbyMember(lobbyCode: string, playerId: string): Promise<boolean>;
  /** Current live membership of a lobby (unordered). */
  listLobbyMembers(lobbyCode: string): Promise<string[]>;

  /** Publishes an avatar update; resolves the number of subscribers that got it. */
  publishAvatarUpdate(update: AvatarUpdate): Promise<number>;

  /** Deletes keys. Used by lobby teardown and by integration-test cleanup. */
  del(...keys: string[]): Promise<number>;

  /**
   * Escape hatch for anything the adapter doesn't cover yet.
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

  async getTexture(hash: string): Promise<Buffer | null> {
    const value = await this.client().get<string>(textureKey(hash));
    if (value == null) return null;
    return decodeBytes(String(value));
  }

  async setTexture(hash: string, bytes: Buffer, ttlSeconds = TEXTURE_TTL_SECONDS): Promise<void> {
    await this.client().set(textureKey(hash), encodeBytes(bytes), { ex: ttlSeconds });
  }

  async addLobbyMember(lobbyCode: string, playerId: string): Promise<boolean> {
    const added = await this.client().sadd(lobbyPlayersKey(lobbyCode), playerId);
    return Number(added) > 0;
  }

  async removeLobbyMember(lobbyCode: string, playerId: string): Promise<boolean> {
    const removed = await this.client().srem(lobbyPlayersKey(lobbyCode), playerId);
    return Number(removed) > 0;
  }

  async listLobbyMembers(lobbyCode: string): Promise<string[]> {
    const members = await this.client().smembers<string[]>(lobbyPlayersKey(lobbyCode));
    return (members ?? []).map(String);
  }

  async publishAvatarUpdate(update: AvatarUpdate): Promise<number> {
    const receivers = await this.client().publish(AVATAR_UPDATES_CHANNEL, JSON.stringify(update));
    return Number(receivers);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return Number(await this.client().del(...keys));
  }
}

/**
 * Used when no credentials are present (CI, forked PRs, local dev without a
 * `.env`). Keeps the server bootable instead of crashing on a missing secret:
 * reads look like permanent cache misses and writes are no-ops.
 */
class UnconfiguredAdapter implements RedisAdapter {
  readonly configured = false;
  async ping(): Promise<boolean> {
    return false;
  }
  async getTexture(): Promise<Buffer | null> {
    return null;
  }
  async setTexture(): Promise<void> {
    /* no-op */
  }
  async addLobbyMember(): Promise<boolean> {
    return false;
  }
  async removeLobbyMember(): Promise<boolean> {
    return false;
  }
  async listLobbyMembers(): Promise<string[]> {
    return [];
  }
  async publishAvatarUpdate(): Promise<number> {
    return 0;
  }
  async del(): Promise<number> {
    return 0;
  }
  client(): Redis {
    throw new Error('Redis is not configured (UPSTASH_REDIS_REST_URL / _TOKEN missing)');
  }
}

export const redis: RedisAdapter = hasUpstash() ? new UpstashAdapter() : new UnconfiguredAdapter();

/** Handy for logs at boot without leaking the token. */
export const redisTarget = (): string =>
  hasUpstash() ? new URL(env.UPSTASH_REDIS_REST_URL as string).host : 'not configured';
