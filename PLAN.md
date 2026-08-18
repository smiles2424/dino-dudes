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

### Wave 4 — Mobile capture flow & flagship E2E  `[ ] not started` *(3 opus agents, SEQUENTIAL chunks, one branch)*
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
- [ ] Flow: name + lobby code (URL-prefilled) → pick dino → `<input capture>` photo →
      `processPhoto` in-browser → preview drawing ON the 3D model → confirm/retake →
      upload → land in game view
- [ ] Error UX: per-corner marker hints from `PipelineError`, blur warning, retake loop
- [ ] **E2E #4:** capture flow with a fixture photo file through the real pipeline in-browser
      → upload → lands in game view (single browser, real server)

**Chunk 4.3 — flagship E2E** *(1 opus agent)*
- [ ] **Flagship E2E (Playwright):** desktop browser A creates lobby + watches world; mobile-
      emulated browser B joins by code, pushes fixture photo through the REAL pipeline → API →
      Neon → Upstash → Colyseus; assert B's dino appears in A's `window.__world` with expected
      texture hash ≤ 5s; canvas screenshot-diff
- [ ] Fix anything the flagship shakes out; wire it into CI (skip cleanly without secrets)
- **Gate (whole wave):** flagship E2E green; full cumulative suite green.
- **Human checkpoint:** real paper-to-screen dry run with 3–5 people.

### Wave 5 — Hardening & deploy  `[ ] not started` *(optional, 1 opus agent)*
- [ ] `@colyseus/loadtest` ~50 clients in one lobby
- [ ] Deploy: server → Railway/Fly/Render; client → Vercel/Netlify; CI deploy on `main`
- [ ] Lobby lifecycle polish (idle dispose, `closed_at`), rate limiting on upload

## Follow-up checks (validate before the event)

- [ ] **Two-client world consistency** *(raised by human 2026-08-18 after the Wave 2 art
      review)*: two browsers in the SAME lobby must see the SAME world — dino positions and
      orientations in sync. `/debug/world` drifts across instances today by design (wander is
      seeded locally and timed from each page's own load clock; the harness has no backend).
      Fix belongs in Wave 4/5: either make positions server-authoritative in room state, or
      have the server issue the motion seed + a synced clock so clients compute identical
      trajectories. Validate with an E2E: two browser contexts join one lobby, sample
      `window.__world` positions/headings at the same tick, assert equal within tolerance.

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
