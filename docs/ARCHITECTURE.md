# Dino World — Architecture & Implementation Plan

*A webapp where people draw on paper templates, photograph them, and see their drawing texture-mapped onto a 3D dinosaur in a shared game world.*

---

## 1. System overview

```
┌─────────────────────┐        ┌──────────────────────────────┐
│  Mobile Web Client   │        │        Node.js Server         │
│  (React + Vite PWA)  │        │  ┌────────────┐ ┌──────────┐ │
│                      │  HTTPS │  │ Fastify API │ │ Colyseus │ │
│  camera capture      │───────▶│  │ (upload,    │ │ (lobby   │ │
│  ArUco detect+deskew │        │  │  players,   │ │  rooms,  │ │
│  (js-aruco2 + cv.js) │  WSS   │  │  textures)  │ │  state)  │ │
│  Three.js game view  │◀──────▶│  └─────┬──────┘ └────┬─────┘ │
└─────────────────────┘        └────────┼─────────────┼───────┘
                                        │             │
                              ┌─────────▼──┐   ┌──────▼───────┐
                              │  Neon      │   │  Upstash     │
                              │  Postgres  │   │  Redis       │
                              │  (players, │   │  (presence,  │
                              │  avatars,  │   │  pub/sub,    │
                              │  textures) │   │  tex cache)  │
                              └────────────┘   └──────────────┘
```

One Node process (or two, later) hosts both the REST API and the Colyseus WebSocket server. The mobile client is a single React app with two modes: **capture** (photograph & process the template) and **spectate/play** (render the 3D world). A lobby is a Colyseus room identified by a short join code.

### The two contracts that enable concurrent work
1. **Texture Spec** — the printable template's drawable region maps 1:1 to a 1024×1024 PNG whose layout matches the dino model's UV unwrap. This is the interface between the image pipeline and the 3D code.
2. **API + Room Spec** — REST endpoints and Colyseus room schema/messages, shared as TypeScript types + Zod schemas in a common package. This is the interface between client and server.

Freeze these two early (Phase 0) and the four workstreams can run in parallel.

---

## 2. Core flows

### Template → texture pipeline (client-side)
1. Template sheet has **4 ArUco fiducial markers** (e.g. 4x4_50 dictionary, IDs 0–3), one per corner. Distinct IDs give you orientation for free — no "which way is up" ambiguity, and detection is robust to rotation/skew/lighting.
2. User photographs the sheet (`<input type="file" accept="image/*" capture="environment">` — most reliable cross-device mobile capture; getUserMedia live preview is a v2 nicety).
3. **js-aruco2** detects the four markers in the photo; their inner corners define the drawable quad.
4. **OpenCV.js (WASM)** computes `getPerspectiveTransform` + `warpPerspective` to deskew the quad into the canonical 1024×1024 texture; light post-processing (white balance / levels so pencil drawings pop, optional background-white knockout).
5. User sees an instant preview of their drawing wrapped on the dino (client already has the model) and confirms or retakes.
6. Client uploads the **processed PNG** (plus optionally the original photo for reprocessing) to the API.

Doing detection/warp client-side gives instant feedback, offloads the server, and means the server only ever stores a clean, fixed-size artifact. The server still validates dimensions/size/type.

