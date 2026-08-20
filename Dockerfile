# syntax=docker/dockerfile:1
#
# @dino/server — the Fastify + Colyseus process.
#
# Built from the REPO ROOT (`docker build -f Dockerfile .`) because this is a
# pnpm workspace: the server imports `@dino/shared` by workspace link, and the
# lockfile `--frozen-lockfile` validates against lives there.
#
# `pnpm deploy --legacy` is deliberate: pnpm 10's new deploy wants
# `inject-workspace-packages=true`, and `--legacy` is the pnpm 9 behaviour that
# works with this workspace's isolated node_modules. The resulting tree was
# verified outside Docker — migrate, serve, `/healthz` 200 — see docs/DEPLOY.md.

# ── base ──────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# Corepack reads `packageManager` from the root package.json, so the image uses
# the exact pnpm the lockfile was written with.
RUN corepack enable
WORKDIR /repo

# ── deps ──────────────────────────────────────────────────────────────────────
FROM base AS deps
# `--frozen-lockfile` validates the lockfile against EVERY workspace manifest,
# so all of them have to be here even though only the server gets installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY packages/pipeline/package.json packages/pipeline/
COPY e2e/package.json e2e/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@dino/server..."

# ── build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/server apps/server
RUN pnpm --filter @dino/shared build \
 && pnpm --filter @dino/server build
# Prunes to prod deps and copies only what @dino/server's `files` lists:
# dist/ (the build), drizzle/ (the migrations), scripts/ (the migrator).
RUN pnpm deploy --legacy --filter=@dino/server --prod /prod/server

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=2567
WORKDIR /app
COPY --from=build --chown=node:node /prod/server ./
USER node
EXPOSE 2567

# Node 22 has global fetch, so this needs no curl in the image. `/healthz`
# answers 200 whenever the process is serving and reports Postgres/Redis
# reachability in the body rather than failing — what you want from a LIVENESS
# check, since a blip at Neon must not make the platform kill a room full of
# connected clients.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `exec` so node becomes PID 1 and receives SIGTERM — index.ts shuts Colyseus
# down gracefully on it, which is what stops a redeploy dropping every phone.
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node dist/index.js"]
