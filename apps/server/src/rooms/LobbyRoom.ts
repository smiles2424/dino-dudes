/**
 * `LobbyRoom` — the live shared world for one lobby (Wave 3, Chunk 3.3).
 *
 * ── Identity model ─────────────────────────────────────────────────────────
 * `state.players` is keyed two ways on purpose:
 *
 *   • by Colyseus **sessionId** — a client connected over WebSocket right now;
 *   • by **playerId** (a uuid) — someone who is *in* the lobby but has no live
 *     socket: they uploaded a drawing over plain HTTP from their phone, or they
 *     uploaded and then closed the tab. Their dino must stay on the projector.
 *
 * The two key spaces cannot collide (Colyseus sessionIds are 9 characters, a
 * playerId is a 36-character uuid), and {@link keyIsPlayerId} tells them apart.
 *
 * ── Message flow ───────────────────────────────────────────────────────────
 *   client → joinOrCreate('lobby', { code, name?, modelSlug?, playerId? })
 *   client → 'select-model' { modelSlug }        → patches their PlayerState
 *   client → 'move' { position, heading }        → patches their PlayerState
 *   HTTP   → POST /api/avatars → emitAvatarUpdated() → {@link applyAvatarUpdate}
 *            → patches textureHash/modelSlug in state AND broadcasts
 *              'avatar-updated' to every client in that lobby.
 *
 * The room is the *only* place that knows a lobby code maps to a room; the API
 * route layer stays oblivious and just calls the `avatar-events` hook.
 */
import { createHash, randomUUID } from 'node:crypto';
import { MapSchema, Schema, defineTypes } from '@colyseus/schema';
import { Room, ServerError, type Client } from 'colyseus';
import { and, eq } from 'drizzle-orm';
import {
  LOBBY_ROOM_NAME,
  LobbyJoinOptionsSchema,
  ROOM_ERROR_CODES,
  ROOM_MESSAGES,
  MoveMessageSchema,
  SelectModelMessageSchema,
  type AvatarUpdatedMessage,
  type LobbyJoinOptions,
} from '@dino/shared';
import { db, hasDatabase, lobbies, lobbyMembers, players } from '../db.js';
import { redis } from '../redis.js';

// ── Synchronized state ─────────────────────────────────────────────────────
// Mirrors `LobbyStateSchema` in `@dino/shared`; keep them structurally equal.
// `defineTypes` rather than decorators, so no decorator compiler flags.

export class Vec3 extends Schema {
  x = 0;
  y = 0;
  z = 0;
}
defineTypes(Vec3, { x: 'number', y: 'number', z: 'number' });

export class PlayerState extends Schema {
  id = '';
  name = '';
  modelSlug = 'trex';
  /** Empty until the player uploads a drawing. */
  textureHash = '';
  position: Vec3 = new Vec3();
  heading = 0;
}
defineTypes(PlayerState, {
  id: 'string',
  name: 'string',
  modelSlug: 'string',
  textureHash: 'string',
  position: Vec3,
  heading: 'number',
});

export class LobbyState extends Schema {
  code = '';
  createdAt = 0;
  players = new MapSchema<PlayerState>();
}
defineTypes(LobbyState, {
  code: 'string',
  createdAt: 'number',
  players: { map: PlayerState },
});

// ── Spawn placement ────────────────────────────────────────────────────────

/**
 * Where a dino stands today.
 *
 * Position/heading are **server-assigned once, at join, and then only changed
 * by a client's `move` message** (nothing sends one yet — Wave 2's wander
 * animation is still computed locally by each browser). The spawn point is
 * derived deterministically from the player's identity rather than from join
 * order, so it is identical in every client's copy of the state and stable
 * across a reconnect. That makes this the seed for the "two-client world
 * consistency" follow-up in PLAN.md: once motion is server-authoritative (or
 * seeded from here) the two browsers agree by construction.
 */
