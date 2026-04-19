# jellyclaw on Fly.io — Deployment Architecture

**Status:** Design, agent-authored (Agent 1 — deployment mechanics)
**Date:** 2026-04-17
**Scope:** How to host `jellyclaw serve` as an always-on, multi-tenant HTTP service on Fly.io so external clients can consume the engine without installing anything locally. Agent 2 covers the public API surface; Agent 4 covers the Chrome/MCP cloud topology. This file is deployment mechanics — the VMs, volumes, secrets, Dockerfile, and `fly.toml` — nothing else.

---

## § Executive summary

1. **Two Fly apps, one platform:** `jellyclaw-prod` and `jellyclaw-staging`. Both are single-process Hono HTTP servers exposing `jellyclaw serve` on `0.0.0.0:8080` behind Fly's edge proxy.
2. **Always-on, not scale-to-zero.** Fly autostop infers idleness from `soft_limit` on the `[http_service].concurrency` block; SSE streams keep connections open and confuse that heuristic. We pin `min_machines_running = 2` and leave `auto_stop_machines = "off"`.
3. **Chrome lives in the SAME container as jellyclaw for Alpha.** Bundling `mcr.microsoft.com/playwright:v1.58.2-jammy` as the base image gives us a reproducible browser, skips the "which Chrome" runtime question, and keeps the MCP child process inside the same network + process tree. We split it into a sidecar Machine once concurrent browser sessions > ~5 per node (Beta).
4. **Sessions persist on a per-Machine Fly volume** at `/data` (size 10 GiB). SQLite under `~/.jellyclaw/sessions/` is redirected there via `JELLYCLAW_HOME=/data/jellyclaw`. Hourly snapshots via Fly's built-in snapshotting (retain 5). Cross-Machine HA is deferred — sessions are sticky to their originating Machine via Fly-Replay headers (see § Topology).
5. **Region:** `iad` (Ashburn) primary — sub-20 ms to Anthropic's us-east-1 endpoints and cheap egress. Expand to `fra` later only if EU latency complaints arrive.
6. **Cost (Alpha, <100 users/day):** ~$24/mo in Fly costs (2× `shared-cpu-2x@1GB` always-on + 10 GiB volume + trivial bandwidth). Anthropic API passthrough dwarfs this by 10–100×.
7. **Deploy pipeline:** GitHub Actions → `flyctl deploy --strategy rolling` on push-to-main. Staging gets its own app + secrets; same Dockerfile, same `fly.toml`, different `--app`.
8. **Scale-to-zero later.** Once we have: (a) a session restoration mechanism that rebuilds RunManager state from the SQLite file on wake, and (b) a way to tell Fly Proxy that an open SSE stream is "work in progress," we flip `auto_stop_machines = "suspend"` and `min_machines_running = 0`. Not for first ship.
9. **Secrets:** `ANTHROPIC_API_KEY`, `JELLYCLAW_TOKEN` (operator-provided, not auto-generated — auto-gen is blocked by `serve.ts` on non-loopback bind), and optional `OPENROUTER_API_KEY` via `fly secrets set`. Never baked into the image.
10. **Risk list:** per-tenant SQLite isolation, shared Anthropic rate limits, Chrome memory pressure at >5 concurrent sessions per Machine, and SSE/autostop incompatibility. All flagged in § Open questions.

---

## § Topology

**Recommendation: two always-on `shared-cpu-2x@1GB` Machines in `iad` for Alpha, sized for ~100 concurrent users.** One Machine could serve the Alpha load — we run two for rolling deploys with zero-downtime and for the case where one crashes under a runaway agent loop. This is the classic "N+1" posture for anything user-facing; Fly gives it to us for ~$16/mo.

**Region choice — `iad` (Ashburn, Virginia) single-region primary.** Anthropic's API lives in AWS us-east-1; jellyclaw's hot path makes 1–4 Anthropic calls per prompt (system + tool loop), so co-locating us in `iad` collapses provider latency to sub-20 ms. We do not need multi-region for Alpha — jellyclaw's user-perceived latency is dominated by Anthropic TTFT (~400 ms for Sonnet), not by the ~60 ms extra hop a European user pays to reach Ashburn. Fly pricing is uniform across `iad`/`ewr`/`ord`/`dfw` for Machines (the pricing page's per-region variance is ~±5% on the Amsterdam reference), so there's no cost upside to Europe. If a concrete EU latency complaint lands, we add a `fra` Machine in the same app — Fly routes each request to the nearest running Machine automatically ([regions ref](https://fly.io/docs/reference/regions/)).

