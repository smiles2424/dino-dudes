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
- **Human checkpoint:** review this plan; fill in `.env`. ⟵ **WE ARE HERE**

### Wave 1 — Contracts & foundations  `[ ] not started` *(1 opus agent, sequential)*
Branch: `wave-1/foundations`
- [ ] pnpm workspaces + Turborepo tooling; TypeScript strict; root scripts: `dev`, `build`, `test`, `e2e`
- [ ] `packages/shared`: Zod schemas for API + Colyseus room state; **Texture Spec** constants
      (1024×1024 PNG, ArUco 4x4_50 dict, corner IDs 0–3, drawable-quad geometry)
- [ ] `apps/server`: Fastify boot + `/healthz`; Colyseus attached (empty LobbyRoom); reads `.env`
- [ ] `apps/web`: Vite React boot; renders "hello world" + server health status
- [ ] Template generator v1 in `packages/pipeline`: emits printable SVG template with markers
      (needed early so humans can print & draw while later waves run)
- [ ] GitHub Actions CI: build + test + e2e on PR
- [ ] **E2E #1 (Playwright):** web app loads, shows healthy server status
- **Gate:** `pnpm build` clean; E2E #1 green in CI. No secrets required for this wave.
- **Human checkpoint:** print a generated template, confirm it looks right on paper.

### Wave 2 — Pipeline + 3D world  `[ ] not started` *(2 opus agents, concurrent, worktrees)*
**Wave 2A — WS-A image pipeline** — branch `wave-2/pipeline`
- [ ] js-aruco2 marker detection + drawable-quad extraction (isomorphic: browser + Node)
- [ ] OpenCV.js perspective warp → canonical 1024×1024 PNG; levels cleanup
- [ ] Synthetic fixture generator: programmatically composite a "drawing" onto the template,
      apply random perspective/lighting → fixture photos (stand-ins until real phone photos land)
- [ ] **Integration test:** each fixture → texture, SSIM ≥ threshold vs golden (Node, CI)
- **Human checkpoint:** replace/augment synthetic fixtures with ~10 real phone photos of a
  filled template; re-approve goldens.

**Wave 2B — WS-C 3D world** — branch `wave-2/world`
- [ ] Low-poly dino GLB(s) with planar side-projection UV unwrap matching the Texture Spec
      (procedural/three-geometry authoring is fine for v1 if no Blender asset available)
- [ ] r3f scene: ground, sky, lighting; dinos from state; nameplates; idle/wander motion
- [ ] Runtime texture swap by URL/hash without model reload
- [ ] `/debug/world` harness page: renders scene from static JSON + local texture files;
      exposes `window.__world` (dino count, applied texture hashes) for test assertions
- [ ] **E2E #2 (Playwright):** harness loads 3 textures, `window.__world` correct, canvas
      screenshot-diff within tolerance
- **Gate (whole wave):** both modules' tests + cumulative E2E (#1, #2) green after merge of both branches.
- **Human checkpoint:** art review — does a test drawing look right on the dino?

### Wave 3 — Backend platform  `[ ] not started` *(1 opus agent)* **⚠ requires `.env` secrets**
Branch: `wave-3/backend`
- [ ] Drizzle schema + migrations on Neon (players, avatars, lobbies, lobby_members —
      SQL in docs/ARCHITECTURE.md)
- [ ] API: `POST /api/lobbies`, `GET /api/lobbies/:code`, `POST /api/avatars` (multipart),
      `GET /api/textures/:hash` (Redis cache → Postgres fallback, immutable cache headers)
- [ ] Colyseus LobbyRoom: join-code rooms, synced player map `{id, name, modelSlug,
      textureHash}`, avatar-updated broadcast wired to Redis pub/sub
- [ ] Upstash via ioredis (TCP/TLS URL): texture cache, presence
- [ ] **Integration test (@colyseus/testing):** client A joins lobby → POST fixture texture →
      client B's room state gets new hash → `GET /textures/:hash` bytes match upload
- **Gate:** integration test green against real Neon + Upstash; cumulative E2E green.

### Wave 4 — Mobile capture flow & flagship E2E  `[ ] not started` *(1 opus agent)*
Branch: `wave-4/integration`
- [ ] Capture flow: name + lobby code → pick dino → `<input capture>` photo → pipeline runs
      in-browser → preview drawing on 3D model → confirm/retake → upload → game view
- [ ] Error UX: markers not found (per-corner hints), blur warning, retake loop
- [ ] QR code encoding lobby join URL for projector screens
- [ ] **Flagship E2E (Playwright):** desktop browser A creates lobby + watches world; mobile-
      emulated browser B joins by code, pushes fixture photo through the REAL pipeline → API →
      Neon → Upstash → Colyseus; assert B's dino appears in A's `window.__world` with expected
      texture hash ≤ 5s; canvas screenshot-diff
- **Gate:** flagship E2E green in CI; full cumulative suite green.
- **Human checkpoint:** real paper-to-screen dry run with 3–5 people.

### Wave 5 — Hardening & deploy  `[ ] not started` *(optional, 1 opus agent)*
- [ ] `@colyseus/loadtest` ~50 clients in one lobby
- [ ] Deploy: server → Railway/Fly/Render; client → Vercel/Netlify; CI deploy on `main`
- [ ] Lobby lifecycle polish (idle dispose, `closed_at`), rate limiting on upload

---

## Environment & secrets

Copy `.env.example` → `.env` (gitignored) and fill in. Required from **Wave 3** onward;
Waves 1–2 run entirely without secrets.

| Variable | Used for | Where to get it |
|---|---|---|
| `DATABASE_URL` | Neon Postgres, pooled (app queries) | Neon console → connection string (pooled) |
| `DATABASE_URL_UNPOOLED` | Neon direct (Drizzle migrations) | Neon console → direct connection |
| `REDIS_URL` | Upstash Redis via TCP/TLS (`rediss://…`) — **not** the REST URL | Upstash console → Redis → "ioredis" tab |
| `SESSION_SECRET` | Signing lobby/player tokens | Generate: any 32+ char random string |

## Progress log

Append-only. Every agent adds a line when it finishes (or blocks): `date — wave/module — result — notes`.

- 2026-08-18 — Wave 0 / scaffold — done — repo initialized, plan written, awaiting human review + `.env` fill-in.
