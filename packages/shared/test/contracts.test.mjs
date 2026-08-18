import assert from 'node:assert/strict';
import test from 'node:test';

import {
  API_ROUTES,
  CreateAvatarFieldsSchema,
  LOBBY_CODE_LENGTH,
  LobbyCodeSchema,
  LobbyStateSchema,
  MARKERS,
  TEMPLATE_MM,
  TEXTURE,
  TEXTURE_DEST_POINTS,
  TEXTURE_SAFE_AREA,
  TEXTURE_SPEC,
  textureUrlPath,
} from '../dist/index.js';

test('texture spec: canonical raster is 1024x1024 PNG', () => {
  assert.equal(TEXTURE.width, 1024);
  assert.equal(TEXTURE.height, 1024);
  assert.equal(TEXTURE.mimeType, 'image/png');
});

test('texture spec: markers are ArUco 4x4_50 with corner ids 0-3 clockwise', () => {
  assert.equal(MARKERS.dictionary, '4x4_50');
  assert.equal(MARKERS.gridSize, 4);
  assert.deepEqual(MARKERS.order, [0, 1, 2, 3]);
  assert.deepEqual(
    [MARKERS.ids.topLeft, MARKERS.ids.topRight, MARKERS.ids.bottomRight, MARKERS.ids.bottomLeft],
    [0, 1, 2, 3],
  );
});

test('texture spec: dest points are the texture corners clockwise from top-left', () => {
  assert.deepEqual(TEXTURE_DEST_POINTS, [
    [0, 0],
    [1024, 0],
    [1024, 1024],
    [0, 1024],
  ]);
});

test('texture spec: drawable quad + markers fit on the A4 page with margins', () => {
  const contentSize = TEMPLATE_MM.drawableQuad + TEMPLATE_MM.markerSize * 2;
  assert.ok(
    TEMPLATE_MM.contentOrigin.x + contentSize <= TEMPLATE_MM.page.width,
    'content overflows page width',
  );
  assert.ok(
    TEMPLATE_MM.contentOrigin.y + contentSize <= TEMPLATE_MM.page.height,
    'content overflows page height',
  );
  // Symmetric left/right margins keep the printed sheet visually centred.
  assert.equal(
    TEMPLATE_MM.contentOrigin.x,
    (TEMPLATE_MM.page.width - contentSize) / 2,
  );
});

test('texture spec: safe area is inset on all four sides', () => {
  assert.equal(TEXTURE_SAFE_AREA.inset, 64);
  assert.equal(TEXTURE_SAFE_AREA.width, TEXTURE.width - 128);
  assert.equal(TEXTURE_SAFE_AREA.height, TEXTURE.height - 128);
  assert.equal(TEXTURE_SPEC.version, 1);
});

test('lobby codes: 5 chars from the unambiguous alphabet, normalized to upper case', () => {
  assert.equal(LobbyCodeSchema.parse(' hj4kp '), 'HJ4KP');
  assert.equal(LOBBY_CODE_LENGTH, 5);
  assert.equal(LobbyCodeSchema.safeParse('ABCDEF').success, false, 'too long');
  assert.equal(LobbyCodeSchema.safeParse('ABCI0').success, false, 'ambiguous glyphs rejected');
});

test('avatar upload fields validate model slug and lobby code', () => {
  const ok = CreateAvatarFieldsSchema.parse({
    lobbyCode: 'hj4kp',
    playerName: '  Rex  ',
    modelSlug: 'trex',
  });
  assert.equal(ok.lobbyCode, 'HJ4KP');
  assert.equal(ok.playerName, 'Rex');
  assert.equal(
    CreateAvatarFieldsSchema.safeParse({
      lobbyCode: 'HJ4KP',
      playerName: 'Rex',
      modelSlug: 'pterodactyl',
    }).success,
    false,
  );
});

test('texture url path matches the declared route', () => {
  const hash = 'a'.repeat(64);
  assert.equal(textureUrlPath(hash), `/api/textures/${hash}`);
  assert.equal(API_ROUTES.getTexture, '/api/textures/:hash');
});

test('room state schema accepts an empty lobby and a populated one', () => {
  assert.equal(
    LobbyStateSchema.safeParse({ code: 'HJ4KP', players: {}, createdAt: 0 }).success,
    true,
  );
  const populated = LobbyStateSchema.safeParse({
    code: 'HJ4KP',
    createdAt: Date.now(),
    players: {
      sess1: {
        id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
        name: 'Rex',
        modelSlug: 'stego',
        textureHash: '',
        position: { x: 0, y: 0, z: 0 },
        heading: 0,
      },
    },
  });
  assert.equal(populated.success, true, JSON.stringify(populated.error?.issues));
});