export function spawnFor(identity: string): { position: { x: number; y: number; z: number }; heading: number } {
  const digest = createHash('sha256').update(identity).digest();
  const angle = ((digest.readUInt16BE(0) / 0x1_00_00) * Math.PI * 2) % (Math.PI * 2);
  const radius = 4 + ((digest[2] ?? 0) % 5); // 4–8 m from the origin
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  return {
    position: { x: round(x), y: 0, z: round(z) },
    // Face the middle of the world, where the projector camera looks.
    heading: round(Math.atan2(-x, -z)),
  };
}
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** playerIds are uuids; Colyseus sessionIds are short opaque strings. */
export const keyIsPlayerId = (key: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);

// ── Live room registry (in-process fan-out) ────────────────────────────────
// v1 runs a single process, so routing an avatar update to "the room for lobby
// ABCDE" is a Map lookup, not a Redis round-trip (docs/ARCHITECTURE.md §2).
// A Set, not a single room, because a code could briefly have two rooms during
// a matchmaking race; every one of them gets the update.

const roomsByCode = new Map<string, Set<LobbyRoom>>();

/** Rooms currently serving a lobby code. Exported for tests/diagnostics. */
export const roomsForCode = (code: string): LobbyRoom[] => [...(roomsByCode.get(code) ?? [])];

/**
 * The fan-out registered with `setAvatarBroadcaster()` at boot.
 *
 * Returns the number of rooms patched (0 == nobody is watching that lobby,
 * which is normal and not an error). Never throws: `emitAvatarUpdated` runs
 * *after* the upload is committed, so a room bug must not fail the upload.
 */
export async function applyAvatarUpdate(update: AvatarUpdatedMessage): Promise<number> {
  const rooms = roomsForCode(update.lobbyCode);
  if (rooms.length === 0) return 0;

  // Only needed when we have to create or adopt an entry, and only reachable
  // when a DB is configured (an avatar update implies a Postgres write).
  const playerName = await lookupPlayerName(update.playerId);

  for (const room of rooms) room.receiveAvatarUpdate(update, playerName);
  return rooms.length;
}

