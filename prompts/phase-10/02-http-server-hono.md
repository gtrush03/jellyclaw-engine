# Phase 10 — CLI + HTTP + library — Prompt 02: Hono HTTP server with SSE

**When to run:** After Phase 10 prompt 01 (CLI) is ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 3–4 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if 10.01 not ✅. -->
<!-- END paste -->

## Research task

1. Re-read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-10-cli-http.md` — HTTP API section.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — bind `127.0.0.1` default, bearer auth required, CORS locked to `http://localhost:*`.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/patches/002-bind-localhost-only.patch` — verify it constrains OpenCode's own server to 127.0.0.1; align jellyclaw's server with that invariant.
4. Use context7 to fetch `hono@^4` + `@hono/node-server@^1` docs: middleware signature, SSE helper (`streamSSE`), reconnection via `Last-Event-Id`.
5. Read Phase 03 event stream — SSE events will mirror the same envelope as stream-json.
6. Read Phase 09.02 — resume events from the session store so `Last-Event-Id` replay works.

## Implementation task

Implement the HTTP server subcommand `jellyclaw serve` using Hono. Endpoints for runs, SSE event streams, steering, cancel, resume. Auth via bearer token. Strict localhost binding by default.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/server/app.ts` — Hono app factory.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/server/auth.ts` — bearer auth middleware; reads `OPENCODE_SERVER_PASSWORD` (name kept for Genie/OpenCode compat) or `JELLYCLAW_TOKEN`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/server/routes/runs.ts` — `POST /v1/runs`, `GET /v1/runs/:id/events`, `POST /v1/runs/:id/steer`, `POST /v1/runs/:id/cancel`, `POST /v1/runs/:id/resume`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/server/routes/health.ts` — `GET /v1/health`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/server/routes/config.ts` — `GET /v1/config` (redacted).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/server/sse.ts` — SSE helper with `Last-Event-Id` replay.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/server/run-manager.ts` — in-memory map of active runs: `{ runId → { engine, events: EventEmitter, status, sessionId } }`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/serve.ts` — wires `jellyclaw serve` into Commander (replaces the 10.01 stub).
- Tests: `auth.test.ts`, `routes.test.ts`, `sse.test.ts`, `run-manager.test.ts`, `bind-safety.test.ts`.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/http-api.md`.

### `jellyclaw serve` flags

```
jellyclaw serve
  --port <n>              # default 8765
  --host <addr>           # default 127.0.0.1 — REFUSE any other value without --i-know-what-im-doing
  --auth-token <token>    # else reads OPENCODE_SERVER_PASSWORD or JELLYCLAW_TOKEN; no token → generate random + print once
  --cors <origins>        # default "http://localhost:*"
  --verbose
```

### Bind safety

- Default host `127.0.0.1`. If `--host 0.0.0.0` (or any non-loopback) is passed:
  - Require `--i-know-what-im-doing` flag, else refuse with error.
  - Require an auth token (no auto-generated — explicit `--auth-token` or env).
  - Print a multi-line red warning before starting.
- Never bind to `::` (IPv6 any) without the same gate.

### Endpoints

**`POST /v1/runs`** → body `{ prompt, sessionId?, model?, permissionMode?, maxTurns?, wishId?, appendSystemPrompt?, allowedTools?, mcpConfig? }` → `200 { runId, sessionId }`. Run starts async.

**`GET /v1/runs/:id/events`** (SSE) → streams jellyclaw events. Supports `Last-Event-Id` header for resume — server replays from that id onward, pulling missed events from the session store if the run has advanced past in-memory buffer. Event name: `message`. Data: serialized event JSON. `id:` line per event = session event seq.

**`POST /v1/runs/:id/steer`** → body `{ text }` — injects a user message mid-turn into the running engine (for "interrupt + steer" UX). Returns `202`.

**`POST /v1/runs/:id/cancel`** → signals abort; returns `202`.

**`POST /v1/runs/:id/resume`** → body `{ prompt }` — resumes the run's session (delegates to Phase 09.02 `resume()`). Returns `{ runId, sessionId }`.

**`GET /v1/config`** — returns effective merged config with secrets redacted (mask `apiKey`, `token`, any value from the scrub patterns).

**`GET /v1/health`** — `{ ok: true, version, uptime_ms, active_runs }`.

### Auth

- Middleware checks `Authorization: Bearer <token>`.
- Constant-time compare (`crypto.timingSafeEqual`); pad tokens to equal length first or reject unequal lengths uniformly.
- 401 JSON body: `{ error: "unauthorized" }`.
- `/v1/health` is also authenticated — don't leak version/uptime unauthenticated.
- If no token configured at startup, generate `crypto.randomBytes(32).toString("hex")`, print it once on stdout, and require it for every request. Do not write it to disk.

### CORS

- Allowlist `http://localhost:*` by default (any port). Configurable `--cors`.
- Preflight `OPTIONS` responds 204 with `Access-Control-Allow-Headers: Authorization, Content-Type`.
- Never `*`.