### Save & broadcast
1. `POST /api/avatars` — multipart: player name, lobby code, texture PNG.
2. API writes player + avatar rows to **Neon Postgres** (texture as `bytea` — at 1024² PNG ≈ 100–300 KB this is fine; migrate to object storage like R2 only if it becomes a problem), caches texture bytes in **Upstash Redis** keyed by content hash, and publishes `avatar:updated {lobbyCode, playerId, textureHash}` on Redis pub/sub.
3. The Colyseus lobby room (subscribed to that channel, or called directly in-process) updates its synchronized state; every connected game client sees the new `textureHash`, fetches `GET /api/textures/:hash` (served from Redis cache, Postgres fallback, immutable cache headers since it's content-addressed), and hot-swaps the material — the dino appears/updates **live** for everyone in the lobby.

### Lobby routing
- Lobby = Colyseus room; join code = room's custom id (e.g. 5-char code). `POST /api/lobbies` creates, `joinById` from clients.
- Colyseus's Redis **presence + driver** (Upstash speaks the Redis TCP protocol over TLS, so `ioredis` works — note: use the TCP connection string, not the REST API, for pub/sub) lets you run multiple server instances later without changing code.
- Postgres persists lobby history; Redis holds live membership/state.

---

## 3. Technology choices

| Concern | Choice | Why |
|---|---|---|
| Client framework | **React + Vite + TypeScript** | Fast dev loop; r3f ecosystem |
| 3D rendering | **Three.js via @react-three/fiber + drei** | Declarative scene graph, easy texture hot-swap, huge ecosystem |
| Marker detection | **js-aruco2** | Pure-JS ArUco, runs in browser, no server round-trip |
| Deskew/warp | **OpenCV.js (WASM)** | `warpPerspective` is exactly this job; also usable in Node for E2E golden tests |
| API server | **Fastify + Zod** | Lightweight, fast multipart handling, schema-validated |
| Lobbies/real-time | **Colyseus** | Room-based matchmaking, delta-compressed state sync, `@colyseus/testing`, Redis scaling built in |
| ORM/migrations | **Drizzle ORM + drizzle-kit** | Type-safe, SQL-first, first-class Neon support |
| Postgres | **Neon** (`pg` or `@neondatabase/serverless`) | Provided |
| Redis | **Upstash** via `ioredis` (TCP/TLS) | Provided; protocol-compatible with Colyseus presence |
| Models | **Blender → GLB (glTF)** | UV-unwrap authored so template layout == UV layout |
| E2E tests | **Playwright** (mobile emulation) + **@colyseus/testing** | Multi-page tests = multi-player tests |
| Monorepo | **pnpm workspaces + Turborepo** | Shared types package between client/server/pipeline |
| Hosting | Client: Vercel/Netlify static. Server: **Railway / Fly.io / Render** | Colyseus needs a long-lived stateful WebSocket process — *not* serverless |

### Repo layout
```
apps/web        — React client (capture flow + game view)
apps/server     — Fastify API + Colyseus rooms
packages/shared — Zod schemas, API types, room state types, texture spec constants
packages/pipeline — marker detect + warp, isomorphic (browser + Node for tests)
assets/         — dino GLBs, template PDFs/SVGs, test fixture photos, golden textures
e2e/            — Playwright suites
```

### Database schema (initial)
```sql
CREATE TABLE players (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE avatars (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id    uuid NOT NULL REFERENCES players(id),
  model_slug   text NOT NULL,              -- 'trex' | 'stego' | ...
  texture      bytea NOT NULL,             -- processed 1024x1024 PNG
  texture_hash text NOT NULL UNIQUE,       -- sha256, content address
  source_photo bytea,                      -- optional original for reprocessing
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lobbies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,         -- 5-char join code
  name       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz
);

CREATE TABLE lobby_members (
  lobby_id  uuid REFERENCES lobbies(id),
  player_id uuid REFERENCES players(id),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lobby_id, player_id)
);
```

### Redis keyspace
```
texture:{hash}            → PNG bytes (TTL ~24h; content-addressed cache)
lobby:{code}:players      → SET of player ids (live membership)
channel avatar:updates    → pub/sub {lobbyCode, playerId, modelSlug, textureHash}
colyseus:*                → presence/driver internals (managed by Colyseus)
```

---

## 4. Workstreams (concurrent)

### Phase 0 — Contracts (everyone, ~few days)
- Author one dino model in Blender with a deliberate UV unwrap (planar side-projection mirrored to both flanks is the simplest thing that looks good); export GLB **and** generate the matching template SVG/PDF from the same UV layout, markers included.
- Freeze the **Texture Spec** (1024×1024 PNG, marker dictionary + IDs, drawable-quad geometry) and the **API/Room Spec** (Zod schemas in `packages/shared`).
- Scaffold monorepo, CI, Neon + Upstash connections, deploy hello-world server.

### WS-A — Template & image pipeline
Owner focus: `packages/pipeline`, `assets/templates`
1. Template generator (SVG → printable PDF) parameterized by model slug.
2. Marker detection (js-aruco2) + quad extraction; handle: rotated photos, all-4-markers-required with clear per-corner error messages.
3. Perspective warp + cleanup via OpenCV.js; output canonical PNG.
4. Fixture set: ~10 real phone photos of filled templates (angled, dim, shadowed) checked into `assets/fixtures`.
- **Automated validation:** Node-side golden test — each fixture photo must produce a texture with SSIM ≥ threshold vs its hand-approved golden PNG. Runs in CI.
- **Human validation:** print, draw, shoot with 2–3 different phones; approve the goldens.

### WS-B — Backend platform (API, lobbies, persistence)
Owner focus: `apps/server`
1. Drizzle schema + migrations against Neon; Fastify routes: `POST /api/lobbies`, `POST /api/avatars`, `GET /api/textures/:hash`, `GET /api/lobbies/:code`.
2. Colyseus `LobbyRoom`: schema = map of players `{id, name, modelSlug, textureHash, position}`; messages: join, leave, avatar-updated; wire Redis pub/sub → room state.
3. Upstash integration: texture cache, presence config.
4. Join-code generation, lobby lifecycle (auto-dispose after idle, `closed_at` stamp).
- **Automated validation:** `@colyseus/testing` E2E — spin real server against Neon branch DB (Neon branching is great for test isolation) + Upstash: client A joins lobby, POST uploads a fixture texture, assert client B's room state gets the new hash and `GET /textures/:hash` returns identical bytes. Runs in CI.
- **Human validation:** manual smoke via a minimal HTML test page; review of API spec.

### WS-C — 3D world & rendering
Owner focus: `apps/web` (game view), `assets/models`
1. r3f scene: ground, sky, lighting, orbit/idle camera; loads N dinos from room state.
2. Runtime texture swap: fetch by hash → `TextureLoader` → material update without model reload; nameplate (name) above each dino.
3. Simple life: idle/wander animation so the world feels alive (drei + simple state machine; no physics needed for v1).
4. A **debug harness page** (`/debug/world`) that renders the scene from a static JSON state + local texture files — lets WS-C work with zero backend, and doubles as the E2E assertion surface.
- **Automated validation:** Playwright against the debug harness — load 3 fixture textures, screenshot-diff the canvas (tolerance-based), plus a `window.__world` hook exposing scene state (dino count, texture hashes applied) for non-flaky assertions.
- **Human validation:** art review — does a marker drawing actually look right on the dino? Iterate UV unwrap with WS-A if not.

### WS-D — Mobile client UX & integration
Owner focus: `apps/web` (capture flow, lobby join)
1. Flow: enter name + lobby code → pick dino → photograph template → pipeline runs (WS-A package) → preview on 3D model (WS-C component) → confirm → upload (WS-B API) → land in game view.
2. Error UX: markers not found, blur detection hint, retake loop.
3. Responsive/mobile-first; QR code on projector screen encoding the lobby join URL.
- **Automated validation:** the **flagship E2E** (see §5).
- **Human validation:** full paper-to-screen dry run of the real activity with 3–5 people.

### Integration milestones
- **M1** (end of Phase 0): hello-world deployed; contracts frozen.
- **M2**: WS-A pipeline + WS-C harness — fixture photo renders on a dino locally (no backend).
- **M3**: WS-B + WS-D — upload from phone persists to Neon/Upstash and appears in a second browser's lobby within ~2s.
- **M4**: full dry run of the activity; flagship E2E green in CI; deployed.

---

## 5. Testing strategy (E2E-first, per your preference)

Few, high-value tests that each exercise many components:

1. **Flagship journey (Playwright, CI):** Browser A (desktop) creates a lobby and opens the game view. Browser B (Pixel emulation) joins by code, "uploads" a checked-in fixture photo through the real capture flow — real marker detection, real warp, real API, real Neon (branch DB) and Upstash. Assert: B reaches game view; A's `window.__world` shows B's dino with the expected texture hash within 5s; screenshot-diff A's canvas. This one test covers the pipeline, API, Postgres, Redis, Colyseus sync, and rendering.
2. **Pipeline goldens (Node, CI):** 10 fixture photos → SSIM vs goldens. Catches regressions in the fiddliest code without any UI.
3. **Room E2E (@colyseus/testing, CI):** join/leave/reconnect/second-upload-replaces-texture semantics.
4. **Load sanity (pre-event, manual trigger):** `@colyseus/loadtest` with ~50 simulated clients in one lobby.

No unit-test scaffolding beyond what falls out naturally; the shared Zod schemas give you runtime validation "for free" at every boundary, which removes most of what unit tests would police.

---

## 6. Risks & decisions to revisit
- **Marker detection robustness** is the highest-risk component → why WS-A starts first and gets the fixture/golden rig. Mitigation if js-aruco2 struggles: fall back to OpenCV.js's own ArUco module (heavier WASM but battle-tested).
- **Textures in Postgres `bytea`**: fine at event scale (hundreds of players); content-addressing + Redis cache keeps reads cheap. Escape hatch: swap `GET /textures/:hash` backing store to R2/S3 later — the URL contract doesn't change.
- **Upstash pub/sub**: must use the TCP (ioredis) endpoint, not the REST API. If latency from Upstash region is poor, single-instance Colyseus needs no Redis at all for v1 — presence/pub-sub only matter when you scale to 2+ instances.
- **Hosting**: Colyseus can't run on Vercel functions; budget a small always-on Node host (Railway/Fly/Render).
