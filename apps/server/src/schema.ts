/**
 * Drizzle schema — the canonical definition of the Neon Postgres tables.
 *
 * Mirrors the SQL in `docs/ARCHITECTURE.md` §3 ("Database schema (initial)")
 * exactly; if you change one, change the other. Migrations are generated from
 * *this* file (`pnpm --filter @dino/server db:generate`) and applied with
 * `db:migrate`, which uses `DATABASE_URL_UNPOOLED` (Neon's direct endpoint —
 * DDL over the pooler is unreliable).
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
 * hands bytea back as a `Buffer` and serializes `Buffer` params to bytea, so the
 * custom type is pure typing — no encode/decode hooks, which is exactly what
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
    /** Processed 1024x1024 PNG (see the Texture Spec in `@dino/shared`). */
    texture: bytea('texture').notNull(),
    /** sha256 of `texture`, lowercase hex — the content address used by `GET /api/textures/:hash`. */
    textureHash: text('texture_hash').notNull(),
    /** Optional original phone photo, kept so a texture can be reprocessed later. */
    sourcePhoto: bytea('source_photo'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('avatars_texture_hash_key').on(t.textureHash),
    index('avatars_player_id_idx').on(t.playerId),
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
export type Lobby = typeof lobbies.$inferSelect;
export type NewLobby = typeof lobbies.$inferInsert;
export type LobbyMember = typeof lobbyMembers.$inferSelect;
export type NewLobbyMember = typeof lobbyMembers.$inferInsert;

export const schema = { players, avatars, lobbies, lobbyMembers };