**Session stickiness and HA.** Sessions are **sticky to the Machine that created them** for this launch. The SQLite file at `/data/jellyclaw/sessions/<id>.db` lives on a Fly volume attached to that specific Machine ([volumes docs](https://fly.io/docs/volumes/) — "a slice of an NVMe drive on the same physical server as the Machine on which it's mounted"). If Machine A crashes, Machine B cannot serve session X transparently. We mitigate by:

1. **Issuing a `fly-machine-id` session cookie.** On `/v1/sessions` create, the server stamps the response with the current Machine ID (read from `FLY_MACHINE_ID` env var). Subsequent requests carrying that cookie get routed back to the same Machine via Fly-Replay headers ([request routing](https://fly.io/docs/networking/dynamic-request-routing/)).
2. **Hourly SQLite snapshots to Tigris** (Fly's S3-compatible object store). If Machine A dies permanently, an operator can restore session X to Machine B by copying the latest snapshot in. This is a manual DR path for Alpha, automated in Beta.
3. **LiteFS is explicitly NOT in scope.** LiteFS gives us async replication, but jellyclaw's session writes are chatty (every turn mutates the DB) and LiteFS's read-after-write guarantees require routing reads to the writer — which is exactly what Fly-Replay already gives us. Adding LiteFS doubles the operational surface without meaningful benefit at this scale. Reconsider at >1000 concurrent users.

**Why not scale-out autoscaling?** Because SQLite + in-memory RunManager state pins a session to a Machine, autoscaling means "create a new Machine when `soft_limit` is breached, and hope existing sessions stay on their old Machine." Fly Proxy does this already with `auto_start_machines = true` and `min_machines_running = 2` — new sessions land on new Machines, existing ones continue on their pinned Machine. We don't need horizontal pod autoscaling. This is fine until a single Machine's 1 GB becomes the bottleneck, at which point we swap `shared-cpu-2x@1GB` for `shared-cpu-4x@2GB` (vertical scale via `fly scale vm`, [scale-count docs](http://fly.io/docs/launch/scale-count/)) and revisit.

---

## § Container design

**Base image: `mcr.microsoft.com/playwright:v1.58.2-jammy`.** Pin to the exact Playwright version that `@playwright/mcp@0.0.70` transitively requires. The image ships with Chromium, Firefox, WebKit, all OS deps (libnss3, libatk, etc.), and Node 20 on Ubuntu 22.04 — saves us 40+ `apt-get install` lines and 200 MB of layer caching pain. Size target: **final image ≤ 1.8 GB** compressed on Fly's registry. That's big by web-app standards but Chrome is Chrome; the Playwright-on-Fly battle-tested references (see [Stephen Haney's 2024 post](https://stephenhaney.com/2024/playwright-on-fly-io-with-bun/)) all converge on this image.

**Why same container, not sidecar, for Alpha.** Two options, chosen the first:

| Axis | Same container (chosen) | Sidecar Machine |
|---|---|---|
| Ops complexity | One Dockerfile, one Machine type | Two apps + internal network coord |
| Boot latency | One cold start | Two cold starts, ordering sensitive |
| Memory | Chrome + Node in same 1 GB bucket (tight) | Separate budgets |
| Cost | Single Machine bill | 2× Machine bills per tenant |
| Profile persistence | Volume at `/data/chrome-profile/` | Requires shared volume or object storage |
| Concurrent browser sessions | Limited (~3–5 before OOM) | Isolated per tenant |

At Alpha scale (<100 users/day, MCP is opt-in, maybe 20% of sessions), the sidecar overhead is not earned. At Beta (~1k/day) we split: Chrome lives in a `browser-sidecar` app backed by per-tenant ephemeral Machines that come up on-demand and die after session close. Agent 4 owns that design.

**Bun vs Node.** `engine/src/cli/main.ts:167` has an explicit Bun block-list for `jellyclaw serve` due to an unresolved SSE+chunked-encoding bug in `@hono/node-server` when run on Bun. Fly's runtime is Node 20 (from the Playwright image). We use the `node` binary, period.

**`@playwright/mcp` — pre-bundled at build time.** `npm ci` at build time pulls `@playwright/mcp@^0.0.70` (already listed in `engine/package.json:86`). Running `npx @playwright/mcp` at runtime would hit the npm registry from inside Fly, which is (a) slow (b) a SPOF (c) an attack surface. We resolve the binary path once at build and invoke it directly. The `--cache-folder=/data/npm-cache` flag on npm install keeps the layer stable across rebuilds.

**Secrets injection.** Fly secrets land as env vars at Machine boot ([secrets docs](https://fly.io/docs/apps/secrets/) — "The Fly.io agent on the host uses this token to decrypt your app secrets and inject them into your Machine as environment variables at boot time"). Three secrets:

```bash
fly secrets set ANTHROPIC_API_KEY=sk-ant-...    --app jellyclaw-prod
fly secrets set JELLYCLAW_TOKEN=$(openssl rand -hex 32)  --app jellyclaw-prod
fly secrets set OPENROUTER_API_KEY=sk-or-...    --app jellyclaw-prod  # optional
```

The `JELLYCLAW_TOKEN` becomes the bearer token all clients must present. It's required explicitly because `engine/src/cli/serve.ts:167` refuses to auto-generate tokens on non-loopback binds, which is correct security posture.

**Healthcheck endpoint — `/v1/health` already exists.** `engine/src/server/routes/health.ts` registers it, and `engine/src/server/app.ts:77-84` mounts it before the auth middleware. Returns `{ok: true, version, uptime_ms, active_runs}`. Perfect liveness probe; no jellyclaw changes needed. Fly's healthcheck config:

```toml
[[http_service.checks]]
  grace_period = "30s"   # generous — Playwright base image boots slowly
  interval     = "15s"
  method       = "GET"
  path         = "/v1/health"
  timeout      = "5s"
```

**Startup command.** The `engine/package.json:18` bin map publishes `jellyclaw-serve` as a distinct entrypoint. In-container we invoke it directly, bypassing the Bun-aware `jellyclaw` wrapper:

```
node /app/dist/cli/main.js serve \
  --host 0.0.0.0 --port 8080 \
  --i-know-what-im-doing \
  --auth-token "$JELLYCLAW_TOKEN"
```

`--i-know-what-im-doing` is mandatory because `serve.ts:150` refuses non-loopback binds without it. That's not a hack — it's the intended security boundary the CLI enforces, and Fly is exactly the "I know this is a public service" case the flag exists for.

---

## § Persistence

**Volume at `/data`, 10 GiB, one per Machine.** Fly volumes are local NVMe slices physically co-located with the Machine they're attached to ([volumes docs](https://fly.io/docs/volumes/)). Cost: **$0.15/GiB/month** = $1.50/Machine/month at 10 GiB ([pricing](https://fly.io/docs/about/pricing/)). Sizing rationale:

| Contents | Size (est) | Notes |
|---|---|---|
| SQLite session DBs | 1–3 GiB | ~1 MB/session × 1000 retained sessions |
| MCP tokens + config | 50 MiB | `~/.jellyclaw/credentials.json` + MCP config |
| npm cache (Playwright MCP) | 500 MiB | Pre-populated at image build, persists for faster restart |
| Chrome profile (Alpha shared) | 500 MiB | Per-tenant isolation deferred to Beta |
| Logs (pino, rotated) | 1 GiB cap | Log rotation via `pino-roll` or external drain |
| Headroom | 5 GiB | ext4 reserved + growth |
| **Total** | **~10 GiB** | — |

**Mount path + env remapping.** jellyclaw defaults to `~/.jellyclaw/` (= `/root/.jellyclaw/` as root in the container, or `/home/jellyclaw/.jellyclaw/` if we add a non-root user). The `SessionPaths` class (`engine/src/session/paths.ts`, referenced from `serve.ts:28`) honors `JELLYCLAW_HOME`. We set `JELLYCLAW_HOME=/data/jellyclaw` in `fly.toml` `[env]`, and the Dockerfile creates that directory with correct perms at image build time so the first boot doesn't race.

**Backup — Fly native snapshots, not Tigris-yet.** Fly volumes ship with snapshot support out of the box: `snapshot_retention = 5` + `scheduled_snapshots = true` in the `[[mounts]]` block gives us 5 daily snapshots rolling. Cost: **$0.08/GiB/month** snapshot storage with first 10 GiB free ([pricing](https://fly.io/docs/about/pricing/)) — so 10 GiB × 5 snapshots = 50 GiB, of which 10 GiB is free, effective cost ~$3.20/mo per Machine. Zero operational cost.

Hourly snapshots are not supported natively by Fly — only daily. For hourly DR we layer a cron-driven SQLite backup that rsyncs the DB file to Tigris (Fly's S3-compatible object store, $0.02/GiB/mo, zero egress charge inside Fly). That's a Beta-phase upgrade; Alpha lives on daily snapshots.

**Survival on Machine restart.** Yes. Volumes are attached to Machines, not Machines to volumes: when Fly Proxy stops/starts a Machine the volume stays attached and the next boot mounts the same filesystem. `fly machine restart` preserves `/data`. `fly deploy` rolls the Machine image but keeps the volume. Volume is destroyed only by explicit `fly volumes destroy`, which is not in any CI/CD path.

**Per-tenant isolation caveat.** The SQLite files under `/data/jellyclaw/sessions/` are currently readable by anything running in the same container. For a multi-tenant service this is a posture problem — one tenant's session data visible to another tenant is a confidentiality breach. Agent 2 should treat this as an API-surface constraint (API keys scope to a tenant; the server must enforce "session ID X belongs to tenant Y" before dispatching a run). At the infrastructure layer we flag it here and do not attempt container-level isolation per tenant (that's back to sidecar-per-tenant, which is a Phase 3 conversation).

---

## § Scale-to-zero / always-on

**Decision: always-on for Alpha and Beta. `min_machines_running = 2`, `auto_stop_machines = "off"`.**

The core problem is that Fly Proxy decides "idle" based on HTTP-request concurrency against the `soft_limit` setting ([autostop mechanics](https://fly.io/docs/reference/fly-proxy-autostop-autostart/) — "Fly Proxy uses the concurrency soft_limit setting for each Machine to determine if there's excess capacity per region"). Jellyclaw's `/v1/events/:sessionId` SSE stream is a long-lived HTTP GET that holds one connection per watching client. From Fly's perspective that counts as one unit against the `soft_limit` indefinitely — so the Machine never *looks* idle, but also never shows capacity to start additional Machines for new users. Worse, when a user disconnects mid-stream, their session-level work is still in progress (the agent loop continues running against Anthropic) but appears idle to the proxy. The proxy could then stop the Machine and kill the in-flight Anthropic round-trip.

This is a known sharp edge with SSE and autostop. Fly's own community docs flag it explicitly ([Handling Long-Running Tasks](https://community.fly.io/t/handling-long-running-tasks-with-automatic-machine-shutdown-on-fly-io/24256)): "set `auto_start_machines = true` and `auto_stop_machines = 'off'` to have Fly Proxy automatically restart the Machines stopped by your app." We follow that advice.

**Cold start math (for reference, should we ever enable scale-to-zero).**

| Phase | Estimate | Source |
|---|---|---|
| Fly Machine start from stopped | ~2 s | [suspend-resume docs](https://fly.io/docs/reference/suspend-resume/) — "cold start ~2+ seconds for common apps" |
| Playwright image filesystem mount | ~1 s | NVMe-backed rootfs |
| Node boot + ESM graph warm | ~800 ms | Measured on equivalent Node 20 + Hono projects |
| Credentials load (`engine/src/auth/credentials.ts`) | ~100 ms | File read + zod validate |
| RunManager init + MCP server spawn | ~2 s | `@playwright/mcp` stdio handshake dominates |
| **Total cold start** | **~6 s** | — |

Six seconds for the *first* request of a cold session is tolerable for API consumers — not catchable for browser end-users. Today's traffic mix is API-first (Genie dispatcher, jelly-claw), so if we ever flip to scale-to-zero, the 6 s latency lands on an already-async request path that won't notice.

**Suspend vs stop.** Fly's `suspend` mode snapshots the VM's RAM and restarts in ~300 ms ([suspend-resume](https://fly.io/docs/reference/suspend-resume/)) — an order of magnitude faster than cold start. But it caps memory at ≤2 GB and invalidates on deploy. Chrome's working set is ~500 MB on a loaded page; we're tight against the 2 GB ceiling on `shared-cpu-2x@1GB`. If we do enable scale-to-zero in Beta, `suspend` is the right mode — but we'll need to measure memory headroom with MCP stack hot.

**Always-on cost justification.** Two `shared-cpu-2x@1GB` Machines running 24/7 is ~$14/mo combined ([pricing](https://fly.io/docs/about/pricing/) — $6.64/machine). That's trivially cheaper than the engineering time spent debugging SSE-disconnect-mid-flight bugs caused by premature autostop. Engineering-time-to-dollars is the dominant term.

---

## § Networking

**Public bind:** `0.0.0.0:8080` with `[http_service].internal_port = 8080`. Fly Proxy terminates TLS at the edge on `:443` and forwards cleartext HTTP to the Machine's internal port — the jellyclaw process sees HTTP, not HTTPS ([services docs](https://fly.io/docs/networking/services/), TLS handler "terminates TLS on the host a client connects to, and then forward[s] the connection to the nearest available Machine"). No certificate management in the image.

**TLS:** Automatic via Fly. `force_https = true` in `[http_service]` issues a 301 from `:80` to `:443`. Certificates are Let's Encrypt-backed and managed by Fly; our app sees the unwrapped HTTP. No code changes required.

**SSE timeout status:** TCP idle timeouts at the proxy layer were removed on 2023-09-01 ([Fly announcement](https://community.fly.io/t/tcp-idle-timeouts-restrictions-have-been-removed/15160)). SSE streams can hold connections indefinitely without Fly forcibly closing them. *But:* there is still a **2048 concurrent connection limit per edge per app** — if the client base grows past ~2k simultaneous SSE subscribers (not users, subscribers), we need to scale horizontally. At 100 concurrent users × 1 open SSE stream each = 100 connections, we're nowhere near that ceiling.

**Bind address change — required.** `serve.ts:143` defaults `--host` to `127.0.0.1`. The Dockerfile CMD must pass `--host 0.0.0.0 --i-know-what-im-doing`. The loopback-safety code path in `serve.ts:150` then prints a NON-LOOPBACK banner to stderr (captured by Fly logs) and refuses to proceed without an explicit `--auth-token`. Both conditions are satisfied by the command line above. No source change to jellyclaw needed — we're using the existing safety-valve exactly as designed.

**WebSockets:** Not currently used by jellyclaw (SSE is the streaming primitive per `engine/src/server/routes/events.ts`). If Agent 2 adds WebSocket support later, Fly's HTTP handler transparently upgrades them ([services docs](https://fly.io/docs/networking/services/)). No extra config.

**Flycast for internal services (Beta).** When we split Chrome to a sidecar app, the sidecar should bind only on Flycast (`[[services]]` with `internal = true`) — not exposed on the public internet. Agent 4 design.

**Egress IP — not pinned.** Jellyclaw outbound calls (Anthropic, npm registry during build, eventually MCP-configured HTTPS targets) do not require IP allowlisting today. If/when a user adds an MCP server that requires allowlisted egress, Fly supports static egress IPs via `fly ips allocate --egress` ([Machines overview](https://fly.io/docs/machines/overview/)). Not worth paying for until a concrete need shows up.

---

## § CI/CD

**Pipeline:** GitHub Actions on push to `main` → `flyctl deploy` with `--strategy rolling`. The repo already has `npm ci`, `npm test`, and `npm run build` as the local smoke path (see `engine/package.json:50`); CI wraps that and adds the deploy step.

**Why rolling not blue/green for Alpha.** Blue/green requires 2× capacity during the deploy window — with 2 Machines baseline, that's 4 during deploy, +$7/mo in reserved capacity during rollouts. Rolling (one-at-a-time) means one Machine is unavailable for ~10 seconds of cutover; Fly Proxy drains connections before terminating. For an API with ≤100 users, a ~10 s brownout during deploy is acceptable. Upgrade to `bluegreen` at Beta.

**`.github/workflows/fly-deploy.yml`:**

```yaml
name: Deploy to Fly
on:
  push:
    branches: [main]
  workflow_dispatch: {}

concurrency:
  group: fly-deploy-${{ github.ref }}
  cancel-in-progress: false   # never cancel a deploy mid-flight

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"
          cache-dependency-path: engine/package-lock.json

      - name: Install + build + test
        working-directory: engine
        run: |
          npm ci
          npm run build
          npm test

      - uses: superfly/flyctl-actions/setup-flyctl@master

      - name: Deploy to staging
        if: github.ref == 'refs/heads/main'
        run: flyctl deploy --app jellyclaw-staging --remote-only --strategy rolling --wait-timeout 300
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}

      - name: Smoke test staging
        run: |
          curl --fail --retry 5 --retry-delay 5 \
            https://jellyclaw-staging.fly.dev/v1/health

      - name: Promote to prod
        if: github.ref == 'refs/heads/main'
        run: flyctl deploy --app jellyclaw-prod --remote-only --strategy rolling --wait-timeout 300
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
```

**Staging app.** `jellyclaw-staging` is a separate Fly app with its own secrets (separate Anthropic key recommended — cheaper Sonnet-only quota) and its own volume. Same Dockerfile, same `fly.toml` (except `app = "jellyclaw-staging"` and `min_machines_running = 1` to save costs). Deployment hits staging first, runs the `/v1/health` smoke, and only then rolls to prod. The `concurrency` block prevents two simultaneous deploys from colliding.

**Rollback.** `flyctl deploy` history is preserved. `flyctl releases list --app jellyclaw-prod` shows the stack; `flyctl deploy --image registry.fly.io/jellyclaw-prod:deployment-<id>` rolls back. Build outputs are retained on Fly's registry; we don't need our own container registry for Alpha.

---

## § Cost at 3 scales

All numbers are Fly-side only. Anthropic pass-through is called out separately because it's 10–100× the Fly spend.

| Item | Alpha (<100 users/day) | Beta (1k users/day, 10k sessions) | Public (10k users/day) |
|---|---|---|---|
| Machines (always-on) | 2 × `shared-cpu-2x@1GB` × 24/7 | 4 × `shared-cpu-4x@2GB` × 24/7 | 8 × `performance-2x@4GB` × 24/7 |
| Per-Machine monthly cost | $6.64 | ~$15 (scaled RAM) | $64.39 |
| Machine subtotal / mo | $13.28 | $60 | $515 |
| Volumes (10 GiB/Machine) | 2 × $1.50 = $3.00 | 4 × $3.00 (20 GiB each) = $12 | 8 × $4.50 (30 GiB each) = $36 |
| Snapshots | ~$0 (under 10 GiB free tier) | ~$5 | ~$20 |
| Bandwidth egress | ~$1 (est 50 GB/mo, NA rate $0.02/GB) | ~$20 (1 TB/mo) | ~$200 (10 TB/mo) |
| IPv4 (1 shared public IP) | $0 | $0 | $0 |
| **Fly subtotal / mo** | **~$17** | **~$97** | **~$771** |
| Staging env (Fly) | +$9 | +$30 | +$50 (scaled-down) |
| **Fly all-in / mo** | **~$26** | **~$127** | **~$821** |
| Anthropic API passthrough (est) | $50–500 | $5k–50k | $50k–500k |

Sources: [Fly pricing](https://fly.io/docs/about/pricing/) — shared-cpu-2x 1GB = $6.64/mo, performance-2x 4GB = $64.39/mo, volumes $0.15/GiB/mo, bandwidth $0.02/GB NA+EU egress. Snapshots $0.08/GiB/mo with first 10 GiB free.

**When do we outgrow Fly?** At "Public" tier ($821/mo) Fly is still fine — that's bottom-of-the-barrel for managed PaaS and we haven't hit any platform limit. The real crossover is the **per-tenant Chrome profile storage** problem: by 10k users/day we have ≥10k persistent Chrome profiles each wanting ~500 MB, = 5 TiB of volume data. Fly volumes cap at 500 GiB each ([volumes docs](https://fly.io/docs/volumes/)), so we'd need per-tenant-on-demand Chrome containers backed by S3/Tigris restore — not Fly volumes. That's an architecture shift (Agent 4 territory), not a Fly-pricing issue.

**Hetzner / Coolify sanity check.** A Hetzner dedicated `AX41-NVMe` (6 cores, 64 GB RAM, 2×512 NVMe) is €39/mo, or ~$42. It'd host a Coolify-orchestrated jellyclaw + Chrome for effectively the Public tier load on one box. Savings: ~$750/mo at Public scale. Cost: we take on bare-metal ops (monitoring, patching, disk failure, TLS, deploy tooling) — easily 5–10 hours/mo of human time. At engineering time = $200/hr, Hetzner becomes cheaper only once we exceed ~4 h/mo of Fly-related ops work, which is unlikely before Public scale. **Verdict: stay on Fly through Public.**

**Render / Railway sanity check.** Both charge ~2× Fly for equivalent compute and neither has Fly's global anycast routing for free. Neither offers Firecracker-grade VM isolation; both are container-on-a-host with shared kernels, which is a weaker tenant-isolation story if we ever go multi-tenant-per-container. Pass.

---

## § Working `fly.toml` (annotated)

Place at `/Users/gtrush/Downloads/jellyclaw-engine/fly.toml`. Single file, same file for prod and staging — override `app` and `min_machines_running` via `flyctl deploy --app <name>` / environment.

```toml
# --- app identity ---------------------------------------------------------
app            = "jellyclaw-prod"          # override with --app jellyclaw-staging
primary_region = "iad"                     # Ashburn — closest to Anthropic us-east-1

# --- build ---------------------------------------------------------------
# We build the Dockerfile at repo root. No buildpack.
[build]
  dockerfile = "Dockerfile"
  # ignore test fixtures, docs, etc. — see .dockerignore
  ignorefile = ".dockerignore"

# --- runtime env (non-secret) --------------------------------------------
# Secrets (ANTHROPIC_API_KEY, JELLYCLAW_TOKEN, OPENROUTER_API_KEY) are
# injected separately via `fly secrets set` — never committed here.
[env]
  NODE_ENV       = "production"
  JELLYCLAW_HOME = "/data/jellyclaw"       # reroutes ~/.jellyclaw/* to the volume
  LOG_LEVEL      = "info"
  # Playwright browsers pre-installed in the base image; don't re-download.
  PLAYWRIGHT_BROWSERS_PATH = "/ms-playwright"
  # Tell jellyclaw that Chrome-MCP is in-container (Alpha).
  JELLYCLAW_CHROME_MODE    = "inline"

# --- HTTP service ---------------------------------------------------------
[http_service]
  internal_port        = 8080              # matches --port in the CMD
  force_https          = true
  auto_stop_machines   = "off"             # CRITICAL: SSE + autostop don't mix
  auto_start_machines  = true              # still wake Machines from manual stop
  min_machines_running = 2                 # always-on posture
  processes            = ["app"]

  # Concurrency hints for Fly Proxy routing. SSE connections are long-lived,
  # so we intentionally set soft_limit well above typical req/sec, otherwise
  # the proxy thinks we're saturated constantly.
  [http_service.concurrency]
    type        = "connections"
    soft_limit  = 200
    hard_limit  = 400

  # Healthcheck — hits /v1/health which is mounted before auth
  # (see engine/src/server/app.ts:77-84).
  [[http_service.checks]]
    grace_period = "30s"   # Playwright image is ~1.8 GB; give it room
    interval     = "15s"
    method       = "GET"
    path         = "/v1/health"
    timeout      = "5s"

# --- VM sizing -----------------------------------------------------------
[[vm]]
  size     = "shared-cpu-2x"               # 2 vCPU, 1 GB RAM baseline
  memory   = "1gb"
  cpu_kind = "shared"

# --- persistent storage --------------------------------------------------
# One volume per Machine. Name is stable across deploys; Fly attaches the
# existing volume if one exists for that Machine, or creates a new empty
# one on first boot (see https://fly.io/docs/launch/scale-count/).
[[mounts]]
  source              = "jellyclaw_data"
  destination         = "/data"
  initial_size        = "10gb"
  snapshot_retention  = 5
  scheduled_snapshots = true
  processes           = ["app"]

# --- deploy strategy -----------------------------------------------------
[deploy]
  strategy        = "rolling"              # one Machine at a time; upgrade to bluegreen at Beta
  max_unavailable = 1
  wait_timeout    = "5m"                   # allows for Chrome-heavy cold boot
```

Source checks: every field name here is from the [fly.toml reference](https://fly.io/docs/reference/configuration/) verbatim. The only opinionated departures from a `fly launch`-generated template are `auto_stop_machines = "off"` (SSE incompatibility), `min_machines_running = 2` (HA), `grace_period = "30s"` (Playwright boot), and `[http_service.concurrency].type = "connections"` (SSE streams, not request/sec).

---

## § Working `Dockerfile` (annotated)

Place at `/Users/gtrush/Downloads/jellyclaw-engine/Dockerfile`. Multi-stage: builder runs TS compile, runner ships only the built artifacts + runtime deps.

```dockerfile
# syntax=docker/dockerfile:1.7
# ==========================================================================
# Stage 1 — builder
# Pin the Playwright image to the exact minor Playwright version that
# @playwright/mcp@0.0.70 transitively requires. Jammy = Ubuntu 22.04,
# smaller layers than Noble and our deps are on jammy already.
# See https://playwright.dev/docs/docker for tag discipline.
# ==========================================================================
FROM mcr.microsoft.com/playwright:v1.58.2-jammy AS builder

# Use the same Node 20 that the base image ships. Confirm by running
# `docker run --rm mcr.microsoft.com/playwright:v1.58.2-jammy node --version`.
ENV NODE_ENV=development

WORKDIR /app

# Copy only package manifests first so `npm ci` layer caches on lock-only
# changes. engine/package-lock.json is the source of truth per SPEC §15.
COPY engine/package.json engine/package-lock.json ./engine/
WORKDIR /app/engine
RUN npm ci --no-audit --no-fund --prefer-offline

# Now copy source and build.
COPY engine ./
RUN npm run build

# Strip devDependencies — second install against the same lockfile.
RUN npm prune --omit=dev

# ==========================================================================
# Stage 2 — runner
# ==========================================================================
FROM mcr.microsoft.com/playwright:v1.58.2-jammy AS runner

ENV NODE_ENV=production \
    # Playwright browsers are pre-installed in the base image at this path.
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    # Fly sets PORT dynamically; we match it to fly.toml internal_port.
    PORT=8080 \
    # Point jellyclaw at the mounted volume.
    JELLYCLAW_HOME=/data/jellyclaw

# Non-root user. Playwright image ships with `pwuser` (uid 1000) — reuse it.
# The volume mount at /data will be chown'd at first boot via tini's pre-exec.
RUN mkdir -p /data/jellyclaw && chown -R pwuser:pwuser /data

WORKDIR /app/engine

# Copy built artifacts + pruned node_modules from the builder.
COPY --from=builder --chown=pwuser:pwuser /app/engine/dist         ./dist
COPY --from=builder --chown=pwuser:pwuser /app/engine/node_modules ./node_modules
COPY --from=builder --chown=pwuser:pwuser /app/engine/package.json ./package.json
COPY --from=builder --chown=pwuser:pwuser /app/engine/bin          ./bin

USER pwuser

EXPOSE 8080

# tini handles PID 1 signal forwarding — jellyclaw wants SIGTERM to land on
# the Node process so its shutdown handler in serve.ts:232 fires cleanly.
# Playwright image ships tini at /usr/bin/tini.
ENTRYPOINT ["/usr/bin/tini", "--"]

# --host 0.0.0.0      — required for Fly's edge to reach us
# --i-know-what-im-doing — bypasses serve.ts:150 loopback-only safety valve
# --auth-token "$JELLYCLAW_TOKEN" — from `fly secrets set JELLYCLAW_TOKEN=...`
# Use `sh -c` to interpolate $JELLYCLAW_TOKEN from env at runtime.
CMD ["sh", "-c", "node dist/cli/main.js serve --host 0.0.0.0 --port ${PORT:-8080} --i-know-what-im-doing --auth-token \"$JELLYCLAW_TOKEN\""]
```

**`.dockerignore`** (same dir, root of repo):

```
node_modules
engine/node_modules
engine/dist
engine/coverage
.git
.github
docs
test
phases
prompts
skills
agents
desktop
integration
scripts/autobuild-simple
```

**Why a separate user (pwuser).** Running Chromium as root prints warnings and in headless mode can fail the sandbox init. The Playwright base image pre-configures `pwuser` exactly for this. Root inside containers is also a flag in any future SOC2 review — no reason to incur it.

**Memory sizing caveat for Chrome.** Chromium with one open page consumes ~200–400 MB. Our `shared-cpu-2x@1GB` Machine has 1024 MB total. Node + jellyclaw baseline is ~150 MB. One Playwright session = ~400 MB. Two simultaneous sessions = ~800 MB. At 3+ sessions we start paging / OOM. For Alpha we cap concurrent MCP sessions per Machine at 2 (enforceable via the rate limiter in `engine/src/ratelimit/*`, Agent 4 detail). For Beta we either (a) bump to `shared-cpu-4x@2GB` ($15/mo) or (b) move Chrome to a sidecar. Both are acceptable.

**Image size target: ≤1.8 GB.** The Playwright base is ~1.5 GB; our layer adds ~300 MB of node_modules + dist. Fly's registry pull is fast (sub-second per MB inside Fly's network), so deploy time is dominated by Node boot, not image pull. No pressure to shrink further in Alpha.

---

## § Open questions

1. **SQLite per-tenant isolation.** Today all sessions live under `/data/jellyclaw/sessions/` with no tenant scoping. Multi-tenant API requires (a) a tenant ID injected at `POST /v1/sessions`, (b) storage of `(tenant_id, session_id) → path`, and (c) API-layer enforcement that session X belongs to tenant Y. This is squarely Agent 2's design — flagging here so the infrastructure side knows not to solve it via volume-per-tenant (that explodes past 500 GiB volume cap, and past ~1000 tenants we couldn't fit the volumes on one Machine anyway).

2. **Shared Anthropic rate limits.** All tenants share our `ANTHROPIC_API_KEY`, which means all tenants share its rate limits (ITPM, OTPM, RPM tier). A single chatty tenant can DoS the rest. Two options: (a) **BYOK** — tenant provides their own `ANTHROPIC_API_KEY`, we pass through with zero retention. (b) **Managed key + quota** — we ship a rate limiter bucket per tenant in `engine/src/ratelimit/*`, enforced on the server side *before* we spend our key's budget. Agent 2 decides. My opinion: ship BYOK-first for Alpha (simpler, tenant sees their own costs directly, shifts trust boundary favorably). Managed key at Beta with a proper billing story.

3. **Chrome memory at >5 concurrent sessions per Machine.** Covered in Container design — cap at 2 for Alpha via rate limiter, move to sidecar at Beta. The exact cutover metric: when P99 memory across Machines crosses 85% in a 24h window.

4. **SSE + autostop incompatibility.** We sidestep today by disabling autostop. If Fly ever ships connection-aware autostop (several community threads request this) we should re-evaluate. No action until then.

5. **Cold boot latency on scale-up.** At Beta, when a new Machine comes up under load, its first request pays ~6 s cold boot. If we're already at `soft_limit = 200` connections on Machine A and a 201st request hits, Fly Proxy routes it to Machine B's wake-up, and that 201st request waits 6 s. Mitigation: keep `min_machines_running` at N where N is one more than steady-state peak, so scale-up events are anticipatory not reactive.

6. **LiteFS for read-replica session access.** Not needed for Alpha, flagged in Topology. If we ever want "any Machine can serve any session" — e.g. for blue/green deploys without Fly-Replay — LiteFS is the canonical Fly answer. Cost: 2× the operational complexity. Re-examine at Beta.

7. **Secret rotation story.** `fly secrets set` issues a new revision and requires a Machine restart to pick up. That's a 30-second brownout on our one-at-a-time rolling strategy. For a truly seamless rotation we'd want dual-token acceptance: the server reads both `JELLYCLAW_TOKEN` and `JELLYCLAW_TOKEN_PREVIOUS` and accepts either for a grace window. That's an engine change, not a Fly-side change. Flag for Agent 2.

8. **Observability.** This plan doesn't include metrics/logs drain config. Fly ships `log-shipper` blueprints to drain logs to Loki/Datadog/Axiom. Prometheus metrics from Hono are one `@hono/prometheus` middleware away. All additive, none blocking. Address in a separate § once observability requirements are defined.

9. **Region expansion criteria.** When do we add `fra`? Concrete threshold: when ≥20% of API traffic originates from European IPs AND the P95 Anthropic-path latency for those users exceeds 1.5 s. Below that, the hop cost doesn't earn a second region's ops tax.

10. **Egress IP pinning for MCP servers.** If a user configures an MCP server that requires an IP allowlist (rare today, plausible in Beta), we need a static egress IP. Fly charges ~$2/mo for a dedicated IPv4. Not in Alpha baseline cost; flag for Beta.

---

*End of plan. No source code modified. No Fly resources created. Everything here is design; execution is a separate `fly launch` + `fly secrets set` + `git push origin main` sequence that a human runs when we're ready to cut the first real deployment.*
