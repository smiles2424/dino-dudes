/**
 * Drizzle schema — the canonical definition of the Neon Postgres tables, and
 * the source migrations are generated from.
 *
 * `db:migrate` uses `DATABASE_URL_UNPOOLED`: DDL over Neon's pooler is
 * unreliable. Mirrors the SQL in `docs/ARCHITECTURE.md` §3 — change both.
 */
import { sql } from 'drizzle-orm';
import {
  customType,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * `bytea` has no first-class helper in drizzle-pg-core. `node-postgres` already
 * hands bytea back as a `Buffer` and serializes `Buffer` params to bytea, so
 * this custom type is pure typing with no encode/decode hooks — which is what
 * keeps texture bytes byte-identical through a round-trip.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const players = pgTable('players', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The drawings themselves — content-addressed and **shared**: a texture is
 * identified by the sha256 of its bytes, so the same pixels are one row no
 * matter how many people wear them.
 *
 * Deliberately says nothing about people. `avatars.texture_hash` used to be
 * UNIQUE, which let a second uploader of byte-identical pixels steal the first
 * player's row and leave them naked when the lobby was rehydrated.
 */
export const textures = pgTable('textures', {
  /** sha256 of `bytes`, lowercase hex — the URL of `GET /api/textures/:hash`. */
  hash: text('hash').primaryKey(),
  /** Processed 1024x1024 PNG (see the Texture Spec in `@dino/shared`). */
  bytes: bytea('bytes').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Who is wearing which drawing — **one row per player**.
 *
 * `player_id` is UNIQUE, so a retake replaces what a child is wearing instead
 * of accumulating history, which is also what makes `loadLobbyMembers` a plain
 * join rather than a "latest per player" fold. `texture_hash` is an ordinary
 * non-unique FK, so any number of players can wear the same pixels at once.
 */
export const avatars = pgTable(
  'avatars',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id),
    /** `'trex' | 'stego' | 'raptor' | 'bronto'` — validated by `@dino/shared`, not the DB. */
    modelSlug: text('model_slug').notNull(),
    /** The content address of the drawing this player is wearing. */
    textureHash: text('texture_hash')
      .notNull()
      .references(() => textures.hash),
    /** Optional original phone photo, kept so a texture can be reprocessed later. */
    sourcePhoto: bytea('source_photo'),
    /** When this player last changed what they are wearing. */
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('avatars_player_id_key').on(t.playerId),
    index('avatars_texture_hash_idx').on(t.textureHash),
  ],
);

export const lobbies = pgTable(
  'lobbies',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** 5-char join code; `LOBBY_CODE_LENGTH` / `LobbyCodeSchema` in `@dino/shared`. */
    code: text('code').notNull(),
    name: text('name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('lobbies_code_key').on(t.code)],
);

export const lobbyMembers = pgTable(
  'lobby_members',
  {
    lobbyId: uuid('lobby_id')
      .notNull()
      .references(() => lobbies.id),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.lobbyId, t.playerId] })],
);

export type Player = typeof players.$inferSelect;
export type NewPlayer = typeof players.$inferInsert;
export type Avatar = typeof avatars.$inferSelect;
export type NewAvatar = typeof avatars.$inferInsert;
export type Texture = typeof textures.$inferSelect;
export type NewTexture = typeof textures.$inferInsert;
export type Lobby = typeof lobbies.$inferSelect;
export type NewLobby = typeof lobbies.$inferInsert;
export type LobbyMember = typeof lobbyMembers.$inferSelect;
export type NewLobbyMember = typeof lobbyMembers.$inferInsert;

export const schema = { players, textures, avatars, lobbies, lobbyMembers };
