# Dino Dudes — Delegation Plan & Progress Tracker

> **This file is the single source of truth for agents and humans.** Every agent working on
> this repo reads this file first, works only within its assigned wave/module, and updates
> its checkboxes + the Progress Log before finishing. Full architecture rationale lives in
> [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — read it before implementing anything.

## Goal

A webapp game world: people draw on printed paper templates (ArUco markers in the corners),
photograph them on their phone, and the drawing is deskewed client-side and texture-mapped
onto a low-poly dinosaur that appears **live** in a shared 3D lobby that everyone can watch.

- **Stack:** React + Vite + TypeScript, @react-three/fiber (Three.js), js-aruco2 + OpenCV.js
  (WASM), Fastify + Zod, Colyseus, Drizzle ORM, Neon Postgres, Upstash Redis (ioredis/TCP),
  pnpm workspaces monorepo, Playwright + @colyseus/testing for E2E.
- **Testing philosophy:** E2E-first. Few tests, each exercising many components. No unit-test
  scaffolding. Every wave must leave the **cumulative E2E suite green**.

## Definition of Done (per wave)

A wave is complete only when ALL of:
1. The wave's **module integration tests** pass locally (`pnpm test` filtered to the module).
2. The **cumulative E2E suite** (`pnpm e2e`) passes — everything built so far still works together.
3. This file's checkboxes and Progress Log are updated.
4. Work is committed on a branch `wave-N/<slug>` ready for a human-reviewed PR. **Never commit
   directly to `main`. Never commit `.env` or secrets.**

## Delegation model

- Orchestrator (interactive Claude session) launches one subagent per module using the
  **Agent tool with `model: "opus"`** (latest Opus). Concurrent agents in the same wave run
  with `isolation: "worktree"` so they don't collide; sequential single-agent waves run in-repo.
- Each agent's prompt = pointer to this file + its wave section + its module boundaries.
- Agents must not modify files owned by another module except `packages/shared` **additions**
  (never breaking changes to frozen contracts — propose those in the Progress Log instead).
- Human checkpoints are listed per wave; the orchestrator stops and asks when one is reached.
- **Keep chunks small** *(human feedback, 2026-08-18)*: target agent runs well under ~30
  minutes — split waves into sequential chunks with their own gates rather than one long run;
  tighter loops give better results.

## Module ownership map

| Path | Owner module |
|---|---|
| `packages/shared` | Contracts (frozen after Wave 1; additive changes only) |
| `packages/pipeline` | WS-A image pipeline |
| `assets/templates`, `assets/fixtures`, `assets/goldens` | WS-A |
| `apps/web` (game view, `/debug/world` harness) | WS-C 3D world |
| `assets/models` | WS-C |
| `apps/server` | WS-B backend |
| `apps/web` (capture flow, lobby join UX) | WS-D integration |
| `e2e/` | Shared; each wave appends, never deletes others' tests |

---

## Waves

### Wave 0 — Scaffold  `[x] done` *(orchestrator, no subagent)*
- [x] Directory tree, git repo on `main`, `.gitignore`
- [x] `PLAN.md` (this file), `docs/ARCHITECTURE.md`
- [x] `.env.example` + `.env` placeholders for Neon / Upstash secrets
- **Human checkpoint:** review this plan; fill in `.env`. ✅ done

### Wave 1 — Contracts & foundations  `[x] done` *(1 opus agent, sequential)*
Branch: `wave-1/foundations`
- [x] **FIRST: validate third-party connections before any other work.** Using the values in
      `.env`, open a real connection to Neon (`SELECT 1` over `DATABASE_URL` and
      `DATABASE_URL_UNPOOLED`) and Upstash (`PING` via `@upstash/redis` REST using
      `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — NOT ioredis/`REDIS_URL`; TCP
      6379 is blackholed on this machine by ProtonVPN, see Progress Log 2026-08-18). If either
      fails, troubleshoot up to ~3 attempts (obvious causes only: sslmode, quoting, token
      copy-paste) — then **STOP the wave**, record the failure in the Progress Log, and report
      back to the human. Do not proceed with any implementation work while validation is failing.
- [x] pnpm workspaces + Turborepo tooling; TypeScript strict; root scripts: `dev`, `build`, `test`, `e2e`
- [x] `packages/shared`: Zod schemas for API + Colyseus room state; **Texture Spec** constants
      (1024×1024 PNG, ArUco 4x4_50 dict, corner IDs 0–3, drawable-quad geometry)
- [x] `apps/server`: Fastify boot + `/healthz`; Colyseus attached (empty LobbyRoom); reads `.env`
- [x] `apps/web`: Vite React boot; renders "hello world" + server health status
- [x] Template generator v1 in `packages/pipeline`: emits printable SVG template with markers
      (needed early so humans can print & draw while later waves run)
- [x] GitHub Actions CI: build + test + e2e on PR
- [x] **E2E #1 (Playwright):** web app loads, shows healthy server status
- **Gate:** `pnpm build` clean; E2E #1 green in CI. No secrets required for this wave.
- **Human checkpoint:** print a generated template (`assets/templates/template-trex.pdf`, or the
  `.svg`), confirm it looks right on paper. ⟵ **WE ARE HERE**

### Wave 2 — Pipeline + 3D world  `[ ] not started` *(2 opus agents, concurrent, worktrees)*
**Wave 2A — WS-A image pipeline** — branch `wave-2/pipeline` `[x] done`
- [x] js-aruco2 marker detection + drawable-quad extraction (isomorphic: browser + Node)
- [x] ~~OpenCV.js~~ perspective warp → canonical 1024×1024 PNG; levels cleanup
      *(deviation: hand-rolled homography instead of OpenCV.js — see Progress Log)*
- [x] Synthetic fixture generator: programmatically composite a "drawing" onto the template,
      apply random perspective/lighting → fixture photos (stand-ins until real phone photos land)
- [x] **Integration test:** each fixture → texture, SSIM ≥ threshold vs golden (Node, CI)
- **Human checkpoint:** replace/augment synthetic fixtures with ~10 real phone photos of a
  filled template; re-approve goldens.

**Wave 2B — WS-C 3D world** — branch `wave-2/world`
- [x] Low-poly dino GLB(s) with planar side-projection UV unwrap matching the Texture Spec
      (procedural/three-geometry authoring is fine for v1 if no Blender asset available)
- [x] r3f scene: ground, sky, lighting; dinos from state; nameplates; idle/wander motion
- [x] Runtime texture swap by URL/hash without model reload
- [x] `/debug/world` harness page: renders scene from static JSON + local texture files;
      exposes `window.__world` (dino count, applied texture hashes) for test assertions
- [x] **E2E #2 (Playwright):** harness loads 3 textures, `window.__world` correct, canvas
      screenshot-diff within tolerance
- **Gate (whole wave):** both modules' tests + cumulative E2E (#1, #2) green after merge of both branches.
- **Human checkpoint:** art review — does a test drawing look right on the dino?

### Wave 3 — Backend platform  `[x] done` *(3 opus agents, SEQUENTIAL chunks, one branch)* **⚠ requires `.env` secrets**
Branch: `wave-3/backend` — every chunk continues this same branch. *Human feedback after
Wave 2: ~30-minute agent runs are too long; chunks below target well under that, each with
its own gate (build + module tests + cumulative `pnpm e2e` green) before the next launches.*

**Chunk 3.1 — data layer** *(1 opus agent)*
- [x] Drizzle schema + migrations applied to Neon (players, avatars, lobbies, lobby_members —
      SQL in docs/ARCHITECTURE.md); `apps/server/src/db.ts`
- [x] Flesh out `apps/server/src/redis.ts` adapter (~6 functions: texture get/set, lobby
      member add/remove/list, publish) backed by `@upstash/redis` REST for v1. The adapter
      keeps a later swap to ioredis (only needed for multi-instance Colyseus in Wave 5) a
      one-file change.
- [x] Integration test (node --test, REAL Neon + Upstash): player+avatar insert/read
      round-trip; texture cache set/get byte-identical; test data cleaned up after.

**Chunk 3.2 — REST API** *(1 opus agent)*
- [x] `POST /api/lobbies`, `GET /api/lobbies/:code`, `POST /api/avatars` (multipart),
      `GET /api/textures/:hash` (Redis cache → Postgres fallback, immutable cache headers,
      content-addressed by sha256)
- [x] Join-code generation + validation against the shared contracts
- [x] Integration test: upload a fixture texture over real HTTP → fetch bytes back identical;
      lobby create/get lifecycle; structured errors for bad uploads.

**Chunk 3.3 — Colyseus room** *(1 opus agent)*
- [x] LobbyRoom: join-code rooms, synced player map `{id, name, modelSlug, textureHash}`,
      avatar-updated fanout as a direct in-process call from the API route (single process in
      v1 — no cross-process pub/sub needed)
- [x] **Integration test (@colyseus/testing):** client A joins lobby → POST fixture texture →
      client B's room state gets new hash → `GET /textures/:hash` bytes match upload
- **Gate (whole wave):** `[x]` all integration tests green against real Neon + Upstash
  (`pnpm test --force` 67/67); cumulative E2E green (`pnpm e2e` 6/6); `pnpm build` clean.

### Wave 4 — Mobile capture flow & flagship E2E  `[x] done` *(3 opus agents, SEQUENTIAL chunks, one branch)*
Branch: `wave-4/integration` — every chunk continues this branch; each chunk gates on
build + `pnpm test --force` + cumulative `pnpm e2e` before the next launches.

**Chunk 4.1 — lobby-connected game view** *(1 opus agent)*
- [x] Web client joins the real room (`colyseus.js` 0.16, `?lobby=CODE` from the joinUrl):
      game view renders the Wave 2 world FROM SYNCED ROOM STATE (server-assigned
      position/heading; wander stays client-local for now), spectator mode for projector
- [x] Texture flow: watch `players[*].textureHash`, prefetch on `avatar-updated` broadcast,
      hot-swap via the existing Dino component; `window.__world` stays accurate in live mode
- [x] **E2E #3:** spectate a lobby created via API, upload a texture over HTTP (request
      context), assert the dino + texture appear in `window.__world` in one browser
- [x] QR code on the game view encoding the lobby join URL for projector screens

**Chunk 4.2 — capture flow UX** *(1 opus agent)*
- [x] Flow: name + lobby code (URL-prefilled) → pick dino → `<input capture>` photo →
      `processPhoto` in-browser → preview drawing ON the 3D model → confirm/retake →
      upload → land in game view
- [x] Error UX: per-corner marker hints from `PipelineError`, blur warning, retake loop
- [x] **E2E #4:** capture flow with a fixture photo file through the real pipeline in-browser
      → upload → lands in game view (single browser, real server)

**Chunk 4.3 — flagship E2E** *(1 opus agent)*
- [x] **Flagship E2E (Playwright):** desktop browser A creates lobby + watches world; mobile-
      emulated browser B joins by code, pushes fixture photo through the REAL pipeline → API →
      Neon → Upstash → Colyseus; assert B's dino appears in A's `window.__world` with expected
      texture hash ≤ 5s; canvas screenshot-diff
- [x] Fix anything the flagship shakes out; wire it into CI (skip cleanly without secrets)
- **Gate (whole wave):** `[x]` flagship E2E green; full cumulative suite green
  (`pnpm build` clean · `pnpm test --force` 67/67 · `pnpm e2e` 12/12).
- **Human checkpoint:** real paper-to-screen dry run with 3–5 people.

### Wave 5 — Hardening & deploy  `[x] done` *(3 opus agents, SEQUENTIAL chunks, one branch)*
Branch: `wave-5/hardening` — each chunk gates on build + `pnpm test --force` + cumulative
`pnpm e2e` before the next launches. This wave also closes the open Follow-up checks below.

**Chunk 5.1 — world sync & framing** *(1 opus agent)*
- [x] Server-seeded motion: wander computed from server-issued seed + server clock so every
      client renders identical trajectories (closes the "two-client world consistency"
      follow-up); upgrade the flagship's position assertion to sample DURING motion
      — *room state carries `motionSeed`/`motionEpoch`/`serverTime` (500 ms tick); the flagship
      measures 0–1 ms clock skew and 1–5 mm between the two clients' moving dinos.*
- [x] Every dino on screen: fix the ~17% off-frustum spawns (camera framing from player
      count, wider fov, or smaller ring); re-record affected screenshot baselines
      — *`world/camera-fit.ts` dollies (then widens) the projector shot until every dino's whole
      reachable box is framed; E2E #2 proves it for 12 dinos on the full ring, landscape and
      portrait; `world-static.png` re-recorded.*
- [x] `/debug/world` harness keeps working (E2E #2) — deterministic static mode preserved
      — *harness still times its own wander (`motion.source === 'local'`), `?static=1` still t=0
      at DPR 1 in a fixed 800×500 frame; new `?size=WxH` renders any aspect for the framing test.*

**Chunk 5.2 — data & robustness** *(1 opus agent)*
- [x] Split texture blob (content-addressed, shared) from wearer record (per player) —
      closes the "one texture, one owner" follow-up sharp edge
      — *migration `0001_split_textures_from_wearers`: new `textures(hash PK, bytes, created_at)`,
      `avatars` is now one row per player (`player_id` UNIQUE, `texture_hash` a plain FK).*
- [x] Lobby lifecycle polish (idle dispose, `closed_at`), rate limiting on `POST /api/avatars`
      — *`lobby-lifecycle.ts`: one UPDATE on room dispose (and an occasional sweep on lobby
      create) closes lobbies quiet for `LOBBY_IDLE_HOURS`; `rate-limit.ts`: token bucket per
      person (12/min, burst 6) and per IP (10×, for the venue's shared NAT), off under
      `NODE_ENV=test`.*
- [x] `@colyseus/loadtest` ~50 clients in one lobby — script committed + numbers recorded
      — *`apps/server/loadtest/lobby-loadtest.ts`, `pnpm --filter @dino/server loadtest`:
      50/50 joined and synced, join p50 113 ms / p95 152 ms, upload→state on the **last** of
      50 clients 2–41 ms, 2.1 patches/s per client, server RSS 82 MB flat.*

**Chunk 5.3 — deploy readiness** *(1 opus agent)*
- [x] Server containerized/deployable to Railway/Fly/Render (Dockerfile + config), client
      static build for Vercel/Netlify; production env documented (`.env.example` parity)
      — *multi-stage root `Dockerfile` (pnpm-workspace aware, `pnpm deploy --legacy --prod`
      prunes to 231 prod packages), boot = migrate-then-serve, `/healthz` HEALTHCHECK;
      `render.yaml` (`numInstances: 1`) for the server and `netlify.toml` (SPA rewrite +
      immutable asset caching) for the client; `docs/DEPLOY.md` has Fly/Vercel equivalents.*
- [x] CI deploy workflow on `main`, gated on deploy secrets (skips cleanly without)
      — *`deploy` job, `needs: build-test-e2e`, push-to-`main` only, deploy-hook URLs
      (`RENDER_DEPLOY_HOOK_URL` / `NETLIFY_BUILD_HOOK_URL`) rather than CLI logins.*
- [x] Code-split `/play` (1.3 MB bundle → faster phone first-load)
      — *`/`'s eager JS went **1292 kB → 270 kB (372 kB → 87 kB gzipped, −77%)**: the 3D
      routes and the capture flow's preview step are `lazy()`, three.js is its own
      843 kB chunk that a phone fetches while the child is typing their name.*
- **Gate (whole wave):** `[x]` full cumulative suite green (`pnpm build` clean ·
  `pnpm test --force` **75/75** · `pnpm e2e` **14/14**); loadtest numbers recorded (Chunk 5.2).
- **Human checkpoint:** actual deploy (needs YOUR hosting accounts/credentials — agent
  prepares everything, human clicks); then the venue dry run on deployed URLs.

## Follow-up checks (validate before the event)

- [x] **Two-client world consistency** *(raised by human 2026-08-18 after the Wave 2 art
      review)*: two browsers in the SAME lobby must see the SAME world — dino positions and
      orientations in sync. `/debug/world` drifts across instances today by design (wander is
      seeded locally and timed from each page's own load clock; the harness has no backend).
      Fix belongs in Wave 4/5: either make positions server-authoritative in room state, or
      have the server issue the motion seed + a synced clock so clients compute identical
      trajectories. Validate with an E2E: two browser contexts join one lobby, sample
      `window.__world` positions/headings at the same tick, assert equal within tolerance.
      **Half-validated by the flagship E2E (Chunk 4.3):** two live clients report *identical*
      synced positions/headings (worst observed delta `0`), and their frozen canvases are
      pixel-identical (`?static=1`, 0 of 2560 cells differ). What is still unvalidated is the
      **wander**, which remains client-local and therefore still drifts between screens once
      motion starts; only the spawn state agrees. Server-authoritative (or seeded) motion is
      still the fix, and the flagship already has the assertion waiting for it.
      **CLOSED in Chunk 5.1:** the room now issues `motionSeed` + `motionEpoch` and reposts
      `serverTime` every 500 ms; clients evaluate the wander at *server* time, and the flagship
      measures clock skew 0–1 ms, identical trajectories (delta exactly 0 at an agreed future
      instant) and 1–5 mm between the two browsers' *moving* dinos sampled together.
- [x] **Every dino must be on screen** *(found by the flagship E2E, Chunk 4.3)*: `spawnFor`
      places players on a 4–8 m ring around the origin, but the projector camera
      (`[0.6, 3.6, 11.5]`, 42° fov) only covers ≈±32°, so **~17 % of spawn points fall outside
      the frame** — roughly one child in six would not see their dinosaur. Fix in Wave 5 by
      pulling the camera back / widening the fov (re-record E2E #2's baseline) or by shrinking
      the spawn ring; better still, frame the camera from the actual player count.
      **CLOSED in Chunk 5.1:** the camera is fitted to the live world — `world/camera-fit.ts`
      dollies the hand-tuned shot back (and, only for a portrait phone, widens the lens) until
      every dino's whole *reachable* box is in frame; `window.__world.offscreen` must be 0 and
      E2E #2 proves it for 12 dinos on the full 4–8 m ring at 1.78 and 0.50 aspect.
- [x] **The 5 s promise was almost entirely the texture download** *(measured and fixed in
      Chunk 4.3)*: of an upload→projector time of 1.4–4.4 s the Colyseus patch was ~20 ms and
      `GET /api/textures/:hash` was 0.8–3.9 s — a ~1 MB PNG fetched from Upstash over the
      public internet (or Neon on a miss), which occasionally blew the whole budget and
      sometimes tripped the client's own 4 s `PREFETCH_TIMEOUT_MS` into showing a placeholder
      dino first. `apps/server/src/texture-cache.ts` now memoises texture bytes in process
      (LRU over a 48 MB budget, filled by the upload route itself), so the screens' fetch is a
      memory hit: **3–33 ms, and fan-out 0.07–0.8 s**. Content-addressed keys make it
      unfalsifiable. Still open for Wave 5: multi-instance deployments warm one memo per
      instance, and the venue's uplink still carries the *upload*.
- [x] **One texture, one owner** *(sharp edge confirmed in Chunk 4.3)*: `avatars.texture_hash`
      is UNIQUE and `POST /api/avatars` upserts on it, so identical bytes from a second player
      move the row's `player_id` — and a lobby rebuilt from Postgres then hydrates the robbed
      player with no drawing. Harmless for real children (nobody draws byte-identical
      pictures) but it bit two E2E specs that shared a fixture photo. The clean fix is to split
      the blob (content-addressed, shared) from the wearer record (per player).
      **CLOSED in Chunk 5.2:** the blob moved to a `textures` table keyed by its own sha256, and
      `avatars` became the wearer record — one row per player (`player_id` UNIQUE,
      `texture_hash` a *non*-unique FK). An upload is now "ensure the texture row exists
      (`onConflictDoNothing`), then upsert **my** wearer row", so byte-identical uploads from two
      players give two dinos wearing one stored drawing. Asserted through the API
      (`rest-api.test.mjs`, "two players uploading identical bytes both keep their dino") and at
      the schema level (`data-layer.test.mjs`). Two E2E specs may share a fixture photo again.

---

## Environment & secrets

Copy `.env.example` → `.env` (gitignored) and fill in. Required from **Wave 3** onward;
Waves 1–2 run entirely without secrets.

| Variable | Used for | Where to get it |
|---|---|---|
| `DATABASE_URL` | Neon Postgres, pooled (app queries) | Neon console → connection string (pooled) |
| `DATABASE_URL_UNPOOLED` | Neon direct (Drizzle migrations) | Neon console → direct connection |
| `UPSTASH_REDIS_REST_URL` | Upstash REST endpoint (`https://<db>.upstash.io`) — v1 client | Upstash console → Redis → REST |
| `UPSTASH_REDIS_REST_TOKEN` | Auth for the REST client (verified: equals the `rediss://` password) | Upstash console → Redis → REST |
| `REDIS_URL` | Upstash via TCP/TLS (`rediss://…`) — kept for Wave 5 multi-instance; TCP 6379 is blocked on the dev machine by ProtonVPN | Upstash console → Redis → "ioredis" tab |
| `SESSION_SECRET` | Signing lobby/player tokens | Generate: any 32+ char random string |

## Progress log

Append-only. Every agent adds a line when it finishes (or blocks): `date — wave/module — result — notes`.

- 2026-08-18 — Wave 0 / scaffold — done — repo initialized, plan written, awaiting human review + `.env` fill-in.
- 2026-08-18 — Wave 1 / connection validation — **BLOCKED, wave stopped** — Neon OK (pooled +
  unpooled both pass `SELECT 1`, Postgres 17.10). Upstash FAILS: TCP to
  `pumped-vulture-135579.upstash.io:6379` connects, but the TLS handshake is reset mid-flight
  (openssl: `write:errno=10054`, 0 bytes read after ClientHello); TLS to the same host on
  port 443 succeeds with a valid `*.upstash.io` cert. Diagnosis: something on the local
  network path (Windows Firewall / antivirus TLS filtering / ISP) blocks TLS on port 6379.
  Not fixable from this machine's code. Needs human: allow outbound TLS on 6379, test from
  another network, or check AV/firewall SSL-scanning settings. No implementation work started.
- 2026-08-18 — Wave 1 / connection validation — **UNBLOCKED (Opus subagent deep-dive)** —
  Root cause revised: NOT a TLS block. ProtonVPN (WireGuard, kill-switch enforced via WFP) is
  the default route and its tunnel blackholes TCP to Upstash port 6379 entirely (port 6379
  behaves identically to known-closed ports; `TcpTestSucceeded=True` is a false signal on
  this box; local firewall/AV/proxy all exonerated). Both ioredis and node-redis fail — it's
  the network, not the library. **Resolution: `@upstash/redis` REST over 443 works NOW** —
  verified PING, SET/GET/DEL, SSE-based subscribe receiving a published message, and
  byte-identical base64 round-trip of binary data. The `rediss://` password doubles as the
  REST token. Decision: v1 uses `@upstash/redis` behind a thin adapter (Wave 3 bullet
  updated); ioredis path revisited in Wave 5 on deploy hosts with open 6379. Optional human
  check: disconnecting ProtonVPN should make ioredis work locally too.
- 2026-08-18 — Wave 1 / connection validation — **PASS** — all three checks green via
  `pnpm validate:connections` (`scripts/validate-connections.mjs`, now a permanent repo
  script + CI step): Neon pooled `SELECT 1` PostgreSQL 17.10 (1.1 s cold), Neon unpooled
  `SELECT 1` PostgreSQL 17.10 (0.3 s), Upstash REST `PING` → `PONG` (0.14 s).
  **One `.env` fix was needed** (allowed copy-paste troubleshooting): the
  `UPSTASH_REDIS_REST_TOKEN` line held the literal placeholder `PASSWORD` while the real
  token sat on the following line with no `key=` prefix, so dotenv never saw it. Repaired
  in the local (gitignored) `.env` only — no secret values were printed or committed. The
  token does equal the `rediss://` password, as `.env.example` documents.
- 2026-08-18 — Wave 1 / foundations — **done** — pnpm workspaces + Turborepo monorepo,
  strict TS everywhere; `packages/shared` freezes the Texture Spec + API/Room Zod contracts;
  `apps/server` = Fastify `/healthz` + Colyseus `LobbyRoom` (empty) sharing one http.Server,
  Redis behind the `apps/server/src/redis.ts` adapter (`ping` only for now, Wave 3 grows it);
  `apps/web` = Vite/React hello-world with live health polling; `packages/pipeline` template
  generator v1 emits SVG **and** PDF for every model slug into `assets/templates/`; GitHub
  Actions CI (build → test → soft-failing connection check → e2e); E2E #1 green.
  `pnpm build` clean, `pnpm test` 17/17, `pnpm e2e` 2/2.
  Notes for later waves: (a) pinned `pnpm.overrides["@colyseus/greeting-banner"]="^2.0.6"` —
  `@colyseus/core@0.16.25` publishes that dep as `workspace:^`, which no non-Colyseus
  install can resolve; drop the override once upstream fixes it. (b) Colyseus state uses
  `defineTypes` rather than `@type` decorators, so no decorator compiler flags are needed.
  (c) The Texture Spec adds a **10 mm / 64 px safe-area inset** inside the drawable quad
  (printed as the dashed "draw inside this box"), so drawings can't invade a marker's quiet
  zone — WS-C's UV unwrap must stay inside `TEXTURE_SAFE_AREA`.
- 2026-08-18 — Wave 2A / WS-A image pipeline — **done** — `pnpm build` clean, `pnpm test`
  41/41 (32 in `@dino/pipeline`, up from 8), `pnpm e2e` 2/2 (E2E #1 still green).
  `processPhoto(ImageData) → 1024² texture` runs detect → inner-corner rule → warp → levels;
  11 seeded synthetic fixtures in `assets/fixtures/`, 10 goldens in `assets/goldens/`,
  regenerable with `pnpm --filter @dino/pipeline generate-fixtures` (`--check` prints the
  SSIM report for the human golden re-approval). **SSIM threshold 0.88**: the set scores
  0.908–0.953, while a texture from the wrong photo scores 0.870, an 8px quad shift 0.853
  and a 90°-rotated corner order 0.806. Geometry is policed separately and far more tightly
  by asserting detected corners land within 6 px of the generator's answer key (worst: 3.9).
  **Deviation — no OpenCV.js.** `getPerspectiveTransform`/`warpPerspective` are ~250 lines of
  dependency-free TS in `src/homography.ts` + `src/warp.ts`. OpenCV.js is ~8 MB of WASM in
  the phone's critical path for two functions, and no single build loads cleanly in both Node
  (CI goldens) and a Vite bundle. The package root now bundles for the browser at **208 KB**
  with zero Node builtins (verified with esbuild `platform: browser`); swapping in
  `cv.getPerspectiveTransform` later is drop-in — the matrix convention is OpenCV's exactly.
  Notes for later waves: (a) **additive** `packages/shared/src/pipeline.ts` — `PipelineError`
  payload with a four-entry per-corner diagnostic (`corner`, `found`, `point`, `hint`), plus
  `PipelineQuality`; Wave 4's retake UX should render `err.payload.corners` directly, and
  `PIPELINE_QUALITY`'s blur/distance thresholds are provisional pending real photos.
  (b) Detection is a 3-step retry ladder (raw → flat-field normalised → normalised+½ scale);
  a raw pass alone finds all four markers in only 8 of 10 fixtures, and js-aruco2 routinely
  reports one physical marker twice (outer + inner border contour), so same-id sightings are
  merged by proximity, keeping the larger polygon. (c) Node-only bits (PNG codec over
  `node:zlib`, fixture writing) live behind the `@dino/pipeline/node` subpath so `apps/web`
  never pulls them in. (d) Wave 1's `aruco.ts` `createRequire` was replaced with a static ESM
  import so the package entry point is browser-safe. (e) Fixtures are 1200×1600 PNGs (~1.4 MB
  each, 16 MB total): PNG cannot compress sensor noise, so photo size is a direct repo-size
  cost — real fixtures will be JPEGs and can be bigger.
  (f) **Defect found and fixed while building the fixtures:** the printed dashed guide box
  sits 10 mm *inside* the drawable quad, so it lands inside the texture — every dinosaur
  would have worn a dashed rectangle. The pipeline now wipes everything outside
  `TEXTURE_SAFE_AREA` (plus a 6 px overrun) as a canonical final step: that is exactly the
  region the spec already reserves for template furniture, and the region WS-C's UV unwrap
  already excludes. Solved geometrically rather than by tinting the guide, so it holds for
  any printer. `rasterizeTemplate` now draws the guide too, so the golden suite covers it.
  Consequence for WS-C / Wave 4: a stroke drawn outside the printed box is clipped, by design.
- 2026-08-18 — Wave 2B / WS-C 3D world — **done** — branch `wave-2/world`. Four low-poly dinos
  (trex/stego/raptor/bronto) are **procedural three.js geometry** (allowed v1 alternative to a
  GLB — `assets/models/` stays empty): the box lists + the unwrap live in the new additive
  `packages/shared/src/dino-models.ts` so WS-A can print a matching outline guide
  (`dinoTextureOutline(slug)` returns the silhouette in texture pixels). **Unwrap for WS-A:**
  mirrored planar side projection along Z, with the animal's side-view bbox stretched to fill
  `TEXTURE_SAFE_AREA` exactly — drawing's LEFT edge → tail tip, RIGHT edge → snout, TOP edge →
  spine/head-top, BOTTOM edge → soles; both flanks share the UVs (the far side reads mirrored,
  head-on-head). r3f+drei scene (`apps/web/src/world/`): gradient sky dome, checkered ground,
  fake contact shadows, trees, DOM nameplates (drei `<Html>` — deliberately NOT in-canvas text,
  so OS fonts can't move a pixel of the screenshot), seeded wander motion (no `Math.random`).
  `/debug/world` ships in production and renders from `apps/web/public/debug/world.json` +
  local PNGs; `?static=1` freezes t=0, pins DPR 1, disables AA and fixes the canvas at 800×500;
  `window.__world` = `{version, ready, frozen, dinoCount, appliedTextures, textureStatus,
  pendingTextures, textureErrors, geometryBuilds, materialBuilds, frames, setTexture()}`.
  Test fixtures are generated (never hand-edited) by
  `node apps/web/scripts/generate-debug-textures.mjs`. E2E #2 (`e2e/tests/02-world.spec.ts`,
  4 tests) asserts dinoCount/appliedTextures, nameplates, live-vs-frozen motion, a hot texture
  swap that leaves `geometryBuilds`/`materialBuilds` unchanged, and a canvas screenshot vs
  `e2e/tests/__screenshots__/02-world.spec.ts/world-static.png` (SwiftShader forced,
  `maxDiffPixelRatio: 0.05`). `pnpm build` clean, `pnpm test` 22/22 node + 6/6 Playwright,
  `pnpm e2e` 6/6 (E2E #1 untouched). Notes: (a) `playwright.config.ts` gained
  `snapshotPathTemplate` without `{platform}` so ONE baseline serves Windows and CI's Linux —
  recorded on Windows; if CI ever exceeds the 5 % tolerance, re-record with
  `pnpm e2e:only -- --update-snapshots` rather than loosening it. (b) `@dino/shared`'s test
  script now lists both test files. (c) `e2e/tsconfig.json` gained the `DOM` lib so
  `page.evaluate` callbacks type-check. (d) Bundle is ~1 MB (three+drei) — code-split later if
  it matters.
- 2026-08-18 — Wave 2 / integration — **done, merged as PR #2** — orchestrator merged
  `wave-2/pipeline` + `wave-2/world`, gate verified on the merged tree: shared 14/14,
  pipeline 32/32, cumulative E2E 6/6. Human art review APPROVED. One observation logged as a
  follow-up check (see "Follow-up checks"): `/debug/world` instances drift out of sync across
  browsers — expected today (local seed + per-page clock, no backend), but real lobbies must
  render identically for every client.
- 2026-08-18 — Wave 3 / Chunk 3.1 data layer — **done** — branch `wave-3/backend`.
  `pnpm validate:connections` 3/3 green first. Drizzle schema (`apps/server/src/schema.ts`)
  matches docs/ARCHITECTURE.md §3 exactly; migration `apps/server/drizzle/0000_cute_xavin.sql`
  **applied to the real Neon DB** (`drizzle-kit migrate` over `DATABASE_URL_UNPOOLED`; app
  queries use pooled `DATABASE_URL` via a lazily-created `pg.Pool` in `src/db.ts`).
  `src/redis.ts` grew to the full surface: `getTexture / setTexture / addLobbyMember /
  removeLobbyMember / listLobbyMembers / publishAvatarUpdate` (+ `del`, `ping`, `client`),
  with the unconfigured null-object kept so no-secrets environments still boot.
  `pnpm build` clean, `pnpm test` 52/52 node (14 shared + 32 pipeline + **6 new server**,
  against real Neon + Upstash), `pnpm e2e` 6/6. Notes for Chunk 3.2: (a) `bytea` is a
  `customType` with no encode/decode hooks — `node-postgres` hands textures back as a `Buffer`
  and the test asserts byte-identity plus a matching sha256. (b) Upstash REST is JSON, so
  texture bytes are stored base64 behind a **`b64:` prefix** — without it a digits-only base64
  string comes back from `@upstash/redis` as a `number`; the prefix is an implementation
  detail of the adapter, callers only ever see `Buffer`. (c) `texture_hash` is `UNIQUE`, so
  re-uploading identical bytes raises SQLSTATE `23505` — 3.2's `POST /api/avatars` should
  treat that as "already cached" rather than an error. Drizzle wraps driver errors and its
  `.message` embeds the whole query (including the PNG), so branch on `err.cause.code`, never
  on the message. (d) Server tests skip (not fail) with no `.env`, verified by running with
  `.env` moved aside → 6 skipped, exit 0. (e) `turbo` caches the `test` task, so a cached
  server "pass" may not have re-hit Neon/Upstash; `.env` is a `globalDependencies` entry, and
  `pnpm test --force` re-runs for real.
- 2026-08-18 — Wave 3 / Chunk 3.2 REST API — **done** — branch `wave-3/backend`. Four routes
  live behind the frozen contracts: `POST /api/lobbies` (crypto-random 5-char code from
  `LOBBY_CODE_ALPHABET`, insert with `onConflictDoNothing` + retry so two creators can't race),
  `GET /api/lobbies/:code` (lobby + members with each player's latest `modelSlug`/`textureHash`),
  `POST /api/avatars` (multipart: PNG signature + IHDR check for exactly 1024², 2 MB cap, server
  re-derives the sha256 and rejects a mismatched client-supplied hash, then player/avatar/
  membership rows + Redis texture cache + live membership + publish), `GET /api/textures/:hash`
  (Redis → Postgres fallback that re-warms the cache, `image/png`, `cache-control: public,
  max-age=31536000, immutable`, ETag/304, 404 otherwise). `/healthz` now runs a real `dbPing()`
  alongside the Redis ping, still 200 and `status: "ok"` when a dependency is merely *absent*
  (`checks.* === null`) so E2E #1 stays green in no-secrets CI. `pnpm build` clean,
  `pnpm test --force` 60/60 node (14 shared + **14 server**, up from 6, + 32 pipeline) against
  real Neon + Upstash, `pnpm e2e` 6/6. Notes for Chunk 3.3: (a) **⚑ fan-out hook is already
  in place** — `apps/server/src/avatar-events.ts`; `POST /api/avatars` awaits
  `emitAvatarUpdated({lobbyCode, playerId, modelSlug, textureHash})` (payload ==
  `AvatarUpdatedMessageSchema`) as its last step, and 3.3 only has to call
  `setAvatarBroadcaster(fn)` in `index.ts`; failures inside the listener are logged, never
  surfaced, because the avatar is already committed by then. (b) **Additive contract change**
  in `packages/shared/src/api.ts`: `LobbyMemberSchema` (type `LobbyMemberInfo` — avoids a clash
  with the Drizzle `lobby_members` row type) plus a `members` field on
  `GetLobbyResponseSchema`; nothing existing was tightened. (c) Errors are the frozen
  `ApiErrorSchema` everywhere via one `setErrorHandler` + `setNotFoundHandler`; 5xx messages are
  scrubbed because Drizzle embeds the whole query (PNG bytes included) in `err.message`.
  (d) Same person re-uploading = same rows: a player is reused when that name is already a
  member of that lobby, and the duplicate `texture_hash` is handled by
  `onConflictDoNothing(target: avatars.textureHash)` + re-select, so 23505 never reaches the
  client. Consequence worth knowing: because `texture_hash` is globally UNIQUE, a *different*
  player uploading byte-identical pixels gets the original uploader's avatar row back —
  `response.player.id` is always the current player, `response.avatar.playerId` may not be.
  (e) `@fastify/multipart` is registered with `throwFileSizeLimit: false` (the route reports
  `texture_too_large` itself) and the whole body is drained before validation, since multipart
  field order is the client's choice. (f) Fastify logs drop to `warn` when `NODE_TEST_CONTEXT`
  is set, so `node --test` output stays readable. (g) Server tests still skip cleanly with no
  `.env` (verified: 7 skipped, 1 pass, exit 0). (h) `joinUrl` is
  `${PUBLIC_WEB_URL}/?lobby=CODE` — a query param, so it works with today's single-page web app
  and whatever router Wave 4 picks.
- 2026-08-18 — Wave 3 / Chunk 3.3 Colyseus room — **done, WAVE 3 COMPLETE** — branch
  `wave-3/backend`. `LobbyRoom` is live: `gameServer.define('lobby', LobbyRoom).filterBy(['code'])`
  gives **one room per lobby code**, so clients only ever call
  `joinOrCreate('lobby', {code, name?, modelSlug?, playerId?, spectator?})` and never handle a
  Colyseus room id. `onCreate` validates the code against Postgres and refuses an unknown or
  closed lobby with a structured `ServerError` (`ROOM_ERROR_CODES.lobbyNotFound` 4040 /
  `lobbyClosed` 4090 / `invalidJoinOptions` 4000) — a typo'd code can no longer conjure an empty
  world. `autoDispose` cleans up the empty room; a `roomsByCode` registry (a Map, not Redis —
  single process in v1) routes the fan-out. Colyseus wiring moved out of `index.ts` into
  `src/game-server.ts` (`createGameServer(app)` + `defineRooms`) so the integration test boots
  the *real* wiring rather than a lookalike; `index.ts` now just calls it, and that is where
  `setAvatarBroadcaster(applyAvatarUpdate)` happens. `pnpm build` clean, `pnpm test --force`
  **67/67** node (14 shared + **21 server**, up from 14, + 32 pipeline) against real Neon +
  Upstash, `pnpm e2e` 6/6. Notes for Wave 4: (a) **`state.players` is keyed two ways on purpose**
  — by Colyseus `sessionId` for a live WS client, and by `playerId` (a uuid) for someone in the
  lobby with no socket: a phone that uploaded over plain HTTP, or an uploader who closed the tab.
  `keyIsPlayerId(key)` tells them apart, and the two key spaces can't collide (9 chars vs 36).
  Consequence the projector depends on: **a dino that has a drawing survives its owner
  disconnecting.** (b) The fan-out matches the uploader by `playerId` and, failing that, by
  **name** (which is how the REST layer already identifies a person within a lobby), then adopts
  the real id — so a client that joined the room *before* it had a persisted playerId does not
  end up with two dinos. The uploader's display name is read from Postgres inside the room
  because `AvatarUpdatedMessageSchema` carries no name; the route layer was not touched.
  (c) **position/heading are server-assigned once, at join** — `spawnFor(playerId)` hashes the
  id into a point on a 4–8 m ring facing the origin, so it is identical in every client's copy
  and stable across reconnects. Nothing moves them yet: Wave 2's wander is still computed
  locally per browser, and the `move` message handler exists but no client sends one. That makes
  `spawnFor` the natural seed for the **two-client consistency follow-up** — make motion
  server-authoritative (or issue seed + synced clock) from there. Note Colyseus's `'number'`
  field is float32 on the wire, so compare positions with a tolerance, never `deepEqual`.
  (d) **Additive contract changes** in `packages/shared/src/room.ts`: `LOBBY_ROOM_FILTER`,
  `LobbyJoinOptionsSchema`/`LobbyJoinOptions` (the real wire options — `code` required,
  everything else optional so a spectator can join with `{code}` alone), and `ROOM_ERROR_CODES`.
  The frozen `JoinLobbyOptionsSchema` is untouched. (e) **Spectators** (`{code}` with no `name`,
  or `spectator: true`) see the whole world and add no dino — that is the projector view, and
  `room.spectatorCount` reports them. (f) New test `apps/server/test/lobby-room.test.mjs` (7
  tests) is the wave's flagship: real Fastify + real Colyseus on one `http.Server`, real
  `colyseus.js` WS clients via `@colyseus/testing` `boot(gameServer)`, real `fetch` over a real
  socket (not `inject`), real Neon + Upstash; the upload→both-clients fan-out lands in ~600 ms
  against a 5 s budget. Devdeps added: `@colyseus/testing@^0.16` + `colyseus.js@^0.16` — **pin
  the 0.16 line**, the 0.17 default drags in `@colyseus/core@0.17` and conflicts. (g) `boot()`
  binds port **2568** and ignores its `port` argument, and it needs Fastify `ready()` but NOT
  `listen()` — Wave 1's `app.ts` factory is exactly what makes that possible. (h) The PNG
  fixture builder is now shared at `apps/server/test/fixture-png.mjs` (was duplicated inside
  `rest-api.test.mjs`). (i) Room tests skip cleanly with no `.env` (verified: 7 skipped, exit 0).
- 2026-08-18 — Wave 4 / Chunk 4.1 lobby-connected game view — **done** — branch
  `wave-4/integration`. New route **`/play?lobby=CODE`** (`apps/web/src/pages/PlayPage.tsx`) is
  the projector screen: it joins the real room over `colyseus.js` **0.16.22** and renders the
  Wave 2 world from synchronized state. **Live mode and `/debug/world` share 100 % of the
  renderer** — both hand `<WorldView>` a `PlayerState[]` plus a `resolveTextureUrl`, so all of
  `window.__world` (still `version: 1`, unchanged shape) is maintained in
  `WorldView`/`Dino` and is exactly as accurate live as in the harness; E2E #2 is untouched.
  No `name` == **spectator**, which is the default a projector URL gets; a deliberately bare
  name+model form is there so the screen can also play (Chunk 4.2 replaces it). New
  `apps/web/src/lobby/`: `room.ts` (endpoint, `joinLobby`, `describeRoomError`, state→
  `PlayerState[]`), `useLobbyRoom.ts` (the hook), `QrCode.tsx`. **Texture gate:** an
  `avatar-updated` broadcast starts `loadWorldTexture(GET /api/textures/:hash)` immediately and
  the player's *previous* hash keeps rendering until those bytes are cached, so the swap
  resolves from cache in the frame it is applied; a failed or >4 s fetch releases the gate
  anyway (a broken drawing shows a placeholder dino, never stalls the projector). Joining an
  existing lobby prefetches everyone already drawn through the same path. QR code (
  `qrcode-generator`, rendered as inline SVG — no `dangerouslySetInnerHTML`) encodes
  `${origin}/?lobby=CODE`, the same shape `POST /api/lobbies` returns as `joinUrl`; the code
  itself is set in 3.5 rem type. Room errors map to readable text + retry
  (`ROOM_ERROR_CODES` → message). Motion sync deliberately NOT built — wander stays
  client-local (the "two-client world consistency" follow-up still stands). `pnpm build` clean,
  `pnpm test --force` **67/67** node + 8/8 Playwright, `pnpm e2e` **8/8** (E2E #1 and #2 green).
  Notes for Chunk 4.2: (a) **routes** are `/` (landing — yours to turn into the capture flow;
  it already reads `?lobby=CODE` and links onward), `/play` (game view), `/debug/world`
  (harness, do not break). (b) **The game view's join API is the query string**: `?lobby=CODE`
  (required), `?name=`, `?model=slug`, `?playerId=uuid`, `?spectator=1`, `?static=1`. After a
  successful `POST /api/avatars`, land the phone on
  `/play?lobby=CODE&name=NAME&model=SLUG&playerId=<response.player.id>` — passing the persisted
  `playerId` is what stops the room minting a second dino for the same person. Invalid values
  are dropped rather than turned into a join failure. (c) `window.__world.ready` requires
  `dinoCount > 0`, so an *empty* lobby never reports ready — wait on
  `[data-testid=lobby-status][data-status=connected]` instead. (d) **E2E #3**
  (`e2e/tests/03-live-lobby.spec.ts`, 2 tests) creates a lobby via the request context, opens
  `/play` as a spectator, POSTs a 1024² PNG over HTTP and asserts the dino + hash land in
  `window.__world` inside the 5 s budget (observed ~1.5 s); it skips on
  `/healthz` → `checks.postgres === null` (verified: 1 skipped, exit 0), so it asks the server
  it is actually testing rather than looking for a file. (e) Bundle is now ~1.23 MB
  (+colyseus.js/qr) — code-split when it matters. **Two shake-outs fixed while gating:**
  (i) `apps/server/test/fixture-png.mjs` derived its whole image from a **one-byte** seed hash,
  so it could only ever emit 256 distinct PNGs while `avatars.texture_hash` is UNIQUE — two
  runs with colliding tints silently shared an avatar row and broke
  `avatar.playerId === player.id`. It now stamps the seed's own bytes into row 0 (the e2e copy
  at `e2e/support/fixture-png.ts` does the same). (ii) `turbo run test` used to run the
  Playwright suite *concurrently* with the Neon/Upstash integration tests; both measure
  wall-clock, and the room test's "fan-out well inside 5 s" started tripping at ~6 s.
  `turbo.json` now gives `@dino/e2e#test` a `dependsOn` on the three Node suites. E2E #2's
  "the live world animates" check was also switched from one sample after a fixed 1.2 s to
  `expect.poll` — same assertion, room to be observed on a loaded machine.
  **Known litter:** E2E #3 has no DB client, so its lobby/player/avatar rows stay in Neon;
  they are tagged `e2e-<8 hex>` (lobby name `e2e <id>`) and Chunk 4.3 should decide whether the
  browser suite gets a cleanup path.
- 2026-08-18 — Wave 4 / Chunk 4.2 mobile capture flow — **done** — branch `wave-4/integration`.
  *(Implemented by one agent that was killed by a network error just before it wrote this line;
  a resume agent verified the whole thing from scratch and landed it. No implementation was
  redone — the inherited work was complete and needed no fixes.)* **`/` is now the capture
  flow** (`apps/web/src/capture/`): a four-step, one-question-per-screen mobile form —
  details (name + lobby code, prefilled from `?lobby=CODE`, validated locally then against
  `GET /api/lobbies/:code` *before* anyone draws) → dino picker (`DinoSilhouette.tsx`, the same
  outline the printed template carries) → `<input type="file" capture="environment">` →
  preview → confirm → `POST /api/avatars` → `window.location.assign('/play?lobby&name&model&
  playerId')`. **The pipeline runs in the browser**: `capture/photo.ts` decodes the camera file,
  downscales to a 1600 px long edge (marker detection gains nothing above it, and cost scales
  with pixel count), calls the isomorphic `processPhoto` from `@dino/pipeline` on the main
  thread behind a spinner, and encodes the canonical 1024² PNG via `OffscreenCanvas`; the
  server only ever sees a finished texture. **Never import `@dino/pipeline/node` from the web
  app** — that subpath pulls in `node:zlib`. Measured in E2E #4 on this machine:
  **`processPhoto` 1073 ms, 1351 ms wall clock** including decode + PNG encode; confirm →
  dino on the game view 10.7 s (dominated by a cold second page load, not the upload).
  **Preview is the real renderer:** `capture/PreviewStage.tsx` feeds `<WorldView>` a one-entry
  `PlayerState[]` (id `capture-preview`) and a `resolveTextureUrl` returning the blob URL of
  the PNG about to be POSTed — same geometry, same unwrap, same bytes as the projector, no
  round trip. `WorldView` gained optional `cameraPosition`/`cameraTarget` props (defaulting to
  the wide projector shot, so E2E #2's screenshot baseline is untouched) because a phone needs
  a close-up. **Error UX:** a `PipelineError` becomes a four-entry per-corner diagnostic —
  every corner is listed, found ones included, which is what turns "it didn't work" into
  "three of four; move your thumb off the bottom-left square" — and the retake control is the
  *same* file input (its value is cleared on change so re-picking the same file still fires).
  `blurry`/`too_far` are advisory only and never block. `api.ts` gained `ApiClientError`
  (frozen `ApiErrorCode` + status, `null` when the server never answered), `fetchLobby` and
  `uploadAvatar`, each mapping statuses to a sentence a nine-year-old can act on.
  **Two server-side changes 4.3 must know about.** (a) The `lobby_members` + latest-avatar
  query moved out of `routes/lobbies.ts` into **`apps/server/src/lobby-members.ts`**
  (`loadLobbyMembers`), because `LobbyRoom.onCreate` now `await`s it to **hydrate a fresh room
  from Postgres**: a room is `autoDispose`d the moment it empties, so the first person to draw
  uploads over plain HTTP with *no room alive*, then opens `/play` and creates a brand-new one
  — without hydration they walk into an empty field missing their own dinosaur. Hydrated
  entries are keyed by `playerId` and `onJoin` re-keys them onto the `sessionId`, so nobody is
  ever cloned; members with no drawing are skipped; a read failure warns and yields an emptier
  world rather than an unjoinable lobby. `GET /api/lobbies/:code` returns byte-identical
  output. (b) `POST /api/avatars` changed its texture-hash conflict action from
  `onConflictDoNothing` to **`onConflictDoUpdate`** (claim `player_id`/`model_slug`): the
  avatars row is both the blob *and* the record of who wears it, so `doNothing` left a
  duplicate-texture uploader with no avatar row — invisible in `GET /api/lobbies/:code` and,
  now, absent from a hydrated room. **The last uploader of a given set of pixels owns them**,
  so `avatar.playerId` is now always the current uploader rather than the original one. Two
  children never draw byte-identical pictures; a fixture uploaded twice does, which is why
  4.3's two browsers must use **distinct** texture bytes per player or the second will steal
  the first's row. `App.tsx` demoted the Wave 1 health card to a collapsed `<details>` (E2E #1
  asserts text, not visibility, and still passes) and dropped the placeholder invite/spec
  cards. **Gate:** `pnpm build` 4/4 · `pnpm test --force` **67/67** (shared 14, server 21,
  pipeline 32), 6/6 tasks · `pnpm e2e` **11 tests, 10 passed**. E2E #4
  (`e2e/tests/04-capture-flow.spec.ts`, **3 tests**, 390×844 viewport) drives the occluded
  fixture `photo-11-occluded.png` → asserts the per-corner retake UI and that the flow did not
  advance → retakes with `photo-01-flat.png` → asserts the texture is on the 3D model *before*
  upload → confirms → asserts the dino wearing that exact hash on `/play`. Verified it skips
  cleanly with no `.env`: **9 passed, 2 skipped, exit 0**. **The one E2E failure is
  pre-existing and not from this chunk:** E2E #3's `upload → projector < 5000 ms` budget
  measured 5362 ms — but stashing all of 4.2 and re-running at `83b7963` gave **8307 ms and
  5823 ms**, i.e. *worse*, so this is Neon/Upstash round-trip latency from this machine today
  (4.1 recorded ~1.5 s), not a regression. Hydration cannot be the cause either: E2E #3's room
  is created when the projector connects, before the measured window opens. **Chunk 4.3 should
  decide whether that budget is measuring the right thing** — `elapsed` spans the POST *plus*
  the fan-out wait while the inner `waitForFunction` gets the full 5 s on its own, so a slow
  upload can bust the assertion even when fan-out was instant.
- 2026-08-18 — Wave 4 / Chunk 4.3 flagship E2E — **done, wave closed** — branch
  `wave-4/integration`. **E2E #5 (`e2e/tests/05-flagship.spec.ts`) is the whole product in one
  test:** a lobby over HTTP, a drawing already in it (run-seeded PNG, request context), a
  desktop context spectating `/play?lobby=CODE`, and a **Pixel-5-emulated context driving the
  real capture flow** on `assets/fixtures/photo-02-tilted.png` — pipeline in the browser,
  `POST /api/avatars`, Neon, Upstash, Colyseus — asserting **B's dino wearing B's exact hash on
  A's projector inside the 5 s budget**, then B landing in the same world. Measured today:
  in-browser `processPhoto` 1.0–5.0 s and **upload accepted → dino on the projector 0.07–0.7 s**
  against the 5 s budget. Getting there was the chunk's biggest find: the fan-out was
  1.4–4.4 s and **almost all of it was `GET /api/textures/:hash`** (0.8–3.9 s for a ~1 MB PNG
  from Upstash/Neon over the public internet; the Colyseus patch is ~20 ms), which failed the
  budget outright on two runs. New `apps/server/src/texture-cache.ts` memoises texture bytes in
  process — an LRU over a 48 MB budget, filled by `POST /api/avatars` itself, because the
  screens ask for exactly the bytes this process just accepted. Keys are sha256 of the value,
  so an entry can never be stale; Redis and Postgres stay behind it. The projector's fetch went
  to **3–33 ms** and the whole promise now has an order of magnitude of headroom. Three further follow-ups came out
  of what the flagship measured (spawn ring vs camera frustum, one texture/one owner, and the
  remaining half of two-client consistency); see *Follow-up checks*.
  **The budget was measuring the wrong thing (fixed in three places).** `elapsed` used to span
  the POST *plus* the fan-out; the POST alone is 3.5–6.3 s from this machine, so the assertion
  failed on connection latency while fan-out was instant. E2E #3, the flagship and the server's
  `lobby-room.test.mjs` now all start the clock when `POST /api/avatars` **responds** and print
  the upload time separately. First honest measurement of the thing the budget is about:
  **fan-out to both clients 0–95 ms** (`lobby-room`, no browser) and **0.8 s** end to end in
  E2E #3 (which includes the projector fetching the PNG). Not a number change — a change of
  what is timed, and it immediately exposed the texture-fetch cost above.
  **`window.__world` is now `version: 2`**: purely additive `players` (`playerId → {x, y, z,
  heading, modelSlug}`), the state as handed to the renderer, maintained in `WorldView` for
  live *and* harness mode. It exists so two clients can be compared: the flagship asserts A's
  and B's synced values agree within float32 tolerance and **observed a worst delta of exactly
  0** — the first automated evidence for the "two-client world consistency" follow-up (the
  *wander* is still client-local and still drifts; only spawn state is proven). E2E #2 and #3
  assert `version === 2` and E2E #2 checks `players` against `world.json` verbatim.
  **Canvas assertion, and why there is no golden PNG:** spawn positions are server-assigned per
  run, so no committed baseline can be valid in live mode. Instead both browsers open the same
  lobby at **`/play?…&static=1`** and their canvases are compared cell by cell (64×40 luminance
  signature read out of the WebGL buffer, so DOM overlays cannot influence it): a frozen canvas
  re-sampled 750 ms later is bit-identical (the control — a metric that cannot see change
  cannot prove agreement), and **the two independent clients differ by 0 of 2560 cells**. Both
  frames are attached to the Playwright report. `?static=1` on `/play` had never been used and
  inherited `/play`'s fill-the-projector layout; it now renders the same fixed 800×500 in-flow
  frame `/debug/world?static=1` does (`PlayPage` + two CSS rules), which is what makes the
  comparison window-independent. Deliberately **not** asserted: "B's arrival changed N pixels".
  `spawnFor` rings 4–8 m, the camera covers ≈±32°, and ~17 % of the ring is off-frame, so that
  assertion is a coin flip — it is a product bug, now a follow-up, not a test threshold.
  **Neon litter has a cleanup path**: `scripts/cleanup-e2e-rows.mjs` (root `pg` + `dotenv`,
  `pnpm e2e:cleanup`) deletes only rows whose name matches the anchored e2e tags
  (`lobbies.name ~ '^e2e [0-9a-f]{8}$'`, `players.name ~ '^e2e-[0-9a-f]{8}'`) plus their
  avatars/memberships, and Playwright's new `globalTeardown` (`e2e/global-teardown.ts`) spawns
  it after the last test — so `@dino/e2e` still has no database driver. It prints `SKIP` with no
  `DATABASE_URL` and swallows any error: housekeeping must never redden a green suite. First
  run cleared **39 lobbies / 40 players / 26 avatars** left by Waves 3–4.
  **CI** now passes the four secrets to the E2E step, so the workflow runs the full browser
  suite including the flagship when they exist and skips cleanly when they do not (verified
  locally with `.env` moved aside: **9 passed, 3 skipped, exit 0**, cleanup `SKIP`).
  **Shaken out by the flagship:** (a) the three fan-out budgets above; (b) the texture memo;
  (c) `/play?static=1`'s layout; (d) **E2E #4 and #5 must not share a fixture photo** — a
  fixture always yields the same texture bytes, `POST /api/avatars` upserts on the UNIQUE
  `texture_hash`, and the two specs run in parallel, so whichever uploaded second stole the row
  and the other's lobby (room disposed, rehydrated from Postgres) came back with no drawing.
  That is exactly the 4.2 hand-off warning, and it cost one red run before the flagship moved
  to `photo-02-tilted.png`. `rest-api.test.mjs` also learned to clear the new memo, so its
  "cache miss → Postgres fallback → cache re-warmed" assertion still tests what it says.
  **Gate:** `pnpm build` 4/4 · `pnpm test --force` **67/67** (shared 14, server 21, pipeline 32)
  · `pnpm e2e` **12/12**. Notes for Wave 5 / the human dry run: the projector now serves
  drawings from memory, so the remaining variable is the *upload* (3.5–6.3 s for ~1 MB from
  this connection — test the venue's Wi-Fi early, and expect a phone on a bad signal to sit on
  the spinner); check the camera framing against a real group (~1 in 6 spawns is off-frame
  today); and E2E #4's `confirm → dino on the game view` is 10–17 s against a 15 s budget,
  dominated by a cold second page load of a 1.3 MB bundle — code-splitting `/play` is the
  obvious win and would also make the phone's hand-off feel instant.
- 2026-08-19 — Wave 5 / Chunk 5.1 world sync & framing — **done** — branch `wave-5/hardening`.
  **Motion is now shared, not merely identical-looking.** `LobbyState` gained three additive
  fields (`motionSeed`, `motionEpoch`, `serverTime`; `LobbyStateSchema` mirrors them with
  defaults so an older server still parses): the room mints one seed per lobby, records the
  epoch motion time counts from, and rewrites `serverTime` every `SERVER_TIME_TICK_MS` (500 ms)
  from `this.clock.setInterval` — which fires immediately *before* each patch is serialized, so
  the value a client receives is one network hop stale, not one tick. **The epochs are
  `float64` on purpose**: Colyseus's `'number'` degrades to float32 for large values, which
  quantises a ~1.8e12 ms timestamp into ~131 s steps and would have made the whole scheme
  useless; `lobby-room.test.mjs` watches a tick land (~500 ms, never 0 or 131 072) to prove ms
  precision survives the wire. Each client estimates its offset as the **largest**
  `serverTime - Date.now()` it has seen (a page busy compiling shaders processes a patch late,
  which reads as an offset that is too small; every later sample can only correct it upward),
  then evaluates the wander at `Date.now() + offset - epoch`. Wander parameters are hashed from
  `seed:playerId` instead of `playerId`, so the trajectory is a pure function of state.
  Measured by the flagship, repeatedly: **clock skew between the two browsers 0–1 ms**,
  **identical trajectories (delta exactly `0` when both are asked for B's pose at an agreed
  future instant)** and **1–5 mm between the two clients' *moving* dinos** sampled at the same
  wall-clock moment (budget 0.35 m; the pre-Wave-5 behaviour was metres apart). That closes the
  "two-client world consistency" follow-up with the dinosaurs walking. `/debug/world` passes no
  motion source and keeps its page-local clock (`motion.source === 'local'`), and `?static=1`
  is untouched: t = 0, DPR 1, fixed 800×500.
  **Every dino is on screen.** New `apps/web/src/world/camera-fit.ts` keeps the hand-tuned
  projector angle and dollies it back (≤3×) until every dino's whole *reachable* box —
  `motionBounds()`, the exact interval the wander can visit, at foot and head height — is inside
  the frustum with a 12 % margin; only if that saturates (a phone in portrait, whose horizontal
  field is far too narrow for a 16 m world) does it widen the lens, up to 80°. It is pure,
  clamped at 1× (a one-dino lobby looks exactly as before) and quantised, so two clients holding
  one state compute one camera — which is what keeps the flagship's cross-client canvas
  comparison meaningful (still **0 of 2560 cells differ**). Wander amplitudes were trimmed
  (max excursion ~2.6 m rather than ~4.6 m) so framing a full lobby does not turn the animals
  into specks. Verified by a new E2E #2 test on a new fixture `public/debug/world-crowd.json` —
  **12 dinos on the full 4–8 m spawn ring, sampled every 0.25 s across a whole 60 s wander
  period**, at 1.78 aspect (projector: camera `[0.924, 4.842, 17.71]`, fov 42) and 0.50 aspect
  (phone: camera `[1.8, 8.2, 34.5]`, fov 68) — plus `window.__world.offscreen === 0` asserted
  live in E2E #2, #3 and the flagship.
  **`window.__world` is now `version: 3`** (additive): `poses` (the *animated* transform per
  player, rewritten every frame, each carrying the motion time it was evaluated at), `motion`
  (`source`/`seed`/`epoch`/`offsetMs`/`samples`), `camera` (the fitted shot + canvas aspect),
  `offscreen`, `motionTime()` and the analytical hooks `poseAtTime(id, t)` /
  `playerOnScreen(id, t)`. E2E #2/#3/#5 assert `version === 3`. `/debug/world` also gained
  `?size=WxH`, which pins the canvas to an exact size (the camera fits itself to the canvas
  *aspect*, and the page's own CSS never produces a phone-shaped frame).
  **Baseline re-recorded**: `e2e/tests/__screenshots__/02-world.spec.ts/world-static.png` — the
  harness camera legitimately moved from `[0.6, 3.6, 11.5]` to `[0.702, 3.991, 13.455]` because
  the fit now guarantees the bronto at (7.2, −6.2) stays framed for its whole wander. Recorded
  on Windows/SwiftShader as before; re-record with `pnpm e2e:only -- --update-snapshots` if a
  future change moves it again.
  **Gate:** `pnpm build` 4/4 · `pnpm test --force` **68/68** node (shared 14, server **22**,
  pipeline 32) · `pnpm e2e` **14/14** (two new framing tests). Notes for Chunk 5.2: (a) the
  room's `move` message is still the only path that can move a dino authoritatively and still
  nobody sends one — motion stays a client-side function of synced state, which is what makes
  it free; (b) `SERVER_TIME_TICK_MS` is 2 tiny patches/second per room, worth remembering when
  the loadtest puts ~50 clients in one lobby; (c) `spawnFor`'s 4–8 m ring is unchanged, so
  nothing about lobby data moved — 5.2's texture/lifecycle work does not touch any of this.
- 2026-08-19 — Wave 5 / Chunk 5.2 (data & robustness) — done — **One texture, one owner is
  closed at the schema.** Migration `0001_split_textures_from_wearers` (applied to the real
  Neon) adds `textures(hash PK, bytes, created_at)` — the drawing, addressed by its own sha256
  and shared — and turns `avatars` into the *wearer* record: one row per player
  (`player_id` UNIQUE), `texture_hash` a plain FK, `texture` column dropped. The migration
  moves blobs across (`INSERT … SELECT DISTINCT ON (texture_hash)`) and collapses any avatar
  history to the newest row per player before adding the constraints; against the real database
  it moved **nothing**, because `avatars`/`players` were empty (Waves 3–4 test litter had
  already been cleaned) — 3 stale lobby rows survived untouched and have since been stamped
  `closed_at` by the new idle sweep. `POST /api/avatars` is now "ensure the texture row exists
  (`onConflictDoNothing` on the hash) → upsert **my** wearer row (`onConflictDoUpdate` on
  `player_id`)", so **duplicate bytes from a second player are shared, not stolen**: two dinos,
  one stored PNG, both still there when the lobby rehydrates. `GET /api/textures/:hash` reads
  `textures` and no longer cares who wears the drawing; `loadLobbyMembers` lost its
  "latest per player" fold; `cleanup-e2e-rows.mjs` deletes textures nobody wears.
  **Lifecycle:** `lobby-lifecycle.ts` — idle == the room is gone AND nothing (join or upload)
  has happened for `LOBBY_IDLE_HOURS` (12). That is one race-safe UPDATE, run on
  `LobbyRoom.onDispose` for that lobby and as an occasional (≤1 per 10 min) untargeted sweep on
  `POST /api/lobbies`. No scheduler, no timer, and a server that sleeps all night closes
  yesterday's lobbies when the next party starts. `GET /api/lobbies/:code` now answers **409
  `lobby_closed`** instead of a 200 with `closedAt` set (the web client got the 409/429
  sentences), the upload route already refused, and room join keeps rejecting with 4090.
  `POST /api/lobbies` already accepted an optional `name` — verified, untouched.
  **Rate limiting:** `rate-limit.ts`, a ~40-line token bucket in process. Two buckets per
  upload: by IP *before* the multipart body is drained (a stuck retry loop costs a header
  parse, not 2 MB), and by IP+lobby+player after the fields parse. The per-person allowance is
  **12/min, burst 6** (continuous refill, so thinking between retakes is never punished) and the
  per-IP one is deliberately **10×** that — at the venue a whole class is behind one Wi-Fi NAT,
  so a strict per-address limit would refuse the party rather than the abuser. Refusal is
  `rate_limited` 429 + `Retry-After`. **Disabled by default under `NODE_ENV=test`/`node --test`** so E2E stays
  deterministic, which is why the maths is asserted at the unit with an injected clock
  (`test/robustness.test.mjs`, which also drives the idle sweep against real Neon).
  `.env.example` documents both knobs — and empty values there now read as *unset*, not as `0`.
  **Loadtest** (`apps/server/loadtest/lobby-loadtest.ts`, `pnpm --filter @dino/server loadtest`,
  manual only): starts the built server on port 2568, creates a real lobby, joins N clients,
  uploads mid-run, then cleans its own rows out of Neon. **50/50 joined, 50/50 synced** (every
  client sees all 50 players), join p50 **113 ms** / p95 **152 ms** / max 939 ms; five 117 kB
  uploads accepted in 1.36–1.60 s each (localhost multipart + Neon write) and reaching the
  **slowest of the 50 clients' state in 2–41 ms**; **2.10 patches/s per client** (1050 patches
  across 50 clients in 10 s — the 500 ms `serverTime` tick, exactly as predicted by 5.1);
  server RSS **82.5 → 82.1 MB** flat under load. `--tui` hands the same client script to
  `@colyseus/loadtest`'s dashboard.
  **Gate:** `pnpm build` clean · `pnpm test --force` **75/75** (shared 14, server **29**,
  pipeline 32) · `pnpm e2e` **14/14**. Notes for Chunk 5.3: (a) the limiter and the texture
  memo are both **per process**, so a multi-instance deploy multiplies the effective upload
  limit and warms one memo per instance — worth a line in the deploy docs, and the reason to
  prefer one server instance for the event; (b) two new env knobs to carry into the production
  env/`.env.example` parity check (`AVATAR_UPLOAD_LIMIT_PER_MIN`, `LOBBY_IDLE_HOURS`), and a
  container must run `db:migrate` (journal is at `0001`) before serving; (c) `pnpm test` still
  hits the real Neon/Upstash, so CI without secrets skips those files as before.
- 2026-08-19 — Wave 5 / Chunk 5.3 (deploy readiness) — done — **the phone stopped paying for
  three.js, and the deploy is now a form to fill in.** `/`'s eager JS went **1292 kB → 270 kB
  (372 → 87 kB gzipped, −77 %)**. The split is two dynamic-import boundaries, not a router:
  `main.tsx` `lazy()`s `/play` and `/debug/world`, and — the one that actually mattered —
  `CapturePage` `lazy()`s `PreviewStage`, because the capture flow renders the *same*
  `WorldView` in its last step, so splitting only the routes would have shipped three.js to
  step 1 anyway. A `warmPreview()` prefetch fires the moment the child leaves "Who are you?",
  so the renderer downloads during the name/model/photograph steps and the Suspense fallback
  never paints. `manualChunks` pins `three` (843 kB) and `react` (143 kB) into their own
  long-lived files — thirty phones on one Wi-Fi, and a redeploy between two classes must not
  re-download the renderer. **Sharp edge worth remembering:** Rollup parked Vite's
  `__vitePreload` helper *inside* the `three` chunk, which made the entry statically import it
  and put a `modulepreload` for 843 kB in `index.html` — the split looked done and wasn't.
  The helper now gets its own 1 kB chunk; `index.html` preloads only `react` + `preload`.
  E2E is untouched and still **14/14**: every assertion waits on `window.__world` or a testid
  that lives *inside* the lazy component, so Suspense is invisible to it.
  **Container:** root `Dockerfile`, three stages (manifest-only install layer → tsc for
  shared+server → `pnpm deploy --legacy --filter=@dino/server --prod`). `--legacy` is
  deliberate: pnpm 10's new deploy wants `inject-workspace-packages=true`. `@dino/server` grew
  a `files` list so the pruned tree is exactly `dist/ drizzle/ scripts/ node_modules/`.
  Boot is `node scripts/migrate.mjs && exec node dist/index.js` — fail-fast, and `exec` so
  node is PID 1 and still gets SIGTERM for Colyseus's graceful shutdown. **`scripts/migrate.mjs`
  is new** because `pnpm db:migrate` is drizzle-kit, a *devDependency* the prod image must not
  carry; it runs `drizzle-orm`'s own migrator over the same `drizzle/` folder and the same
  `__drizzle_migrations` table (so the two are interchangeable), over `DATABASE_URL_UNPOOLED`,
  and exits 0 with a SKIP line when there is no database at all.
  **Docker was NOT available** (client 20.10.10, daemon not running), so the image is
  unbuilt — but the thing it *contains* was validated on the host: `pnpm deploy` produced the
  pruned tree (231 prod packages, no typescript/tsx/drizzle-kit), which then migrated against
  the real Neon (`up to date in 1494ms`) and served `/healthz` **200
  `{"redis":true,"postgres":true}`** under `NODE_ENV=production`. What is unvalidated is only
  the Dockerfile's plumbing: base image, corepack, layer copies.
  **Hosts:** `render.yaml` (Docker runtime, `healthCheckPath: /healthz`, `plan: starter`
  because free instances sleep 15 min and cold-start ≈50 s = a blank projector, `autoDeploy:
  false` so only tested pushes ship) and `netlify.toml` (`base: .`, `pnpm --filter
  @dino/web... build`, the **SPA 200-rewrite** without which `/play?lobby=` 404s, and
  `immutable` caching on the content-hashed `/assets/*`). `numInstances: 1` is a *correctness*
  setting, per 5.2's note (a): rooms, the rate limiter and the texture memo are all
  per-process. Fly `fly.toml` and Vercel `vercel.json` equivalents are in the docs.
  **CI:** a `deploy` job, `needs: build-test-e2e`, `push` to `main` only, gated in-step
  (secrets can't be used in a job `if:`) on `RENDER_DEPLOY_HOOK_URL` /
  `NETLIFY_BUILD_HOOK_URL` — absent, it prints SKIP and passes. Hooks, not CLI logins: a
  leaked hook can only redeploy the branch the host already tracks. An optional
  `vars.DEPLOY_SERVER_URL` adds a best-effort `/healthz` line to the run summary.
  `.env.example` gained `HOST`, `PUBLIC_WEB_URL` and `CORS_ORIGIN` (parity with `env.ts`) plus
  the VITE-is-build-time warning; `docs/DEPLOY.md` is the human's step-by-step and points at
  `docs/DRY-RUN-CHECKLIST.md` for the venue rehearsal on deployed URLs.
  **Gate (closes Wave 5):** `pnpm build` clean · `pnpm test --force` **75/75** (shared 14,
  server 29, pipeline 32) · `pnpm e2e` **14/14**. Remaining is human-only: create the Render
  and Netlify accounts, paste the Neon/Upstash secrets, set `VITE_API_URL` then
  `PUBLIC_WEB_URL` (the two that point the halves at each other, and the two that are silently
  wrong if you skip a rebuild), add the two hook secrets, and run the dry-run checklist
  against the live URLs.
