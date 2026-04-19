# Phase 08 Hosting — Prompt T6-01: Fly Dockerfile + fly.toml

**When to run:** After T5 prompts (HTTP MCP transport, auth seam, bun-sqlite) have all landed. This tier produces deployable artifacts; the engine changes it depends on must be in place first.
**Estimated duration:** 1–2 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

Agent 1 (hosting workstream) has already finished the Fly.io deployment design. The complete, annotated `Dockerfile` and `fly.toml` live inside `docs/hosting/01-fly-deployment.md` as fenced code blocks. Your job is to **copy those designs into the repo verbatim** (strip the explanatory annotations, keep the final working content) and wire the tiny helpers Agent 1 flagged: a `.dockerignore`, a manual deploy script, and confirmation that `/health` + `--host 0.0.0.0 --i-know-what-im-doing` already work as designed.

**Do not redesign.** Agent 1 made the decisions. You transcribe.

## Research task

1. Read `docs/hosting/01-fly-deployment.md` end-to-end. The two load-bearing sections for this prompt are **§ Working `fly.toml` (annotated)** and **§ Working `Dockerfile` (annotated)**. Those code fences are the source of truth.
2. Open `engine/src/cli/serve.ts` and confirm:
   - `--host` flag exists and defaults to `127.0.0.1`
   - `--i-know-what-im-doing` gates non-loopback binds (see lines ~143–177)
   - `--auth-token` flag exists and the env-var fallback resolves `JELLYCLAW_TOKEN` or `OPENCODE_SERVER_PASSWORD`
   - If any of those are missing, STOP and emit `FAIL: T6-01 serve.ts flag contract drifted — <detail>`. Do not attempt to patch serve.ts in this prompt.
3. Open `engine/src/server/app.ts` (around lines 77–84) and confirm `/v1/health` is mounted BEFORE the auth middleware. Agent 1's design requires this so Fly's healthcheck can hit it anonymously. If it's under auth, STOP and `FAIL: T6-01 /v1/health behind auth — fix app.ts mounting order before retry`.
4. Open `engine/src/server/routes/health.ts` and confirm the response shape is `{ ok, version, uptime_ms, active_runs }`. Agent 1's healthcheck probe in `fly.toml` expects a 200.
5. Read `engine/package.json` and note the `bin` map — Agent 1's CMD invokes `node dist/cli/main.js serve …`; verify that path exists post-build (look at `dist/` after a `bun run build`).
6. `ls /Users/gtrush/Downloads/jellyclaw-engine/` — confirm `Dockerfile`, `fly.toml`, `.dockerignore`, and `scripts/deploy-fly.sh` are all ABSENT. If any exist already, stop and read their contents before overwriting.

## Implementation task

### Files to create

- `/Users/gtrush/Downloads/jellyclaw-engine/Dockerfile` — copy the FINAL Dockerfile from `docs/hosting/01-fly-deployment.md` § Working `Dockerfile` (annotated). Strip the `# ==…` banner comments and the prose-style `# …` annotations Agent 1 wrote as explanation; keep only comments that document a non-obvious line (e.g. `# tini handles PID 1 signal forwarding`). The resulting file should be ~40–60 lines. Preserve every `FROM`, `ENV`, `RUN`, `COPY`, `USER`, `EXPOSE`, `ENTRYPOINT`, `CMD` line verbatim.
- `/Users/gtrush/Downloads/jellyclaw-engine/fly.toml` — copy the FINAL fly.toml from § Working `fly.toml` (annotated). Same approach: strip prose-only annotations, keep the config keys verbatim. The `app` key must be `jellyclaw-prod` (staging override happens via `--app` flag at deploy time, per Agent 1).
- `/Users/gtrush/Downloads/jellyclaw-engine/.dockerignore` — use Agent 1's ignore list from the end of the Dockerfile section. Do not add anything Agent 1 didn't include. Verbatim:
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
- `/Users/gtrush/Downloads/jellyclaw-engine/scripts/deploy-fly.sh` — one-liner manual deploy. Exactly:
  ```bash
  #!/usr/bin/env bash
  # Manual Fly deploy. CI uses .github/workflows/fly-deploy.yml; this is the
  # local-operator escape hatch. Pass --app to target staging.
  set -euo pipefail
  APP="${1:-jellyclaw-prod}"
  exec fly deploy --app "$APP" --remote-only --strategy rolling --wait-timeout 300
  ```
  `chmod +x` after creation.

### Files NOT to touch

- `engine/src/cli/serve.ts` — Agent 1 verified the flag surface is correct. Do not add anything.
- `engine/src/server/app.ts` or `engine/src/server/routes/health.ts` — already correct.
- Any `.github/workflows/*.yml` — that's T6-03's territory.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

# Sanity: full build must still succeed so the Dockerfile COPY --from=builder step has a real dist/
bun install
bun run typecheck
bun run build
ls -la dist/cli/main.js   # must exist; Dockerfile CMD targets it

# Build the image locally (requires docker)
docker build -t jellyclaw:local .

