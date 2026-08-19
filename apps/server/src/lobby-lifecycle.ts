/**
 * Closing a lobby that the party has finished with (Wave 5, Chunk 5.2).
 *
 * A lobby row outlives its Colyseus room on purpose — the room is disposed the
 * moment it empties, and the code must still work when the projector comes
 * back. So "the room went away" is *not* the same as "the party is over", and
 * nothing here is a timer or a scheduler service. Instead:
 *
 *   **idle** = nobody is in the room right now (the caller only runs this when
 *   a room disposes, or when a new lobby is created) **and** nothing has
 *   happened in this lobby for {@link idleMs} — no upload, and the lobby itself
 *   was not created that recently.
 *
 * That is one UPDATE statement, evaluated in Postgres, run on an event we
 * already have. It is race-safe (`closed_at IS NULL` in the WHERE clause), it
 * cannot close a live lobby, and a server that is asleep all night simply
 * closes yesterday's lobbies the next time somebody starts a party.
 *
 * Once `closed_at` is set, `GET /api/lobbies/:code` answers 409 `lobby_closed`,
 * `POST /api/avatars` refuses, and `LobbyRoom.onCreate` rejects the join with
 * room error code 4090.
 */
import { sql } from 'drizzle-orm';
import { db, hasDatabase } from './db.js';
import { env } from './env.js';

/** How long a lobby may be quiet before it is closed. */
export const idleMs = (): number => env.LOBBY_IDLE_HOURS * 3_600_000;

/**
 * Stamps `closed_at` on every idle, still-open lobby — or just on `lobbyId`
 * when one is given.
 *
 * Returns the number of lobbies closed. Never throws: this runs on the back of
 * a room disposal, where a database blip must not become an unhandled
 * rejection that takes the process down.
 */
export async function closeIdleLobbies(lobbyId?: string): Promise<number> {
  if (!hasDatabase()) return 0;
  const cutoffMs = idleMs();
  if (cutoffMs <= 0) return 0;
  // The cutoff is computed here rather than in SQL so it is one plain
  // timestamptz parameter, used identically by all three clauses.
  const cutoff = new Date(Date.now() - cutoffMs);

  try {
    const result = await db().execute(sql`
      update lobbies l
         set closed_at = now()
       where l.closed_at is null
         and l.created_at < ${cutoff}
         ${lobbyId ? sql`and l.id = ${lobbyId}::uuid` : sql``}
         and not exists (
               select 1
                 from lobby_members lm
                 join avatars a on a.player_id = lm.player_id
                where lm.lobby_id = l.id
                  and a.created_at >= ${cutoff}
             )
         and not exists (
               select 1
                 from lobby_members lm
                where lm.lobby_id = l.id
                  and lm.joined_at >= ${cutoff}
             )
    `);
    return result.rowCount ?? 0;
  } catch (err) {
    console.warn('[lobby] idle sweep failed:', err instanceof Error ? err.message : err);
    return 0;
  }
}

/**
 * The sweep over *all* lobbies is cheap but pointless to repeat; creating a
 * lobby is the natural moment to tidy up, and parties do not start twice a
 * second.
 */
const SWEEP_EVERY_MS = 10 * 60_000;
let lastSweep = 0;

/** Fire-and-forget housekeeping hook for `POST /api/lobbies`. */
export function sweepIdleLobbiesOccasionally(): void {
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  void closeIdleLobbies();
}
