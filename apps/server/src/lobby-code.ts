/**
 * Join-code generation.
 *
 * The *alphabet*, *length* and *validation* are the frozen contract
 * (`LOBBY_CODE_ALPHABET` / `LobbyCodeSchema` in `@dino/shared`) — this module
 * only picks characters. `randomInt` is used rather than `Math.random` so the
 * distribution is uniform (no modulo bias) and codes aren't predictable from a
 * previous one; at 32^5 ≈ 33.5 M codes a party-sized set of lobbies collides
 * essentially never, and the caller retries on the UNIQUE violation anyway.
 */
import { randomInt } from 'node:crypto';
import { LOBBY_CODE_ALPHABET, LOBBY_CODE_LENGTH, LobbyCodeSchema } from '@dino/shared';

/** A fresh, contract-valid join code (uppercase, no ambiguous I/O/0/1). */
export function generateLobbyCode(): string {
  let code = '';
  for (let i = 0; i < LOBBY_CODE_LENGTH; i++) {
    code += LOBBY_CODE_ALPHABET[randomInt(LOBBY_CODE_ALPHABET.length)];
  }
  // Parse our own output: a generator that can emit an invalid code is a bug we
  // want to see at creation time, not when a phone tries to join.
  return LobbyCodeSchema.parse(code);
}