# Report image size — target ≤ 1.8 GB per Agent 1
docker images jellyclaw:local --format "{{.Size}}"

# Smoke: run the container, curl /health, tear down.
CID=$(docker run -d --rm \
  -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-sk-ant-smoke-placeholder}" \
  -e JELLYCLAW_TOKEN="smoke-token-do-not-ship" \
  -p 8080:8080 jellyclaw:local)
sleep 5
curl --fail --silent http://127.0.0.1:8080/v1/health | tee /tmp/jc-health.json
docker stop "$CID"
test -s /tmp/jc-health.json || { echo "health response empty"; exit 1; }
grep -q '"ok":true' /tmp/jc-health.json || { echo "health did not return ok:true"; exit 1; }

# fly.toml syntactic validation (does not require being logged in)
# flyctl must be installed; if not, skip with a clearly-logged warning.
if command -v fly >/dev/null 2>&1; then
  fly config validate
else
  echo "[warn] flyctl not installed locally — skipping 'fly config validate'; CI will catch it"
fi
```

### Acceptance criteria (must all hold)

1. `docker build -t jellyclaw:local .` exits 0 on a clean checkout.
2. Final image size ≤ 1.8 GB (Agent 1's target; the Playwright base is ~1.5 GB, our layer ~300 MB).
3. `docker run … -p 8080:8080` container: `curl http://127.0.0.1:8080/v1/health` returns HTTP 200 with JSON body `{"ok":true,"version":"…","uptime_ms":<n>,"active_runs":0}`.
4. `/v1/health` responds BEFORE the bearer token would be required (it must be mounted ahead of auth — `curl` must succeed with NO `Authorization` header).
5. `fly config validate` (if flyctl present) exits 0 OR the `fly.toml` parses without error when `flyctl` is not available.
6. `bun run build && bun test` still pass — nothing in this prompt touches engine source.
7. `scripts/deploy-fly.sh --app jellyclaw-staging --help-dry-run-is-not-supported` — the script is executable (mode 0755) and invokes `fly deploy --app jellyclaw-staging …` when given a first arg. You do NOT need to actually run a deploy.

### Tests to add

No unit tests for this tier — it's deployment config. The smoke test (docker build + health curl) is the test. Record the `jc-health.json` snapshot in the closeout.

### Common pitfalls

- **Do not paste Agent 1's prose inline.** The annotations in `docs/hosting/01-fly-deployment.md` are explanatory prose between code fences; the actual Dockerfile / fly.toml are the code inside the fences. Copy only what's between ` ```dockerfile ` / ` ```toml ` and ` ``` `, then strip intra-code prose-only comments (keep comments that name a constraint like "must match fly.toml internal_port").
- **Do NOT replace `${PORT:-8080}` with `8080`.** Fly injects `PORT` at Machine boot; the shell interpolation is load-bearing.
- **Do NOT drop `tini`.** The ENTRYPOINT is `/usr/bin/tini --` for SIGTERM propagation; removing it breaks jellyclaw's clean shutdown path in `serve.ts`.
- **Do NOT add a `HEALTHCHECK` directive to the Dockerfile.** Fly's `[[http_service.checks]]` in `fly.toml` owns the healthcheck. A Docker-level `HEALTHCHECK` is redundant and confuses Fly's Machine-start readiness probe.
- **Do NOT change `auto_stop_machines = "off"`.** Agent 1 § Scale-to-zero documents exactly why SSE + autostop are incompatible today.
- **Do NOT flip `min_machines_running` to 0.** Same reason. Alpha is always-on.
- **Do NOT touch the `USER pwuser` line.** The Playwright base ships that user; root would fail the Chromium sandbox init.
- **If the `dist/cli/main.js` path is different** (e.g. T5 moved it to `dist/main.js`), STOP and `FAIL: T6-01 dist path drift — serve entrypoint is <new-path>, update Dockerfile CMD before retry`. Do not guess.
- **`ANTHROPIC_API_KEY` is required at runtime** for actual agent calls, but NOT for `/v1/health` to return 200. The smoke test uses a placeholder intentionally.

## Verification checklist

- [ ] `Dockerfile`, `fly.toml`, `.dockerignore`, `scripts/deploy-fly.sh` all present at repo root (the shell script under `scripts/`, the rest at root).
- [ ] `scripts/deploy-fly.sh` is `chmod +x`.
- [ ] `docker build -t jellyclaw:local .` succeeds.
- [ ] `docker run … -p 8080:8080 jellyclaw:local` + `curl localhost:8080/v1/health` returns 200 JSON.
- [ ] `fly config validate` is happy (or flyctl absent is logged).
- [ ] `bun run typecheck && bun run test && bun run lint` all still pass.
- [ ] No engine source files modified.

## Closeout

1. Append to `COMPLETION-LOG.md`: `08.T6-01 ✅` with the image size + health snapshot.
2. Print `DONE: T6-01` on success, `FAIL: T6-01 <reason>` on fatal failure.
