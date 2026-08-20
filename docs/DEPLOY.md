# Deploying Dino Dudes

Everything in this repo is prepared so the deploy is *paste secrets and click*. No agent has
ever had hosting credentials; the steps below are the ones only you can do.

Two pieces go up:

| Piece | What it is | Host prepared here | Config file |
| --- | --- | --- | --- |
| **Server** | Fastify + Colyseus in ONE process (REST + WebSocket on the same port) | Render, Docker runtime | `Dockerfile`, `render.yaml` |
| **Web** | A Vite static build. No server side at all | Netlify | `netlify.toml` |

Both back onto services you already have from Wave 3: **Neon** (Postgres) and **Upstash**
(Redis over REST). Nothing new to sign up for there.

---

## Read this first: run ONE server instance

The server keeps three things in process memory:

- **Colyseus rooms.** Without a Redis presence/driver, a room lives on the instance that
  created it. Two instances mean two children who typed the same lobby code can end up in
  two different worlds — the failure is invisible until the projector is missing a dino.
- **The upload rate limiter** (`rate-limit.ts`) — a token bucket per player and per IP.
  N instances multiply the effective allowance by N.
- **The texture memo** — each instance warms its own; a phone that lands on a cold one
  re-fetches.

`render.yaml` therefore sets `numInstances: 1`, and that is a correctness setting, not a
cost one. It is also plenty: the Chunk 5.2 loadtest put **50 clients in one lobby** at
p50 113 ms join and a flat **82 MB RSS**. An event is ~30 phones.

Also on `render.yaml`: `plan: starter`, not free. Free instances sleep after 15 minutes
and cold-start in roughly 50 seconds — that is the projector going blank between classes.

---

## Step 1 — Server on Render (~10 min)

1. Create a **Render** account and connect this GitHub repo.
2. **New → Blueprint**, point it at the repo. Render reads `render.yaml` and offers one
   service, `dino-dudes-server`, built from the root `Dockerfile`.
3. Render prompts for the secrets marked `sync: false`. Paste, **by name**:

   | Variable | Where it comes from |
   | --- | --- |
   | `DATABASE_URL` | Neon → Connect → **Pooled** connection string |
   | `DATABASE_URL_UNPOOLED` | Same dialog, pooling **off** (migrations only) |
   | `UPSTASH_REDIS_REST_URL` | Upstash → your DB → REST API section |
   | `UPSTASH_REDIS_REST_TOKEN` | Same section |
   | `PUBLIC_WEB_URL` | The Netlify site URL from Step 2 — you can fill a placeholder now and correct it after |
   | `AVATAR_UPLOAD_LIMIT_PER_MIN` | Leave blank (defaults to 12/min, burst 6) |
   | `LOBBY_IDLE_HOURS` | Leave blank (defaults to 12) |

   `SESSION_SECRET` is `generateValue: true` — Render mints it, you never see it.
   `PORT` is injected by Render and read by `env.PORT`; do not set it.
4. Deploy. First build is a few minutes (it compiles TypeScript and prunes to prod deps).
5. Note the service URL, e.g. `https://dino-dudes-server.onrender.com`.

**Migrations run on boot.** The container's command is
`node scripts/migrate.mjs && exec node dist/index.js` — Drizzle applies anything pending
(the journal is at `0001_split_textures_from_wearers`) over the *unpooled* URL, then the
server starts. A failed migration fails the boot on purpose: better a red deploy than a
server that 500s on the first child's upload. Re-deploys are idempotent — Drizzle's
`__drizzle_migrations` table and a Postgres advisory lock see to that.

`scripts/migrate.mjs` exists because `pnpm db:migrate` (drizzle-kit) is a *devDependency*
and the image only carries prod deps. The two are interchangeable: same folder, same
bookkeeping table.

---

## Step 2 — Web on Netlify (~5 min)

1. Create a **Netlify** account, **Add new site → Import from Git**, pick this repo.
   `netlify.toml` supplies the build command, the publish directory, the SPA rewrite and
   the caching headers. Do not override them in the UI.
2. Set **one** environment variable (Site configuration → Environment variables):

   | Variable | Value |
   | --- | --- |
   | `VITE_API_URL` | The Render URL from Step 1, e.g. `https://dino-dudes-server.onrender.com` |
   | `VITE_WS_URL` | *Optional.* Only if the WebSocket host differs from the API host — it does not here, so leave it unset |

   > **`VITE_*` variables are baked in at BUILD time.** Changing `VITE_API_URL` needs a
   > *rebuild* ("Clear cache and deploy site"), not a restart. This is the single most
   > common way to get a deployed pair that stares at each other and never connects.
3. Deploy. Note the site URL, e.g. `https://dino-dudes.netlify.app`.
4. Go back to Render and set `PUBLIC_WEB_URL` to that site URL. **This matters**: it is
   what the projector's QR code encodes, so if it is wrong every phone scans a dead link.
   Render restarts the service when you save it.

The SPA rewrite in `netlify.toml` is not optional. There is no router library — `main.tsx`
reads `window.location.pathname` — so the host must return `index.html` for every path or
`/play?lobby=ABC23` 404s. The rewrite is a `200`, not a redirect, so the query string
survives.

---

## Step 3 — CI deploys (~3 min, optional but recommended)

`.github/workflows/ci.yml` has a `deploy` job: push to `main` → build + test + e2e →
*then* trigger both hosts. That ordering is why `render.yaml` sets `autoDeploy: false`;
letting Render deploy on push as well would ship an untested build alongside a tested one.

Add these in **GitHub → Settings → Secrets and variables → Actions**:

| Name | Kind | Where to get it |
| --- | --- | --- |
| `RENDER_DEPLOY_HOOK_URL` | Secret | Render service → Settings → **Deploy Hook** |
| `NETLIFY_BUILD_HOOK_URL` | Secret | Netlify → Site configuration → Build & deploy → **Build hooks** → Add |
| `DEPLOY_SERVER_URL` | *Variable* (public) | The Render URL. Optional — enables a post-deploy `/healthz` line in the run summary |

Without those secrets the job runs, prints `Deploy SKIPPED`, and passes. A fork can never
trigger a deploy: forked PRs cannot read repository secrets, and the job only runs on a
`push` to `main` anyway.

Deploy *hooks* rather than CLI logins is deliberate — one secret URL per host, no account
credentials in CI, and the only thing a leaked hook can do is redeploy the branch the host
already tracks. Rotate by regenerating the URL.

---

## Step 4 — Smoke the deployed pair (2 min)

Replace the two URLs with yours.

```bash
API=https://dino-dudes-server.onrender.com
WEB=https://dino-dudes.netlify.app

# 1. The server is up and can see BOTH backing services.
curl -s "$API/healthz"
#    want: {"status":"ok",...,"checks":{"redis":true,"postgres":true}}
#    `redis:false` or `postgres:false` == a secret is wrong or unset.

# 2. Deep links really serve the app (this is the SPA rewrite).
curl -s -o /dev/null -w '%{http_code}\n' "$WEB/play?lobby=ABC23"   # want 200
curl -s -o /dev/null -w '%{http_code}\n' "$WEB/debug/world"        # want 200

# 3. The client was built against the right API. Open $WEB on a phone and expand
#    the "Server:" card: it must say Healthy and show YOUR API URL, not localhost.

# 4. End to end, for real: make a lobby and open the projector.
curl -s -X POST "$API/api/lobbies"       # -> {"lobby":{"code":"ABC23",...}}
#    then open  $WEB/play?lobby=ABC23    (projector)
#    and scan its QR code with a phone   (the capture flow)
```

If `/healthz` says `postgres:false`, check the Render logs for the `[migrate]` line first —
a boot that never got past migrations never started the server at all.

Then run the whole journey on the deployed URLs using
**[docs/DRY-RUN-CHECKLIST.md](./DRY-RUN-CHECKLIST.md)** — same checklist as the local dry
run, with `$WEB` in place of `localhost:5173`. That is the venue-day rehearsal, and it is
the last human checkpoint in the plan.

---

## If you would rather use Fly.io / Vercel

Both were deliberately *not* chosen (Render + Netlify need no CLI and no local Docker), but
nothing in the code is host-specific — the `Dockerfile` is a plain multi-stage build and the
web output is plain static files.

**Fly.io** instead of Render. `flyctl launch --no-deploy` from the repo root, then a
`fly.toml` along these lines:

```toml
app = "dino-dudes-server"
primary_region = "lhr"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 2567
  force_https = true
  auto_stop_machines = false   # a sleeping machine is a blank projector
  auto_start_machines = true
  min_machines_running = 1
  max_machines_running = 1     # the single-instance rule, above

  [[http_service.checks]]
    path = "/healthz"
    interval = "30s"
    timeout = "5s"
```

Secrets go in with `fly secrets set DATABASE_URL=... DATABASE_URL_UNPOOLED=... \
UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... SESSION_SECRET=... PUBLIC_WEB_URL=...`,
and CI swaps the Render hook step for `superfly/flyctl-actions` with a `FLY_API_TOKEN`.
Fly builds remotely, so you still do not need a local Docker daemon.

**Vercel** instead of Netlify. `vercel.json` at the repo root:

```json
{
  "buildCommand": "pnpm --filter @dino/web... build",
  "outputDirectory": "apps/web/dist",
  "installCommand": "pnpm install --frozen-lockfile",
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

Same `VITE_API_URL` build-time variable, same caveat about needing a rebuild.

---

## Running the container locally (optional)

Not required for any of the above — Render builds the image itself. If you have Docker
Desktop running:

```bash
docker build -t dino-dudes-server .
docker run --rm -p 2567:2567 --env-file .env -e NODE_ENV=production dino-dudes-server
curl -s localhost:2567/healthz
```

The image was **not** built during Chunk 5.3: the Docker daemon was not running on the dev
machine (`docker version` reported client 20.10.10 and no engine). What *was* verified is
the thing the image actually contains — `pnpm deploy --legacy --filter=@dino/server --prod`
was run on the host, produced the exact pruned tree (`dist/ drizzle/ scripts/
node_modules/ package.json`, 231 prod packages, no typescript/tsx/drizzle-kit), and that
tree migrated against the real Neon and served `/healthz` 200 with
`{"redis":true,"postgres":true}` under `NODE_ENV=production`. The unvalidated remainder is
the Dockerfile's own plumbing: base image, corepack, layer copies.

---

## Things worth knowing on the day

- **The QR code is `PUBLIC_WEB_URL`.** Wrong value = every phone scans a dead link. Check
  it before the room fills up.
- **One instance.** See the top of this file. If Render ever shows two, uploads are
  double-allowed and lobbies can split.
- **Free tiers sleep.** Both hosts. `plan: starter` on Render avoids it for the server;
  Netlify static hosting does not sleep.
- **Lobbies close themselves** after `LOBBY_IDLE_HOURS` (12) of silence — a lobby made in
  the morning is stale by the evening. Make a fresh one per session; it costs one `curl`.
- **The whole class shares one NAT.** That is why the per-IP upload limit is 10× the
  per-player one. If uploads start returning 429 to *everyone*, raise
  `AVATAR_UPLOAD_LIMIT_PER_MIN` — it scales both buckets.
- **A redeploy drops every connected phone.** The server shuts Colyseus down gracefully on
  SIGTERM, but clients still have to rejoin. Do not push to `main` during an event.
