# DEPLOY.md — Fly.io Deploy Readiness

> **Last refreshed:** 2026-04-19 (post T6-04 four-surface smoke)
> **Target surface:** `jellyclaw-prod` + `jellyclaw-staging` on Fly.io
> **Status:** Not deploy-ready. Plumbing is in; 5 blockers + a 1-day punch
> list stand between us and `flyctl deploy --app jellyclaw-prod`.

---

## What exists today (landed commits on `main`)

- **`Dockerfile`** — three-stage build, base `mcr.microsoft.com/playwright:v1.58.2-jammy`, ships ttyd + Caddy + `jellyclaw serve` in one container. Non-root `pwuser`. tini PID 1. Entrypoint: `scripts/container-entrypoint.sh`.
- **`fly.toml`** — app `jellyclaw-prod`, region `iad`, `shared-cpu-2x@1GB`, `min_machines_running = 2`, `auto_stop_machines = "off"`, 10 GiB volume `jellyclaw_data` at `/data`, `/v1/health` check, strategy `rolling`.
- **`Caddyfile`** — front-door: `/` → `/srv/site` static, `/api/*` → `localhost:8080`, `/tui` → `localhost:7681` (ttyd).
- **`web-tui/Dockerfile.ttyd`** + **`web-tui/ttyd-args.sh`** — ttyd wrapper that hands off to `jellyclaw tui`.
- **`site/`** — landing page (index.html, css, js, assets, asciinema vendor drop, robots.txt, sitemap.xml).
- **`scripts/container-entrypoint.sh`** — forks Caddy + jellyclaw-serve + ttyd.
- **`scripts/deploy-fly.sh`** — local developer wrapper around `flyctl deploy`.
- **`.github/workflows/fly-deploy.yml` + `fly-staging.yml`** — push-to-main → staging; tag → prod.
- **`docs/hosting/01..05-*.md`** — agent-authored deployment design docs (mechanics, public API, TUI distribution, browser-in-cloud, productization).
- **`docs/deploy-secrets.md`** — `fly secrets set` recipe for `ANTHROPIC_API_KEY`, `JELLYCLAW_TOKEN`, `OPENROUTER_API_KEY`, `EXA_API_KEY`, `BROWSERBASE_API_KEY`.

Engine side:
- `engine/src/server/auth/` — bearer + composite + multi-tenant provider.
- `engine/src/server/routes/tui-handoff` — mints scoped tokens for ttyd→TUI.
- `engine/src/db/sqlite-better.ts` + `sqlite-bun.ts` — dual drivers (phase-08 T5-04).
- T6-04 four-surface smoke reported 4/4 PASS against real Anthropic on 2026-04-19; 2115 tests green (up from 1302 baseline).

---

## Blockers — none of these are optional before `flyctl deploy`

1. **Engine is not yet bootable under `jellyclaw serve` on Fly's Node 20 runtime.** Status: `Engine on: n/a (not yet bootable)` per `STATUS.md`. The T6-04 surface smoke verified `jellyclaw run` + `jellyclaw tui` against a real key, but `jellyclaw serve` behind `min_machines_running=2` has not been exercised end-to-end against the multi-tenant auth seam that landed in phase 08 T5-03. Fix: run `scripts/run-web-tui-e2e.sh` inside the container locally (`docker run --rm -e ANTHROPIC_API_KEY=… ghcr.io/gtrush03/jellyclaw:latest`) and confirm `/v1/sessions` + `/v1/events` SSE stays stable for ≥60 s. **Gate.**

2. **Phase 99 unfucking is 5/8 done.** STATUS explicitly parks Phase 11 behind Phase 99. The 3 remaining prompts (see `phases/PHASE-99-unfucking.md`) include the session-restoration path that lets a crashed Machine resume in-flight runs. Without that, rolling deploys drop active SSE streams. Fix: finish T6-T8 of phase-99. **Gate for `auto_start_machines = true` with a rolling strategy.**

3. **Phase 08-hosting T7 (vision + image-gen + skill upgrades) is queued but unlanded.** T7-01..T7-05 prompts are committed under `prompts/phase-08-hosting/` but have not run through the autobuild rig. These touch the tool surface the container exposes — shipping without them means the deployed engine advertises tools the image can't actually serve. Fix: run T7 autobuild before `fly deploy`. **Gate for tool-count correctness.**

