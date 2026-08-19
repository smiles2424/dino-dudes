# Dino Dudes

Draw a dinosaur on paper, photograph it, and watch it come alive in a shared 3D world.

- **[PLAN.md](PLAN.md)** — delegation plan, wave-by-wave progress tracker, and Definition of
  Done. Start here (agents and humans alike).
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — full architecture: stack choices, data
  flows, database schema, Redis keyspace, testing strategy.
- **[docs/DEPLOY.md](docs/DEPLOY.md)** — putting it online: server container on Render, static
  client on Netlify, which secrets go where, and why it must run **one** server instance.
- **[docs/DRY-RUN-CHECKLIST.md](docs/DRY-RUN-CHECKLIST.md)** — the human rehearsal, locally or
  against the deployed URLs.

## Setup

Requires Node 22+ and pnpm 10 (`corepack enable` or `npm i -g pnpm`).

```sh
cp .env.example .env   # then fill in Neon + Upstash values (see PLAN.md table)
pnpm install
pnpm build             # builds shared → pipeline/server/web (Turborepo)
pnpm dev               # server on :2567, web on :5173
```

## Commands

| Command | What it does |
|---|---|
| `pnpm build` | Type-checks and builds every workspace package |
| `pnpm test` | Module tests (`node --test`) for shared + pipeline |
| `pnpm e2e` | Builds, then runs the cumulative Playwright suite headless |
| `pnpm e2e:only` | Playwright without rebuilding (needs a prior `pnpm build`) |
| `pnpm e2e:cleanup` | Deletes the `e2e-…`-tagged rows the browser suite leaves in Neon (Playwright runs it automatically after every suite; no-ops without `DATABASE_URL`) |
| `pnpm validate:connections` | `SELECT 1` against Neon (pooled + unpooled) and `PING` against Upstash |
| `pnpm generate-template` | Writes printable SVG + PDF templates into `assets/templates/` |

First E2E run needs a browser: `pnpm --filter @dino/e2e exec playwright install chromium`.

> Redis goes through Upstash's **REST API** (`@upstash/redis`), not `ioredis`/TCP 6379 —
> see the Progress Log in [PLAN.md](PLAN.md). All Redis access is behind
> `apps/server/src/redis.ts` so swapping clients later is a one-file change.

## Layout

```
apps/web          — React client: capture flow + 3D game view
apps/server       — Fastify API + Colyseus lobby rooms
packages/shared   — Zod contracts: API types, room state, Texture Spec
packages/pipeline — template generator, marker detection, deskew (browser + Node)
assets/           — dino models, printable templates, test fixtures, golden textures
e2e/              — cumulative Playwright suites (must always stay green)
```