### Run manager

- On `POST /v1/runs`: create an `EventEmitter` for the run; construct engine; start `run()` async; pipe engine events to the emitter AND append to session store (via existing Phase 09 path).
- SSE client subscribes to emitter; flush on each event; dispose listener on disconnect.
- On engine completion: emit a terminal `done` event; keep the run entry for 5 minutes so late subscribers with `Last-Event-Id` can still replay.
- GC: clear runs after 5 min of completion.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add hono@^4 @hono/node-server@^1
bun run typecheck
bun run test engine/src/server
bun run lint
```

### Expected output

- `jellyclaw serve --port 8765` starts; binds 127.0.0.1.
- `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/v1/health` returns 200.
- SSE test: POST a run, GET events, observe `message_start` → text deltas → `message_stop`.
- `Last-Event-Id` replay works across disconnect.

### Tests to add

- `auth.test.ts`:
  - Missing header → 401.
  - Wrong token → 401.
  - Right token → 200.
  - Constant-time compare path exercised (no early-return on length).
- `bind-safety.test.ts`:
  - Default binds 127.0.0.1.
  - `--host 0.0.0.0` without escape flag → refuses to start.
  - `--host 0.0.0.0 --i-know-what-im-doing` without token → refuses.
- `routes.test.ts`:
  - `POST /v1/runs` returns runId + sessionId.
  - `POST /v1/runs/:id/cancel` while running → cancels; event stream ends.
  - `POST /v1/runs/:id/steer` mid-run injects user turn.
  - `GET /v1/config` redacts secrets.
- `sse.test.ts`:
  - Client subscribes, receives events.
  - Disconnect + resume with `Last-Event-Id` gets missed events.
  - Events have `id:` lines equal to session event seq.
- `run-manager.test.ts` — run entries cleaned up after 5 min; active_runs count accurate.

### Verification

```bash
bun run build
JELLYCLAW_TOKEN=devtoken ./engine/bin/jellyclaw serve --port 8765 &
SERVER=$!
sleep 1

curl -s -H "Authorization: Bearer devtoken" http://127.0.0.1:8765/v1/health

RUN=$(curl -s -XPOST -H "Authorization: Bearer devtoken" -H "Content-Type: application/json" \
  -d '{"prompt":"say hi in one word"}' http://127.0.0.1:8765/v1/runs | jq -r .runId)

curl -N -H "Authorization: Bearer devtoken" \
  http://127.0.0.1:8765/v1/runs/$RUN/events
# expect: SSE stream

kill $SERVER
```

### Common pitfalls

- Hono's `streamSSE` handles `id:`/`event:`/`data:` framing; don't write raw bytes yourself.
- CORS middleware must run BEFORE auth so preflight doesn't get 401.
- Timing-safe compare: `Buffer.from(provided).length !== Buffer.from(expected).length` — if unequal, still hash both and compare, never short-circuit.
- `Last-Event-Id`: the id must be monotonically increasing within a session; coordinate with Phase 09 event seq.
- Steer mid-turn: don't inject raw user text blindly; funnel through the same UserPromptSubmit hook as CLI.
- `--host 0.0.0.0` is a *footgun*. Genie's dispatcher MUST NOT pass this. Document in `docs/http-api.md`.
- Auto-generated token: print to **stdout** once, NEVER log it to pino, NEVER include in `/v1/config`.
- `OPENCODE_SERVER_PASSWORD` naming is kept for Genie's existing dispatcher compat; document the alias in `docs/http-api.md` and `docs/cli.md`.
- Don't use Express or Fastify — the phase doc picks Hono; switching breaks bundle-size assumptions.
- Cancellation: connect `AbortController.signal` from route handler to engine.run(); engine must check the signal at every safe point.
- Graceful shutdown: on SIGTERM, stop accepting new runs, await active runs up to 30 s, then force-exit.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: 10.02 ✅, next prompt = prompts/phase-10/03-library-api.md. -->
<!-- END paste -->