4. **Secrets management is a manual-only story.** Fly secrets are set via `fly secrets set` per `docs/deploy-secrets.md`, but there is no secret-rotation play, no per-tenant `JELLYCLAW_TOKEN` issuance, no audit trail. Fix: wire `scripts/deploy-fly.sh` to read from 1Password CLI for the developer path and document a rotation runbook in `docs/hosting/05-productization.md`. **Gate for any external user.**

5. **No staging soak.** `fly-staging.yml` exists but no staging app has been provisioned and no staging smoke has run against a Machine that's been up for >1 h. SQLite + Chrome in the same 1 GiB VM is the classic place this dies with OOM under the Playwright base image. Fix: `fly apps create jellyclaw-staging`, deploy once, leave it up for 24 h with a synthetic every-5-min `jellyclaw run` load, watch `fly logs` for OOM + `memory.current` via `fly machine status`. **Gate for `jellyclaw-prod`.**

---

## 1-day punch list (once the blockers clear)

**Pre-flight (local, ~30 min)**

```bash
# Build + typecheck + tests must be green
bun install
bun run build
bun run typecheck
bun run test

# Build the container locally and smoke it
docker build -t jellyclaw:local .
docker run --rm -p 8080:8080 -p 7681:7681 -p 80:80 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e JELLYCLAW_TOKEN=$(openssl rand -hex 32) \
  jellyclaw:local
# → curl http://localhost/v1/health must return {ok:true,...}
# → open http://localhost → landing page renders
# → open http://localhost/tui → ttyd drops you into jellyclaw tui
```

**Provision (~45 min, idempotent after first run)**

```bash
# Install flyctl if needed
brew install flyctl
flyctl auth login

# Staging first — always
flyctl apps create jellyclaw-staging --org personal
flyctl volumes create jellyclaw_data --region iad --size 10 \
  --app jellyclaw-staging
flyctl secrets set \
  ANTHROPIC_API_KEY="sk-ant-..." \
  JELLYCLAW_TOKEN="$(openssl rand -hex 32)" \
  OPENROUTER_API_KEY="sk-or-..." \
  EXA_API_KEY="..." \
  BROWSERBASE_API_KEY="..." \
  --app jellyclaw-staging

# Prod — same block, different app + fresh token
flyctl apps create jellyclaw-prod --org personal
flyctl volumes create jellyclaw_data --region iad --size 10 \
  --app jellyclaw-prod
flyctl secrets set ANTHROPIC_API_KEY=... JELLYCLAW_TOKEN=... ... \
  --app jellyclaw-prod
```

**Deploy (~20 min first time, <5 min subsequent)**

```bash
# Staging deploy — must pass before touching prod
flyctl deploy --app jellyclaw-staging --strategy rolling \
  --wait-timeout 5m

# Smoke the staging deploy
export JELLYCLAW_URL="https://jellyclaw-staging.fly.dev"
export JELLYCLAW_TOKEN="$(flyctl secrets list --app jellyclaw-staging ...)"
curl -H "Authorization: Bearer $JELLYCLAW_TOKEN" $JELLYCLAW_URL/v1/health
# → must return {ok:true,...}

# Run the full web-tui e2e suite against staging
JELLYCLAW_URL=$JELLYCLAW_URL JELLYCLAW_TOKEN=$JELLYCLAW_TOKEN \
  scripts/run-web-tui-e2e.sh
# → must be green

# Leave staging running under synthetic load for 1 h minimum, check:
#   fly logs --app jellyclaw-staging
#   fly machine status --app jellyclaw-staging
# Look for: no restarts, memory < 800 MiB steady-state, no OOM.

# Only now: prod
flyctl deploy --app jellyclaw-prod --strategy rolling \
  --wait-timeout 5m
# Then re-smoke against jellyclaw-prod.fly.dev.
```

**Post-deploy (~15 min)**

```bash
# Sanity
curl -sSf https://jellyclaw-prod.fly.dev/v1/health | jq
flyctl status --app jellyclaw-prod

# Watch the first 24 h
flyctl logs --app jellyclaw-prod | tee /tmp/jellyclaw-first-day.log
```

---

## What this doc is not

- Not a Fly intro — see `docs/hosting/01-fly-deployment.md` for the full deployment-mechanics design doc.
- Not a public-API contract — see `docs/hosting/02-public-api-design.md`.
- Not a productization plan — see `docs/hosting/05-productization.md`.
- Not a promise the deploy will work — see the 5 blockers.

---

## Resume

When a fresh session picks this up:

```
claude --resume e6b2db12-f6fc-4a55-a38c-4fa620e8a609
```
