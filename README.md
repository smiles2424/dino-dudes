# Dino Dudes

Draw a dinosaur on paper, photograph it, and watch it come alive in a shared 3D world.

- **[PLAN.md](PLAN.md)** — delegation plan, wave-by-wave progress tracker, and Definition of
  Done. Start here (agents and humans alike).
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — full architecture: stack choices, data
  flows, database schema, Redis keyspace, testing strategy.

## Setup

```sh
cp .env.example .env   # then fill in Neon + Upstash values (see PLAN.md table)
pnpm install           # available after Wave 1 lands
```

## Layout

```
apps/web          — React client: capture flow + 3D game view
apps/server       — Fastify API + Colyseus lobby rooms
packages/shared   — Zod contracts: API types, room state, Texture Spec
packages/pipeline — template generator, marker detection, deskew (browser + Node)
assets/           — dino models, printable templates, test fixtures, golden textures
e2e/              — cumulative Playwright suites (must always stay green)
```