/** The uploader's display name, for the nameplate. `null` if unknown. */
async function lookupPlayerName(playerId: string): Promise<string | null> {
  if (!hasDatabase()) return null;
  try {
    const [row] = await db()
      .select({ name: players.name })
      .from(players)
      .where(eq(players.id, playerId))
      .limit(1);
    return row?.name ?? null;
  } catch (err) {
    console.warn('[lobby] player name lookup failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ── The room ───────────────────────────────────────────────────────────────

export class LobbyRoom extends Room<LobbyState> {
  override maxClients = 64;
  /** Empty room → disposed. Postgres keeps the lobby, so it can be re-created. */
  override autoDispose = true;

  override async onCreate(options: unknown = {}): Promise<void> {
    const parsed = LobbyJoinOptionsSchema.safeParse(options ?? {});
    if (!parsed.success) {
      throw new ServerError(
        ROOM_ERROR_CODES.invalidJoinOptions,
        `invalid lobby join options: ${parsed.error.issues.map((i) => i.path.join('.') || 'code').join(', ')}`,
      );
    }
    const code = parsed.data.code;
    // Remembered outside `state` because `onDispose` still runs for a room
    // whose `onCreate` threw — at which point `this.state` was never assigned.
    this.#code = code;

    // Postgres is the source of truth for whether a lobby exists — otherwise
    // any typo'd 5-character code would silently conjure an empty world.
    // Without credentials (secret-less CI / local dev) we cannot check, so we
    // allow the room rather than making the server unusable; the REST layer
    // already refuses uploads in that state.
    if (hasDatabase()) {
      const [lobby] = await db().select().from(lobbies).where(eq(lobbies.code, code)).limit(1);
      if (!lobby) {
        throw new ServerError(ROOM_ERROR_CODES.lobbyNotFound, `no lobby with code ${code}`);
      }
      if (lobby.closedAt) {
        throw new ServerError(ROOM_ERROR_CODES.lobbyClosed, `lobby ${code} is closed`);
      }
      this.#lobbyId = lobby.id;
    }

    this.state = new LobbyState();
    this.state.code = code;
    this.state.createdAt = Date.now();
    // `filterBy(['code'])` matches on this, and it makes the code visible to
    // the client-side room listing without joining.
    await this.setMetadata({ code });

    this.onMessage(ROOM_MESSAGES.selectModel, (client, message: unknown) => {
      const msg = SelectModelMessageSchema.safeParse(message);
      const player = this.state.players.get(client.sessionId);
      if (!msg.success || !player) return;
      player.modelSlug = msg.data.modelSlug;
    });

    // Client-authoritative for v1 (see `spawnFor`): the server stores whatever
    // a client reports so the *other* clients can see it, but nothing sends
    // these yet. Wave 4/5 makes motion server-authoritative.
    this.onMessage(ROOM_MESSAGES.move, (client, message: unknown) => {
      const msg = MoveMessageSchema.safeParse(message);
      const player = this.state.players.get(client.sessionId);
      if (!msg.success || !player) return;
      player.position.x = msg.data.position.x;
      player.position.y = msg.data.position.y;
      player.position.z = msg.data.position.z;
      player.heading = msg.data.heading;
    });

    const existing = roomsByCode.get(code);
    if (existing) existing.add(this);
    else roomsByCode.set(code, new Set([this]));
  }

  /** The lobby code, available even if `onCreate` threw before setting state. */
  #code = '';
  /** Postgres id of the lobby, when a DB is configured. */
  #lobbyId: string | null = null;

  override async onJoin(client: Client, options: unknown = {}): Promise<void> {
    const parsed = LobbyJoinOptionsSchema.safeParse(options ?? {});
    if (!parsed.success) {
      throw new ServerError(ROOM_ERROR_CODES.invalidJoinOptions, 'invalid lobby join options');
    }
    const opts: LobbyJoinOptions = parsed.data;

    // A client joining an *existing* room must still be asking for this lobby.
    if (opts.code !== this.state.code) {
      throw new ServerError(ROOM_ERROR_CODES.lobbyNotFound, `this room serves ${this.state.code}`);
    }

    // ── Spectator: the projector view, or a phone that hasn't drawn yet. ────
    // It sees the whole synchronized world and contributes no dino.
    if (opts.spectator === true || !opts.name) {
      this.#spectators.add(client.sessionId);
      return;
    }

    const playerId = opts.playerId ?? (await this.#resolvePlayerId(opts.name)) ?? randomUUID();

    // Re-key an offline entry (an HTTP-only uploader coming online, or a
    // reconnect) instead of cloning the person into a second dino.
    const offline = this.#findOfflineEntry(playerId, opts.name);
    const player = new PlayerState();
    player.id = playerId;
    player.name = opts.name;
    player.modelSlug = opts.modelSlug ?? offline?.modelSlug ?? 'trex';
    player.textureHash = offline?.textureHash ?? '';

    const spawn = offline
      ? { position: { x: offline.position.x, y: offline.position.y, z: offline.position.z }, heading: offline.heading }
      : spawnFor(playerId);
    player.position.x = spawn.position.x;
    player.position.y = spawn.position.y;
    player.position.z = spawn.position.z;
    player.heading = spawn.heading;

    if (offline) this.state.players.delete(playerId);
    this.state.players.set(client.sessionId, player);

    // Live membership in Redis; best effort (a Redis blip must not block a join).
    void redis
      .addLobbyMember(this.state.code, playerId)
      .catch((err: unknown) => console.warn('[lobby] addLobbyMember failed:', err));
  }

  override onLeave(client: Client, _consented?: boolean): void {
    this.#spectators.delete(client.sessionId);
    const player = this.state.players.get(client.sessionId);
    if (!player) return;
    this.state.players.delete(client.sessionId);

    // Someone who already uploaded a drawing keeps their dino in the world
    // after they close the phone — that is the whole point of the projector.
    // They are re-keyed by playerId, exactly like an HTTP-only uploader.
    if (player.textureHash !== '' && keyIsPlayerId(player.id)) {
      this.state.players.set(player.id, player);
      return;
    }

    void redis
      .removeLobbyMember(this.state.code, player.id)
      .catch((err: unknown) => console.warn('[lobby] removeLobbyMember failed:', err));
  }

  override onDispose(): void {
    const set = roomsByCode.get(this.#code);
    if (set) {
      set.delete(this);
      if (set.size === 0) roomsByCode.delete(this.#code);
    }
  }

  // ── Fan-out target ───────────────────────────────────────────────────────

  /**
   * Applies one `avatar:updated` to synchronized state and tells every client.
   *
   * The uploader may not have a WebSocket at all (a phone that only ever spoke
   * HTTP), in which case an entry is created keyed by their playerId.
   */
  receiveAvatarUpdate(update: AvatarUpdatedMessage, playerName: string | null): void {
    let entry = this.#findByPlayerId(update.playerId);

    // Fallback: the client joined before it had a persisted playerId (the room
    // minted a provisional one), so match on the name — which the REST layer
    // treats as the person's identity within a lobby — and adopt the real id.
    if (!entry && playerName) entry = this.#findByName(playerName);

    if (!entry) {
      entry = new PlayerState();
      entry.id = update.playerId;
      entry.name = playerName ?? '';
      const spawn = spawnFor(update.playerId);
      entry.position.x = spawn.position.x;
      entry.position.y = spawn.position.y;
      entry.position.z = spawn.position.z;
      entry.heading = spawn.heading;
      this.state.players.set(update.playerId, entry);
    }

    entry.id = update.playerId;
    if (playerName && entry.name === '') entry.name = playerName;
    entry.modelSlug = update.modelSlug;
    entry.textureHash = update.textureHash;

    // State sync alone would be enough to render, but the explicit message lets
    // a client prefetch `GET /api/textures/:hash` before the patch is applied.
    this.broadcast(ROOM_MESSAGES.avatarUpdated, update);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  readonly #spectators = new Set<string>();

  /** Session ids currently watching without a dino. */
  get spectatorCount(): number {
    return this.#spectators.size;
  }

  #findByPlayerId(playerId: string): PlayerState | undefined {
    for (const [, player] of this.state.players) {
      if (player.id === playerId) return player;
    }
    return undefined;
  }

  #findByName(name: string): PlayerState | undefined {
    // Prefer someone who hasn't drawn yet — that's who an upload belongs to.
    let fallback: PlayerState | undefined;
    for (const [, player] of this.state.players) {
      if (player.name !== name) continue;
      if (player.textureHash === '') return player;
      fallback ??= player;
    }
    return fallback;
  }

  /** An offline (playerId-keyed) entry for this person, if there is one. */
  #findOfflineEntry(playerId: string, name: string): PlayerState | undefined {
    const byId = this.state.players.get(playerId);
    if (byId) return byId;
    for (const [key, player] of this.state.players) {
      if (keyIsPlayerId(key) && player.name === name) return player;
    }
    return undefined;
  }

  /**
   * The persisted player id for this name in this lobby, if the REST layer
   * already created one (`POST /api/avatars` reuses a row per name per lobby).
   * `null` when there is no match — the caller mints a provisional uuid and the
   * fan-out adopts the real one on the first upload.
   */
  async #resolvePlayerId(name: string): Promise<string | null> {
    if (!hasDatabase() || !this.#lobbyId) return null;
    try {
      const [row] = await db()
        .select({ id: players.id })
        .from(lobbyMembers)
        .innerJoin(players, eq(players.id, lobbyMembers.playerId))
        .where(and(eq(lobbyMembers.lobbyId, this.#lobbyId), eq(players.name, name)))
        .limit(1);
      return row?.id ?? null;
    } catch (err) {
      console.warn('[lobby] player lookup failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }
}

export const LOBBY_ROOM = LOBBY_ROOM_NAME;
