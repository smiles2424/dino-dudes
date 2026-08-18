/**
 * `LobbyRoom` — Wave 1 stub.
 *
 * The synchronized state classes below are the Colyseus-side mirror of
 * `LobbyStateSchema` in `@dino/shared`; keep them structurally identical.
 * Wave 3 (WS-B) fills in join/leave, the avatar-updated broadcast and the
 * Redis-backed membership. For now the room exists, is defined on the game
 * server, and syncs an empty player map.
 *
 * Schema types are declared with `defineTypes` rather than decorators so the
 * build needs no decorator/metadata compiler flags.
 */
import { MapSchema, Schema, defineTypes } from '@colyseus/schema';
import { Room, type Client } from 'colyseus';
import { LOBBY_ROOM_NAME, type JoinLobbyOptions } from '@dino/shared';

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

export class LobbyRoom extends Room<LobbyState> {
  override maxClients = 64;

  override onCreate(options: { code?: string } = {}): void {
    this.state = new LobbyState();
    this.state.code = options.code ?? this.roomId;
    this.state.createdAt = Date.now();
    // Wave 3: register ROOM_MESSAGES handlers (select-model, move) here.
  }

  override onJoin(client: Client, options?: Partial<JoinLobbyOptions>): void {
    // Wave 3: validate `options` with JoinLobbyOptionsSchema, create/lookup the
    // player row, and add a PlayerState to `this.state.players`.
    console.log(`[lobby ${this.state.code}] join ${client.sessionId}`, options?.name ?? '');
  }

  override onLeave(client: Client): void {
    this.state.players.delete(client.sessionId);
    console.log(`[lobby ${this.state.code}] leave ${client.sessionId}`);
  }

  override onDispose(): void {
    console.log(`[lobby ${this.state.code}] disposed`);
  }
}

export const LOBBY_ROOM = LOBBY_ROOM_NAME;
