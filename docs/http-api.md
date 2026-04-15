# HTTP API reference

`jellyclaw serve` runs an HTTP server that exposes the engine over a small
Hono app. It speaks the same `AgentEvent` protocol the CLI streams to stdout
(see [`docs/event-stream.md`](event-stream.md)), but over an authenticated,
bounded, loopback-by-default socket instead of a pipe.

This document is the stable reference for endpoints, auth, bind safety, CORS,
SSE reconnection, and error shapes. Engineering details live in
[`phases/PHASE-10-cli-http.md`](../phases/PHASE-10-cli-http.md); the threat
model that drives the defaults lives in [`engine/SECURITY.md`](../engine/SECURITY.md).

> **Status.** Phase 10.02 — the server ships with bearer auth, locked-down
> CORS, loopback binding, SSE `Last-Event-Id` replay, and route-level zod
> validation. The engine loop that feeds the server is still a Phase-0 stub
> (see [Phase 10.02 limitations](#phase-1002-limitations) below); real event
> pumping lands in Phase 10.03+.

## Overview

Two ways to drive the engine over HTTP:

1. **Per-wish dispatch.** `POST /v1/runs` kicks off one run, the caller
   subscribes to `GET /v1/runs/:id/events` for the SSE stream, and closes
   the connection when `done` arrives.
2. **Long-lived daemon.** A LaunchAgent (or equivalent) keeps `jellyclaw
   serve` warm; Genie's dispatcher POSTs to `http://127.0.0.1:<port>/v1/runs`
   instead of spawning a fresh subprocess per wish. See
   [`integration/GENIE-INTEGRATION.md`](../integration/GENIE-INTEGRATION.md)
   §4 for the LaunchAgent template.

Non-negotiable defaults:

- **Binds `127.0.0.1` only.** A non-loopback bind is refused unless the
  operator passes `--host 0.0.0.0 --i-know-what-im-doing` AND an explicit
  `--auth-token`. See [Bind safety](#bind-safety).
- **Bearer auth is mandatory.** Every request (including from `127.0.0.1`)
  must carry `Authorization: Bearer <token>`. No localhost shortcut, no
  origin bypass. See [Authentication](#authentication).
- **CORS allowlist is locked down.** Default is
  `http://localhost:*,http://127.0.0.1:*`. `*` wildcards are refused, and
  `Access-Control-Allow-Credentials: true` is never emitted. See [CORS](#cors).
- **No TLS.** The server does not terminate HTTPS. If you ever run it with
  `--i-know-what-im-doing`, put it behind a reverse proxy with its own auth
  and TLS — the bearer token is not a substitute for network-layer
  controls.

## Quickstart

```bash
# Generate a token, export it for the client, start the server.
export JELLYCLAW_TOKEN=$(openssl rand -hex 32)
jellyclaw serve --port 8765 &

# Health probe.
curl -s http://127.0.0.1:8765/v1/health \
  -H "Authorization: Bearer $JELLYCLAW_TOKEN"
# => {"ok":true,"version":"0.1.0","uptime_ms":1234,"active_runs":0}

# Dispatch a run, stream its events.
RUN_ID=$(curl -s http://127.0.0.1:8765/v1/runs \
  -H "Authorization: Bearer $JELLYCLAW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"say hi"}' | jq -r .runId)

curl -N http://127.0.0.1:8765/v1/runs/"$RUN_ID"/events \
  -H "Authorization: Bearer $JELLYCLAW_TOKEN"
```

Stop the server with SIGTERM (`kill %1`, Ctrl-C in the foreground). See
[Graceful shutdown](#graceful-shutdown).

## Authentication

Every request must carry a bearer token:

```
Authorization: Bearer <token>
```

### Token resolution

The server resolves a single effective token at startup, from the first
source that yields a non-empty value:

1. `--auth-token <token>` — CLI flag, highest priority.
2. `OPENCODE_SERVER_PASSWORD` — env var. This name is kept for compatibility
   with the existing Genie dispatcher (see
   [`integration/GENIE-INTEGRATION.md`](../integration/GENIE-INTEGRATION.md))
   and the upstream OpenCode convention.
3. `JELLYCLAW_TOKEN` — env var, jellyclaw-native name.
4. **Auto-generated.** If none of the above is set, the server generates a
   32-byte hex token, writes it to stderr exactly once as
   `[startup] generated bearer token: <hex>`, and keeps serving. The token
   rotates on every restart.

In `--host 0.0.0.0 --i-know-what-im-doing` mode the auto-generation path is
refused — you MUST pass a token explicitly.

### Compare semantics

Token comparison is constant-time (`crypto.timingSafeEqual`) over
equal-length buffers. The implementation always runs the compare (against a
zero-padded copy) so a length-based early return cannot leak token length.
See [`engine/src/server/auth.ts`](../engine/src/server/auth.ts).

### Unauthorized response

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{"error":"unauthorized"}
```

401 is returned when: the `Authorization` header is missing; it does not
match the `Bearer <token>` shape; or the token compare fails.

## Bind safety

The server binds `127.0.0.1:<port>` by default. Binding to a non-loopback
address is refused unless the operator explicitly opts out of the safe
default:

| `--host` value                   | `--i-know-what-im-doing` | `--auth-token` | Outcome |
|----------------------------------|:-----------------------:|:--------------:|---------|
| `127.0.0.1` / `::1` / `localhost` | _(any)_                | _(any)_        | Accepted. |
| `0.0.0.0` / LAN IP               | absent                  | _(any)_        | Refused with `BindSafetyError` + exit 2. |
| `0.0.0.0` / LAN IP               | present                 | absent         | Refused — auto-generation is disabled in this mode. |
| `0.0.0.0` / LAN IP               | present                 | present        | Accepted with a loud stderr banner; writes an audit entry. |

The refusal happens in the CLI wiring layer before the Hono app is built;
see `engine/src/cli/serve.ts` for the check. Rationale: CVE-2026-22812
teaches that a `127.0.0.1` bind is safer than a network bind only because
browsers can reach it — bearer auth closes the browser-probe hole, but
broadcasting the server to a LAN expands the attacker set dramatically.

**Genie dispatcher MUST NOT pass `--host 0.0.0.0`.** The LaunchAgent
template in `integration/GENIE-INTEGRATION.md` §4 pins the default to
`127.0.0.1`; any deviation is a configuration bug, not a feature.

## CORS

### Default allowlist

```
http://localhost:*,http://127.0.0.1:*
```

Any other origin returns no `Access-Control-Allow-Origin` header; browsers
treat the absence as a rejection.

Override via `--cors <csv>`:

```
jellyclaw serve --cors "https://app.example.com,http://localhost:*"
```

### Grammar

Two allowed forms per entry:

- **Exact origin:** `https://app.example.com` (no trailing slash; scheme +
  host + optional port).
- **Localhost wildcard:** `http://localhost:*` or `http://127.0.0.1:*` —
  any port on `localhost` / `127.0.0.1`.

No other wildcards are permitted. Passing `*`, `https://*.example.com`, or
any bare glob throws at startup and the server refuses to boot.

### Never-emitted headers

- `Access-Control-Allow-Origin: *` — never emitted under any configuration.
- `Access-Control-Allow-Credentials: true` — never emitted. The bearer
  token is the only auth factor and credentialed CORS is out of scope.

### Preflight

`OPTIONS` requests are terminated by the CORS middleware BEFORE the auth
middleware sees them:

- Matching origin → `204 No Content` with `Access-Control-Allow-Origin`,
  `-Methods: GET,POST,OPTIONS`, `-Headers: Authorization, Content-Type`,
  `-Max-Age: 600`.
- Non-matching origin → `204 No Content` with NO allow headers (browser
  rejects).

This is why `OPTIONS` never returns 401 even though the endpoint behind it
requires auth.

## Endpoints reference

All endpoints live under the `/v1` prefix. Every non-OPTIONS request
requires `Authorization: Bearer <token>` and returns `401 Unauthorized`
without it — the auth requirement is not re-stated per endpoint.

### POST /v1/runs

Start a new run.

- **Auth:** required.
- **Request body (application/json):**

  ```jsonc
  {
    "prompt":             "string (required, ≥1 char)",
    "sessionId":          "string (optional; resume an existing session)",
    "model":              "string (optional; override)",
    "permissionMode":     "string (optional: default|acceptEdits|bypassPermissions|plan)",
    "maxTurns":           "integer > 0 (optional)",
    "wishId":             "string (optional; idempotency key)",
    "appendSystemPrompt": "string (optional)",
    "allowedTools":       "string[] (optional; Tool(pattern) grammar)",
    "mcpConfig":          "string (optional; path to mcp.json)",
    "cwd":                "string (optional; absolute path)"
  }
  ```

  The schema is strict — unknown fields are rejected with `400 bad_request`.
  Fields mirror `CreateRunOptions` in
  [`engine/src/server/types.ts`](../engine/src/server/types.ts).

- **Response:** `201 Created`

  ```json
  {"runId":"01J...","sessionId":"01J..."}
  ```

- **Status codes:**
  - `201` — run created, buffer open, event emitter live.
  - `400` — zod validation failure (see [Error response shape](#error-response-shape)).
  - `401` — missing / bad bearer.
  - `500` — internal (logged; includes `message`).

- **Example:**

  ```bash
  curl -s http://127.0.0.1:8765/v1/runs \
    -H "Authorization: Bearer $JELLYCLAW_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"prompt":"hello","maxTurns":4}'
  ```

### GET /v1/runs/:id/events

Stream events for a run over Server-Sent Events.

- **Auth:** required.
- **Request:** `Accept: text/event-stream` (optional but conventional).
  Supports `Last-Event-Id: <seq>` for resumption (see
  [SSE event envelope](#sse-event-envelope)).
- **Response:** `200 OK`, `Content-Type: text/event-stream`.

  Each event is framed as:

  ```
  id: <seq>
  event: event
  data: <AgentEvent JSON>

  ```

  The terminal frame uses a distinct event name:

  ```
  event: done
  data: {"status":"completed"}

  ```

  `status` is one of `"completed"`, `"cancelled"`, `"failed"`. After
  `done` the server closes the connection; clients should not attempt to
  reconnect.

- **Replay on reconnect.** If the caller supplies `Last-Event-Id: N`:
  1. The server first drains events with `id > N` from the in-memory ring
     buffer.
  2. If `N` is older than the buffer's floor, the server falls back to the
     Phase-09 JSONL session log (`~/.jellyclaw/sessions/<project>/<sid>.jsonl`),
     replays events from there, then joins the live emitter.
  3. If the run is already terminal, the server replays from `N`, emits
     the `done` frame, and closes.

- **Status codes:**
  - `200` — stream opened.
  - `401` — missing / bad bearer.
  - `404` — `run_not_found`.

- **Example:**

  ```bash
  curl -N http://127.0.0.1:8765/v1/runs/"$RUN_ID"/events \
    -H "Authorization: Bearer $JELLYCLAW_TOKEN" \
    -H "Last-Event-Id: 12"
  ```

- **Notes.** A mid-stream `500` during JSONL fallback closes the stream
  with an SSE `event: error` frame before the transport ends; the ring
  buffer path never errors mid-stream because it is synchronous reads
  from memory.

### POST /v1/runs/:id/steer

Inject a mid-run user turn. The text is funneled through the
`UserPromptSubmit` hook before the engine sees it.

- **Auth:** required.
- **Request body:** `{"text":"string (≥1 char)"}`, strict.
- **Response:** `202 Accepted` with empty body `{}` on success.
- **Status codes:**
  - `202` — queued for the engine loop.
  - `400` — bad body.
  - `401` — missing / bad bearer.
  - `404` — `run_not_found`.
  - `409` — `run_terminal` (the run has already moved to `completed` /
    `cancelled` / `failed`). Response body includes the terminal status:
    `{"error":"run_terminal","status":"completed"}`.

- **Example:**

  ```bash
  curl -s http://127.0.0.1:8765/v1/runs/"$RUN_ID"/steer \
    -H "Authorization: Bearer $JELLYCLAW_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"text":"focus on the auth flow only"}'
  ```

### POST /v1/runs/:id/cancel

Request cancellation. Triggers the run's `AbortController`; the engine
loop observes the abort, emits a `session.completed` or `session.error`
event (implementation-dependent), and transitions to `cancelled`.

- **Auth:** required.
- **Request body:** none (any body is ignored).
- **Response:** `202 Accepted` with empty body `{}`.
- **Status codes:**
  - `202` — cancellation signalled. Note: cancellation is asynchronous;
    the SSE stream may still emit buffered events before terminating with
    `done` `{"status":"cancelled"}`.
  - `401` — missing / bad bearer.
  - `404` — `run_not_found`.

- **Example:**

  ```bash
  curl -s -X POST http://127.0.0.1:8765/v1/runs/"$RUN_ID"/cancel \
    -H "Authorization: Bearer $JELLYCLAW_TOKEN"
  ```

### POST /v1/runs/:id/resume

Resume a terminal run as a new run, preserving the session id. The
original `runId` is not re-used; the response returns the fresh id.

- **Auth:** required.
- **Request body:** `{"prompt":"string (≥1 char)"}`, strict.
- **Response:** `201 Created` with `{"runId","sessionId"}`.
- **Status codes:**
  - `201` — new run created.
  - `400` — bad body.
  - `401` — missing / bad bearer.
  - `404` — `run_not_found`.

### GET /v1/config

Return the effective engine config with secrets redacted.

- **Auth:** required.
- **Request body:** none.
- **Response:** `200 OK` with the same shape as `jellyclaw config show`
  (see [`docs/cli.md`](cli.md) §config). Every field matching the logger's
  redact list — `apiKey`, `authToken`, `password`, `secret`, `token`,
  `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_SERVER_PASSWORD`,
  and every value under `mcp[].env` / `mcp[].headers` — is replaced with
  the literal string `"[REDACTED]"`.
- **Status codes:**
  - `200` — OK.
  - `401` — missing / bad bearer.

The endpoint never returns the active bearer token under any key.

### GET /v1/health

Liveness + minimal run accounting.

- **Auth:** required.
- **Request body:** none.
- **Response:** `200 OK`

  ```json
  {
    "ok": true,
    "version": "0.1.0",
    "uptime_ms": 1234,
    "active_runs": 0
  }
  ```

  - `ok` — always `true` when the server can respond. A 5xx is the only
    "not ok" signal.
  - `version` — the jellyclaw engine version (from `package.json`).
  - `uptime_ms` — wall-clock ms since the server started accepting
    connections. Always `>= 0`.
  - `active_runs` — `RunManager.snapshot().activeRuns`.

- **Status codes:**
  - `200` — healthy.
  - `401` — missing / bad bearer.

Health requires auth intentionally: an unauthenticated probe would be a
browser-origin side-channel and would defeat the CVE-22812 mitigation
strategy documented in
[`engine/SECURITY.md`](../engine/SECURITY.md) §3.1.

## SSE event envelope

Each SSE frame wraps one `AgentEvent` from the 15-variant union
(`session.started`, `agent.message`, `tool.called`, …). The full schema
lives in [`docs/event-stream.md`](event-stream.md) and the types in
[`engine/src/events.ts`](../engine/src/events.ts).

```
id: 42
event: event
data: {"type":"agent.message","session_id":"01J...","seq":42,"ts":1712970000000,"delta":"hello","final":false}

```

- `id:` — the monotonic `seq` on the underlying `AgentEvent`. Clients
  supply it back as `Last-Event-Id` to resume mid-stream.
- `event: event` — every normal event uses this literal name. A
  discriminated value is in `data.type`.
- `event: done` — terminal frame. `data` is
  `{"status":"completed"|"cancelled"|"failed"}`.
- `event: error` — emitted if the stream itself errors (as opposed to the
  run emitting an `AgentEvent` of type `session.error`). `data` is
  `{"message": "..."}`. Rare; indicates a JSONL-replay fallback failure.

The stream never pauses — consumers that need keep-alive can read the
`stream.ping` variant in the `AgentEvent` union (emitted every 10s by the
engine's heartbeat).

## Error response shape

All JSON error responses share a minimal envelope:

```json
{"error":"<code>","...":"optional per-code fields"}
```

| HTTP | `error`           | Extra fields        | Cause |
|------|-------------------|---------------------|-------|
| 400  | `bad_request`     | `issues: ZodIssue[]` | Body failed zod `safeParse`. `issues` is the zod error array verbatim (path + message + code). |
| 401  | `unauthorized`    | _(none)_            | Missing, malformed, or non-matching `Authorization: Bearer` header. |
| 404  | `run_not_found`   | _(none)_            | `:id` is unknown to the `RunManager`. |
| 409  | `run_terminal`    | `status: RunStatus` | Steer requested on a run that has already moved to `completed` / `cancelled` / `failed`. `status` is the current terminal status. |
| 500  | `internal`        | `message: string`   | Uncaught handler error. `message` is `err.message` (already scrubbed by the security layer; see [`docs/rate-limit-and-scrub.md`](rate-limit-and-scrub.md)). |

Clients should switch on `error` (stable) rather than HTTP status alone.

## Graceful shutdown

On `SIGTERM` / `SIGINT`:

1. The HTTP listener stops accepting new connections.
2. New `POST /v1/runs` requests are refused with `503 Service Unavailable`
   (the run manager refuses `create()` during shutdown).
3. Active runs are given up to **30 seconds** to reach a terminal state.
   In-flight SSE streams continue to receive events during the grace
   window.
4. After 30s, remaining runs are aborted via their `AbortController`, their
   SSE streams are closed with `event: done` `{"status":"cancelled"}`, and
   the process exits 0.

The 30s grace is not configurable in Phase 10.02. Override is tracked for
Phase 10.03 if operators demonstrate real need.

## Phase 10.02 limitations

The HTTP surface is complete and contract-stable, but the engine loop
behind it is still the Phase-0 stub:

- **Event pumping is echo-style.** A `POST /v1/runs` currently produces a
  `session.started` event, one `agent.message` that echoes the prompt, and
  a `session.completed` frame. Real tool calls, thinking blocks, and
  subagent events land in Phase 10.03+ as the engine loop is wired through.
- **Steer is queued but not yet consumed.** `POST /v1/runs/:id/steer`
  returns `202` and the text is enqueued on the run entry, but the stub
  engine loop does not yet read the queue. Genie integrations wiring
  steer today will observe the 202 but no behavior change until 10.03.
- **`--wish-id` idempotency is not enforced over HTTP.** The CLI path
  checks the wish ledger (see [`docs/sessions.md`](sessions.md)); the
  HTTP route accepts `wishId` but does not yet consult the ledger.
- **Resume replays but does not rehydrate.** `POST /v1/runs/:id/resume`
  creates a new run with the same `sessionId`, but full state rehydration
  from the JSONL log is Phase 10.03's deliverable (shared with
  `jellyclaw run --resume` — see `docs/cli.md` §limitations).

These are surfaced as loud stderr warnings when the stub loop runs; they
do not affect the contract the routes document here.

## Genie compatibility

The Genie dispatcher currently spawns `claurst` (or `jellyclaw run`) as a
subprocess and consumes stream-JSON on stdout. The long-lived daemon path
(POST `/v1/runs` against a warm `jellyclaw serve`) is documented in
[`integration/GENIE-INTEGRATION.md`](../integration/GENIE-INTEGRATION.md)
§4 and activates in W3 of the migration plan.

Compatibility choices that drove this document:

- **`OPENCODE_SERVER_PASSWORD`** is retained as the primary env var name
  (in addition to the jellyclaw-native `JELLYCLAW_TOKEN`). The Genie
  dispatcher sets this variable today; flipping the default engine does
  not require a dispatcher change.
- **Default port `8765`** matches the port documented in the Phase 10
  design spec and the Genie LaunchAgent example (which additionally
  supports `7433` for warm-worker-pool deployments — the port is a
  configuration choice, not a contract).
- **Bearer token is session-scoped.** Restarting the daemon rotates the
  token; the Genie dispatcher reads the new token from stderr on start.

## Security

- Threat model and defense-in-depth stack:
  [`engine/SECURITY.md`](../engine/SECURITY.md).
- Bind-safety design:
  [`patches/002-bind-localhost-only.design.md`](../patches/002-bind-localhost-only.design.md).
- Secret scrubbing on tool results (applies to events delivered over SSE):
  [`docs/rate-limit-and-scrub.md`](rate-limit-and-scrub.md).
- Permission model enforced before any tool runs over SSE:
  [`docs/permissions.md`](permissions.md).

Report suspected vulnerabilities to `security@gtru.xyz`; see
[`engine/SECURITY.md`](../engine/SECURITY.md) §4 for the incident-response
process.
