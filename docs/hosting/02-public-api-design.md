# 02 — Public, multi-tenant HTTP/SSE API design

> Status: **design proposal**, Agent 2 of the hosting workstream. Grounded in
> `engine/src/server/*` (Phase 10.02/10.5), the `AgentEvent` union in
> `engine/src/events.ts`, and the invocation contract in `engine/SPEC.md` §3.
> Consumed by Agent 1 (Fly.io deployment) and Agent 5 (dashboard UX).

---

## TL;DR (the picks, in 8 lines)

1. **Auth: hybrid.** Default managed-key tier with daily $ quota; BYOK endpoint path lifts the quota and routes traffic through the caller's own `ANTHROPIC_API_KEY`. Opinionated: no "BYOK-only" launch — it strands the end-user persona.
2. **Identity: API keys + magic-link email auth.** Tokens are `jk_live_` / `jk_test_` prefixed, 32-byte secret body, stored as `argon2id` hashes. Magic link lands users in a key-minting dashboard; no password.
3. **Session model: first-class `/v1/threads` (stateful) with a thin `/v1/runs` one-shot built on top.** One-shot is `POST /v1/threads` with `ephemeral: true` — same wire, same event stream, no orphan code path.
4. **Streaming: SSE only.** No NDJSON fork — the existing `streamSSE`/`Last-Event-Id` replay machinery is already the good answer. HTTP/2 through Fly's proxy; Fly's 60-second idle timeout is defeated by the existing `stream.ping` AgentEvent every 10s.
5. **Resumption: exact.** `Last-Event-Id: <seq>` replays from the in-memory ring; falls back to the JSONL transcript that already exists at `~/.jellyclaw/sessions/<project>/<sid>.jsonl`.
6. **MCP config: per-request, declarative, sandboxed.** `mcp` array in the request body; stdio child spawned in a per-run scratch dir with CPU/mem/time limits and no home-dir mount.
7. **Rate limits: three tiers (anon / free / paid) + BYOK-unmetered.** All limits surfaced in `X-RateLimit-*` headers and the 429 body. Model-specific $ weights — Opus costs N× Haiku.
8. **Migration: small.** A single `AuthProvider` interface introduced in front of `auth.ts` unlocks the multi-tenant path without rewriting routes. Estimated ~600 LOC net new across `engine/src/server/{auth,tenancy,billing}/*`; zero breaking changes to the existing bearer path (retained as the "self-hosted" `AuthProvider.bearer`).

---

## 1. Auth model — the decision

### 1.1 Decision: **hybrid tier**

- **Tier A — Anonymous (no signup):** IP-keyed, 20 req/day, Haiku only, no MCP,
  no BYOK. Exists solely so a curl demo works from a landing page.
- **Tier B — Free (magic-link signup):** account-keyed, 200 req/day, all
  models, MCP allowed, managed Anthropic key (we eat the cost). Purpose:
  conversion funnel for the end-user persona.
- **Tier C — Paid (Stripe-metered):** account-keyed, soft daily cap you can
  raise in the dashboard, full model mix, Stripe meters tokens × model
  multiplier. This is the revenue path.
- **Tier D — BYOK:** a request that includes `x-anthropic-api-key: sk-ant-...`
  bypasses our managed key entirely and is **only** metered against jellyclaw
  infra (req/min for CPU + MCP-child spawn), never against a $ budget. The
  header value is forwarded verbatim to Anthropic and never persisted.

### 1.2 Why hybrid (not BYOK-only, not managed-only)

| Option | Who it fails | Why |
|---|---|---|
| BYOK-only | End users | Requires Anthropic account + $. Dead on arrival for "chat-style experience without paying." |
| Managed-only | Builders | We'd burn money on runaways while builders who'd happily pay with their own key can't scale past our cap. |
| **Hybrid** | Nobody | End users sign in with email and get a free tier. Builders either stay on a metered paid plan OR flip to BYOK via a single header. One codebase, one request shape. |

### 1.3 Why NOT "plug your key to lift the limit" per request for Tier B

Because the billing boundary becomes ambiguous — if a free-tier user sometimes
includes BYOK, the $ accounting gets confusing. Cleaner rule: **BYOK is per-key,
per-organization**, set in the dashboard or via header, and flips the whole
request onto the unmetered path. If the header is present, the managed key is
not loaded.

---

## 2. Session + run lifecycle

### 2.1 Vocabulary (unchanged from engine internals)

- **Thread** — long-lived conversation, stable id across turns. Maps 1:1 to
  the engine's existing `sessionId` (`engine/src/server/types.ts:54`).
- **Run** — one turn within a thread. Maps 1:1 to `RunEntry.runId`
  (`engine/src/server/types.ts:52`).
- **Event** — one `AgentEvent`. Same 23-variant union as today
  (`engine/src/events.ts`), unchanged. Already has `seq` / `session_id` /
  `ts` — no envelope re-design needed.

### 2.2 Lifecycle

```
                   POST /v1/threads
                           │
                           ▼
                   ┌───────────────┐
                   │  thread_id    │         ephemeral:true ?
                   │   status:     │─── yes ─► return when first done frame fires
                   │   "running"   │
                   └───────┬───────┘         no
                           │                  │
                           ▼                  ▼
              GET /v1/threads/:id/events  POST /v1/threads/:id/messages
              (SSE, resumable)            (queues next turn)
                           │
                           ▼
              done:{status:"completed"}
```

### 2.3 One-shot ↔ stateful: same endpoint, same code path

The `ephemeral: true` bit is the only difference. When true:

- No row in the `threads` table (in-memory lifecycle, GC on done).
- Response of `POST /v1/threads` holds the SSE stream open inline —
  client doesn't need a second GET. Equivalent to Replicate's
  `Prefer: wait=<n>` shortcut.
- Billing still applies.

When false (default):

- Persisted in `threads` + `events` (JSONL transcript path unchanged).
- Client subscribes to `GET /v1/threads/:id/events` and sends follow-ups
  via `POST /v1/threads/:id/messages`.

### 2.4 Resume semantics

All reconnects use standard SSE `Last-Event-Id: <seq>`. The server:

1. Drains events with `id > Last-Event-Id` from the in-memory ring buffer
   (`RunEntry.buffer`, already implemented).
2. Falls back to the JSONL log on buffer-miss (also already implemented —
   `engine/src/server/routes/runs.ts:131-140`).
3. If the run is already terminal, replays since `Last-Event-Id` and closes
   with the `done` frame.

**No change to the replay machinery.** The tenancy layer only adds a check
that the thread belongs to the caller's org.

---

## 3. Complete v1 endpoint table

All paths under `/v1`. Auth required unless marked. "Tier" is the minimum
tier that may call; higher tiers inherit.

| # | Method | Path | Auth | Stream | Tier | Rate limit key | Purpose |
|---|---|---|---|---|---|---|---|
| 1 | POST | `/v1/threads` | ✓ | SSE (when `ephemeral`) | anon+ | `acct:runs` | Create thread (maybe one-shot). |
| 2 | GET | `/v1/threads` | ✓ | — | free+ | `acct:reads` | List caller's threads. |
| 3 | GET | `/v1/threads/:id` | ✓ | — | anon+ | `acct:reads` | Thread summary. |
| 4 | DELETE | `/v1/threads/:id` | ✓ | — | free+ | `acct:reads` | Delete (revokes transcript). |
| 5 | GET | `/v1/threads/:id/events` | ✓ | SSE | anon+ | `acct:sse` | Resumable event stream. |
| 6 | POST | `/v1/threads/:id/messages` | ✓ | — | anon+ | `acct:runs` | Next user turn. |
| 7 | GET | `/v1/threads/:id/messages` | ✓ | — | anon+ | `acct:reads` | Transcript hydrate. |
| 8 | POST | `/v1/threads/:id/cancel` | ✓ | — | anon+ | — | Cancel active run. |
| 9 | GET | `/v1/threads/:id/permissions/pending` | ✓ | — | anon+ | `acct:reads` | Queued permission prompts. |
| 10 | POST | `/v1/threads/:id/permissions/:permId` | ✓ | — | anon+ | `acct:reads` | Reply once/always/reject. |
| 11 | GET | `/v1/models` | ✓ | — | anon+ | `acct:reads` | Available models + $ weights. |
| 12 | GET | `/v1/mcp/tools` | ✓ | — | free+ | `acct:reads` | Tools available per live MCP registry. |
| 13 | POST | `/v1/mcp/config/validate` | ✓ | — | free+ | `acct:reads` | Dry-run a user MCP config. |
| 14 | GET | `/v1/usage` | ✓ | — | free+ | `acct:reads` | Current-period usage + limits. |
| 15 | GET | `/v1/health` | — | — | — | — | Public liveness. |
| 16 | POST | `/v1/auth/magic-link` | — | — | — | `ip:auth` | Send sign-in email. |
| 17 | POST | `/v1/auth/verify` | — | — | — | `ip:auth` | Exchange one-time code for session. |
| 18 | POST | `/v1/auth/refresh` | refresh-token | — | — | `ip:auth` | Rotate session JWT. |
| 19 | POST | `/v1/keys` | ✓ (JWT) | — | free+ | `acct:reads` | Mint an API key. |
| 20 | GET | `/v1/keys` | ✓ (JWT) | — | free+ | `acct:reads` | List keys (prefix-only). |
| 21 | DELETE | `/v1/keys/:id` | ✓ (JWT) | — | free+ | `acct:reads` | Revoke. |
| 22 | GET | `/v1/me` | ✓ | — | free+ | `acct:reads` | Current account + tier. |
| 23 | POST | `/v1/billing/portal` | ✓ (JWT) | — | paid+ | — | Stripe portal session URL. |

Note: admin-scoped endpoints (signup moderation, server-wide metrics) are out
of scope — they live under `/admin/v1/*` on a separate app mount, behind an
internal-only auth provider, and are described in Agent 5's dashboard spec.

---

## 4. Per-endpoint details

Shared request conventions:
- `Content-Type: application/json` unless noted.
- `Authorization: Bearer jk_live_...` for API-key endpoints; `Authorization:
  Bearer <JWT>` for dashboard endpoints. The auth middleware detects which
  by token prefix.
- Every response carries `X-Request-Id` (already implemented,
  `engine/src/server/app.ts:67`).

### 4.1 `POST /v1/threads` — create (and maybe stream) a thread

Request schema (TypeScript):

```ts
import { z } from "zod";

const McpServerRef = z.discriminatedUnion("transport", [
  z.object({
    transport: z.literal("stdio"),
    name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    command: z.string().min(1),
    args: z.array(z.string()).max(32).optional(),
    env: z.record(z.string(), z.string()).optional(),
    connectTimeoutMs: z.number().int().min(500).max(30_000).optional(),
  }),
  z.object({
    transport: z.literal("http"),
    name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
    oauth: z
      .object({
        clientId: z.string(),
        scope: z.string().optional(),
        authorizeUrl: z.string().url().optional(),
        tokenUrl: z.string().url().optional(),
      })
      .optional(),
  }),
  z.object({
    transport: z.literal("sse"),
    name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
]);

export const CreateThreadBody = z.object({
  prompt: z.string().min(1).max(64_000),
  model: z.enum(["haiku", "sonnet", "opus"]).default("sonnet"),
  system: z.string().max(32_000).optional(),
  maxTurns: z.number().int().min(1).max(64).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "plan", "bypass"]).default("default"),
  allowedTools: z.array(z.string().min(1)).max(128).optional(),
  ephemeral: z.boolean().default(false),
  mcp: z.array(McpServerRef).max(8).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  // BYOK routing (alternative to the header form).
  anthropicApiKey: z.string().startsWith("sk-ant-").optional(),
  clientRequestId: z.string().uuid().optional(), // idempotency
}).strict();
```

JSON example (stateful, no stream inline):

```json
{
  "prompt": "Summarize the top comments on hn.algolia.com/?q=llm",
  "model": "sonnet",
  "system": "You are terse.",
  "maxTurns": 6,
  "permissionMode": "default",
  "allowedTools": ["WebFetch", "Bash(curl:*)"],
  "mcp": [
    {
      "transport": "stdio",
      "name": "brave",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": { "BRAVE_API_KEY": "br-..." }
    }
  ]
}
```

Response (stateful, `ephemeral: false`):

```json
{
  "thread_id": "thr_01JXH9Z3M4K8PZ6YJ2YFWGR2VC",
  "run_id": "run_01JXH9Z3M4K8PZ6YJ2YFWGR2VC",
  "status": "running",
  "stream_url": "/v1/threads/thr_01JXH9Z3M4K8PZ6YJ2YFWGR2VC/events",
  "created_at": 1713312045123,
  "usage_estimate_usd": 0.0012
}
```

Response (ephemeral, `ephemeral: true`): `200 OK`, `Content-Type: text/event-stream`.
The thread id + run id are pushed as the first synthetic frame:

```
id: 0
event: thread
data: {"thread_id":"thr_...","run_id":"run_..."}

id: 1
event: event
data: {"type":"session.started","session_id":"thr_...","seq":1,...}

```

curl example:

```bash
curl -sN https://api.jellyclaw.com/v1/threads \
  -H "Authorization: Bearer $JELLY_KEY" \
  -H "Content-Type: application/json" \
  -H "x-anthropic-api-key: $ANTHROPIC_API_KEY"   # optional BYOK \
  -d '{"prompt":"hello","model":"sonnet","ephemeral":true}'
```

Status codes:
- `201 Created` — stateful thread created.
- `200 OK` (SSE) — ephemeral stream opened.
- `400 bad_request` — zod failure (`issues` present).
- `401 unauthorized` — bad bearer.
- `402 payment_required` — over daily $ cap and BYOK not provided.
- `403 forbidden` — tier does not permit the requested feature (e.g., MCP on
  anon tier).
- `429 too_many_requests` — per-key / per-model rate limit hit.

### 4.2 `GET /v1/threads/:id/events` — resumable SSE

Same frame format as today (`engine/src/server/routes/runs.ts:122-159`):

```
id: 42
event: event
data: {"type":"agent.message","session_id":"thr_...","seq":42,"ts":1713312060000,"delta":"hi","final":false}

id: 43
event: event
data: {"type":"usage.updated","session_id":"thr_...","seq":43,"input_tokens":1200,"output_tokens":48,...}

id: done
event: done
data: {"status":"completed"}

```

Headers:
- `Cache-Control: no-store` (added).
- `X-Accel-Buffering: no` (added — defeats any reverse-proxy buffering).
- `Content-Type: text/event-stream`.

Request headers honored:
- `Last-Event-Id: <seq>` — replay from `seq+1`. Already implemented.
- `Accept: text/event-stream` — informational.

curl:

```bash
curl -sN https://api.jellyclaw.com/v1/threads/thr_01JXH.../events \
  -H "Authorization: Bearer $JELLY_KEY" \
  -H "Last-Event-Id: 42"
```

Status codes: `200` stream opened · `401` · `404` `thread_not_found` · `403`
`thread_forbidden` (belongs to another org).

### 4.3 `POST /v1/threads/:id/messages` — next user turn

Request:

```json
{ "text": "focus on the second paragraph only" }
```

Zod:

```ts
export const PostMessageBody = z.object({
  text: z.string().min(1).max(64_000),
  clientRequestId: z.string().uuid().optional(),
}).strict();
```

Response: `202 Accepted` with `{ "run_id": "run_01JXH..." }` (a new run id
inside the same thread). Semantics are the `steer` call today
(`engine/src/server/routes/messages.ts:53-80`) — already queued through the
`UserPromptSubmit` hook.

Status codes: `202` · `400` · `401` · `404` `thread_not_found` · `409`
`thread_terminal` with `{"status":"completed"|"cancelled"|"failed"}`.

### 4.4 `POST /v1/threads/:id/cancel`

Empty body, returns `202`, cancels via `AbortController`. Same semantics as
`/v1/runs/:id/cancel` today (`runs.ts:197-211`). Idempotent.

### 4.5 `GET /v1/threads/:id/permissions/pending` + `POST .../:permId`

Unchanged from `routes/permissions.ts`. The only addition: tenancy check on
`:id` before returning anything. Body schema unchanged:

```json
{ "response": "once" | "always" | "reject" }
```

### 4.6 `GET /v1/mcp/tools` — describe live tools

Returns namespaced tool list keyed by MCP server:

```json
{
  "servers": [
    {
      "name": "brave",
      "status": "ready",
      "tools": [
        {
          "name": "brave_web_search",
          "namespaced_name": "mcp__brave__brave_web_search",
          "description": "Search the web via Brave Search.",
          "input_schema": { "type": "object", "properties": {"q":{"type":"string"}} }
        }
      ]
    }
  ]
}
```

Two MCP-registry flavors are served:
- **Built-in** (shared across tenants) — `jellyclaw-serve` boot-time config,
  e.g. Playwright. Agent 4 owns Chrome MCP — **the design flag**: built-in
  MCP servers must declare an `allowedTiers` field, and `/v1/mcp/tools` only
  returns those the caller's tier permits.
- **Per-request** — when a request includes `mcp:`, the registry is live for
  that run only; no `/v1/mcp/tools` enumeration path for user-supplied MCP
  because they're opaque to the control plane.

### 4.7 `POST /v1/mcp/config/validate` — dry-run a user MCP config

Spawns the MCP child, waits for `initialize` → `tools/list`, returns the tool
catalog, then kills the child. 15s hard timeout. Used by the dashboard's
"Add MCP server" flow. No billing, just rate-limited.

```json
// request
{ "mcp": [ <McpServerRef> ] }

// response
{
  "ok": true,
  "tools": [{"server":"brave","tools":[...]}]
}
// or
{ "ok": false, "error": "mcp_spawn_failed", "reason": "command not found: npx" }
```

### 4.8 `GET /v1/models`

```json
{
  "models": [
    { "id":"haiku",  "name":"claude-haiku-4-7",  "weight_multiplier":1.0, "tiers":["anon","free","paid"] },
    { "id":"sonnet", "name":"claude-sonnet-4-7", "weight_multiplier":5.0, "tiers":["free","paid"] },
    { "id":"opus",   "name":"claude-opus-4-7",   "weight_multiplier":25.0,"tiers":["paid"] }
  ]
}
```

Consumers pass `"model": "sonnet"` in `POST /v1/threads`. Aliasing keeps the
wire stable across Anthropic model refreshes; the effective concrete model id
is logged but is an internal detail (rotated per release).

### 4.9 `GET /v1/usage` — current-period counts

```json
{
  "tier": "free",
  "period_start": 1713225600000,
  "period_end":   1713312000000,
  "reqs_used": 17,
  "reqs_limit": 200,
  "usd_used": 0.0342,
  "usd_limit": 1.00,
  "tokens": { "input": 45120, "output": 3204, "cache_read": 120000 },
  "by_model": {
    "haiku":  { "reqs": 4,  "usd": 0.0008 },
    "sonnet": { "reqs": 13, "usd": 0.0334 }
  }
}
```

### 4.10 Auth endpoints

`POST /v1/auth/magic-link`:

```json
// request
{ "email": "george@example.com", "redirect": "https://app.jellyclaw.com/signed-in" }
// response (always 200 — no enumeration oracle)
{ "sent": true }
```

`POST /v1/auth/verify`:

```json
// request  (token is the code from the email link)
{ "email": "george@example.com", "token": "724193" }
// response
{
  "access_token": "eyJhbGci...",     // JWT, 15 min
  "refresh_token": "rt_01JXH...",    // opaque, 30 days, rotating
  "expires_in": 900,
  "account_id": "acct_01JXH..."
}
```

`POST /v1/auth/refresh`:

```json
// header: Authorization: Bearer <refresh_token>
// response: same shape as /verify. Prior refresh token is revoked server-side.
```

JWT claims (HS256, secret per-region):

```json
{
  "sub":  "acct_01JXH...",
  "aud":  "jellyclaw.api",
  "iss":  "jellyclaw.auth",
  "tier": "free",
  "org":  "org_01JXH...",
  "exp":  1713328645,
  "iat":  1713327745,
  "jti":  "01JXHA..."
}
```

### 4.11 `POST /v1/keys` — mint an API key

```json
// request
{ "name": "prod-server", "scopes": ["threads:write","threads:read"] }
// response (the FULL key is returned exactly once)
{
  "id":      "key_01JXHB...",
  "prefix":  "jk_live_01JXHB",
  "key":     "jk_live_01JXHB_aZ9pQx...",   // full secret; show-once
  "created": 1713327745123
}
```

Subsequent `GET /v1/keys` never returns the secret — only `id`, `prefix`,
`created`, `last_used_at`. Revocation is `DELETE /v1/keys/:id` — the server
marks the row revoked and evicts the in-memory cache entry on all replicas
(pub/sub on Redis).

---

## 5. MCP config per request — schema + sandboxing

### 5.1 Wire shape

See §4.1 `McpServerRef`. Three transports: `stdio`, `http`, `sse`. Directly
mirrors `engine/src/mcp/types.ts` so the existing `McpRegistry` consumes the
body with one mapping function.

### 5.2 Request-scoped `McpRegistry`

Today the registry is boot-scoped (`engine/src/cli/serve.ts:348-358`). For
multi-tenant we introduce a **request-scoped shadow registry** that inherits
the built-in registry's live clients and overlays per-request user servers:

```ts
interface RequestMcp {
  readonly builtin: McpRegistry;   // shared, boot-time
  readonly user: McpRegistry;      // ephemeral, spawned per-run
  readonly merged: McpRegistry;    // union, user overrides on name collision
}
```

The user registry is started during `RunManager.create(...)` and stopped when
the run enters a terminal state. Lifetime is bounded by the run.

### 5.3 Sandboxing — stdio MCP children

Every user-spawned `stdio` MCP child is subjected to:

| Control | Value | Enforced by |
|---|---|---|
| `ulimit -v` (address space) | 1 GiB | `posix_spawn` wrapper |
| `ulimit -t` (CPU seconds) | 30 | `posix_spawn` wrapper |
| `ulimit -n` (open FDs) | 256 | `posix_spawn` wrapper |
| `ulimit -u` (processes) | 16 | `posix_spawn` wrapper |
| Wall-clock timeout | 2 min idle / 15 min absolute | registry watchdog |
| CWD | `/run/jellyclaw/mcp/<run_id>/` (tmpfs) | spawn wrapper |
| `$HOME` | `/run/jellyclaw/mcp/<run_id>/home` (empty) | spawn env |
| Network | allowed (MCP servers legitimately need it) | — |
| Syscalls | seccomp-bpf denylist: `ptrace`, `mount`, `unshare`, `kexec_load` | Linux wrapper |
| User namespace | Fly machine runs as uid 1000 inside a gVisor-like runtime | Fly + custom |

On macOS/dev the wrapper degrades: `ulimit` best-effort, no seccomp. The
production sandbox gate is in `engine/src/mcp/spawn-sandbox.ts` (**new
module** — Phase 11.01 deliverable).

### 5.4 What's NOT sandboxed (by design)

- `http` / `sse` MCP transports — they're outbound fetches. The threat is
  SSRF: user gives us `url: "http://169.254.169.254/..."` (AWS IMDS). We
  apply the same webfetch denylist as the engine (see SPEC §14): link-local,
  RFC1918, loopback refused unless the user is on BYOK.

### 5.5 Chrome MCP — flagged, not designed

Per the task brief, **Chrome MCP is Agent 4's territory.** One flag: the
sandbox profile above assumes stdio MCP servers are plain subprocesses.
Chrome spawns a full browser; it needs a fatter quota and likely a distinct
runtime (Fly machine with a bigger image, or an out-of-band service the API
calls into). The `/v1/mcp/tools` contract absorbs both — Chrome just appears
as `mcp__chrome__*` tools. Coordinate the resource-limit numbers with Agent 4.

### 5.6 Secret scrubbing on MCP

Values in `env` and `headers` are already treated as secrets by
`engine/src/mcp/credential-strip.ts`. The multi-tenant layer adds one rule:
`env` values are NEVER echoed back to the caller anywhere — not in
`/v1/mcp/tools`, not in `/v1/usage`, not in error bodies. The
`credential-strip` module handles stderr/stdout; we extend it with an HTTP
redactor before 500 `message` fields are emitted.

---

## 6. Rate limits + quotas

### 6.1 Tier matrix

| Tier | Sign-up | req/day | req/min | concurrent runs | Models | MCP | BYOK | Daily $ cap |
|---|---|---|---|---|---|---|---|---|
| **Anon** | no (IP-keyed) | 20 | 5 | 1 | haiku | no | no | $0.05 hard |
| **Free** | magic link | 200 | 20 | 3 | haiku, sonnet | yes | yes | $1.00 soft |
| **Paid** | Stripe card | 10 000 | 120 | 10 | all | yes | yes | $100 configurable |
| **BYOK** | any signed-in tier with header/flag | ∞ (infra-bounded) | 300 | 20 | all | yes | — | — |

`infra-bounded` = 300 req/min per key + 20 concurrent runs = hard ceiling from
our CPU budget, not an Anthropic $ budget.

### 6.2 Model weights (paid tier)

Every token is accounted at `tokens × weight_multiplier` and converted to a $
figure at our published rate (published in `/v1/models`). Weights track
Anthropic's headline prices with a ~20% markup:

- `haiku` = 1.0×
- `sonnet` = 5.0×
- `opus` = 25.0×

### 6.3 Enforcement — reuse the existing token bucket

`engine/src/ratelimit/token-bucket.ts` already ships. We reuse it with three
new keys:

- `acct:<acct_id>:runs` — min window (e.g. 20/min free).
- `acct:<acct_id>:usd:day` — continuous, refills at `usd_limit/86400 per s`,
  `capacity = usd_limit`. When a run finishes we charge `cost_usd` by
  `acquire(cost_usd)`. Rejection → 402 `payment_required`.
- `ip:<ip>:anon` — anon-tier key; LRU evicted.

### 6.4 Upstream cap — not exhausting Anthropic

We hold **one** organizational Anthropic API key. Anthropic's per-org TPM
cap is the real ceiling. Enforcement:

- A global token bucket (`global:anthropic:tpm`) dimensioned at 80% of the
  org's published limit. Every request `acquire(est_input_tokens +
  max_tokens)` before calling Anthropic. Rejection → 503 with
  `Retry-After` and `x-jellyclaw-upstream-saturation: true`.
- BYOK requests bypass this bucket entirely — they're not our org.
- Per-model sub-buckets (`global:anthropic:opus:tpm`) so a pile of Opus
  requests doesn't starve Haiku callers.

### 6.5 Response headers (every /v1/threads-family response)

```
X-RateLimit-Limit:           200
X-RateLimit-Remaining:       183
X-RateLimit-Reset:           1713345600     # epoch seconds
X-RateLimit-Window:          86400           # seconds
X-Jellyclaw-Tier:            free
X-Jellyclaw-Model-Weight:    5.0
X-Jellyclaw-Usd-Remaining:   0.96
```

### 6.6 429 body shape

```json
{
  "error": "rate_limited",
  "scope": "acct:runs" | "acct:usd:day" | "ip:anon" | "global:anthropic:opus:tpm",
  "retry_after_ms": 4200,
  "limit": 20,
  "window": "1m",
  "message": "20 req/min free-tier limit reached. Upgrade or wait 4.2s."
}
```

### 6.7 402 body shape (over daily $)

```json
{
  "error": "payment_required",
  "usd_used": 1.01,
  "usd_limit": 1.00,
  "reset_at": 1713398400,
  "upgrade_url": "https://app.jellyclaw.com/billing",
  "byok_accepted": true,
  "message": "Free-tier $ cap reached. Add BYOK via x-anthropic-api-key or upgrade."
}
```

---

## 7. Streaming semantics

### 7.1 Protocol: SSE

- `text/event-stream`, chunked, HTTP/1.1 or HTTP/2 (Fly's proxy supports
  both; we advertise `Alt-Svc: h2=":443"`).
- Frames are SSE with three event names:
  - `event: event` — data is one `AgentEvent` JSON.
  - `event: done` — data is `{"status":"completed"|"cancelled"|"failed"}`.
  - `event: error` — data is `{"code":"...", "message":"..."}`. Terminal.
- Extra reserved event:
  - `event: thread` — emitted once at stream start in ephemeral mode (§4.1).

No NDJSON variant. A builder who wants plain JSON lines can pipe SSE through a
3-line shell filter; we don't fork the server.

### 7.2 HTTP/2 — yes, with care

Fly terminates TLS and speaks HTTP/2 to the origin when possible. SSE over
HTTP/2 is fine if we avoid `Transfer-Encoding: chunked` (illegal in H2).
Hono's `streamSSE` already works correctly here.

HTTP/3 — **not in v1**. Fly doesn't proxy HTTP/3 to the origin yet (as of the
last deployment window this hosting spec was drafted for). Pick it up when
Fly ships it.

### 7.3 Reconnection

1. Client opens `GET /v1/threads/:id/events`. Receives frames, remembers
   `Last-Event-Id` from each frame's `id:` line.
2. Network blip. Client auto-retries after SSE `retry:` (we send
   `retry: 3000\n` at stream open).
3. Reconnect with `Last-Event-Id: <n>`.
4. Server replays from `n+1` as described in §2.4.

### 7.4 Idle timeouts — Fly + SSE

Fly's edge idle timeout is **60 seconds of no bytes through the socket**. The
existing `stream.ping` AgentEvent is already emitted every 10 s by the engine
heartbeat — that's below 60 s, so connections don't time out. Add a belt-and-
braces SSE comment frame (`: keepalive\n\n`) every 20 s in `streamSSE` for the
(rare) case the engine heartbeat pauses.

Fly also enforces a 24-hour maximum connection duration. Clients that need
longer subscriptions must reconnect and supply `Last-Event-Id` — which is
already the semantics we document.

### 7.5 Cancellation protocol

Two paths:

1. **Client disconnect** — `c.req.raw.signal.aborted` triggers the run's
   `AbortController.abort()` after a 5 s grace (5 s because the client might
   be reconnecting; see §7.3). Already partial in
   `engine/src/server/routes/events.ts:53-60` — we just wire the
   disconnect → abort link in `run-manager.ts`.
2. **Explicit POST `/v1/threads/:id/cancel`** — synchronous call that flips
   the abort, returns `202`. Open SSE subscribers receive a
   `session.error{recoverable:false, code:"cancelled"}` frame and then the
   terminal `done` frame.

---

## 8. Error model

### 8.1 Shared envelope

Every error response — JSON **and** mid-SSE — is:

```ts
export const ErrorEnvelope = z.object({
  error: z.string(),                         // stable machine code
  message: z.string().optional(),            // human, already scrubbed
  request_id: z.string().optional(),         // echo of X-Request-Id
  issues: z.array(z.unknown()).optional(),   // zod, when error === "bad_request"
  details: z.record(z.string(), z.unknown()).optional(), // per-code
});
```

Stable codes:

| HTTP | `error` | Extra | When |
|---|---|---|---|
| 400 | `bad_request` | `issues[]` | zod parse failure |
| 401 | `unauthorized` | — | missing/invalid bearer |
| 402 | `payment_required` | `usd_used,usd_limit,reset_at` | over tier $ cap |
| 403 | `forbidden` | `scope` | tier doesn't allow feature |
| 404 | `thread_not_found` \| `run_not_found` \| `key_not_found` | — | id unknown to tenant |
| 409 | `thread_terminal` | `status` | steer on done thread |
| 413 | `payload_too_large` | `limit` | body > 256 KB |
| 415 | `unsupported_media_type` | — | non-JSON body |
| 422 | `mcp_spawn_failed` | `server,reason` | user MCP config unreachable |
| 429 | `rate_limited` | `scope,retry_after_ms` | see §6.6 |
| 451 | `policy_blocked` | `policy` | tool use blocked by permissions |
| 499 | `client_closed_request` | — | client aborted mid-stream |
| 500 | `internal` | `message` | unexpected |
| 502 | `upstream_error` | `upstream` | Anthropic 5xx |
| 503 | `service_unavailable` | `retry_after_ms` | shutdown or org-wide cap |
| 504 | `upstream_timeout` | `upstream` | Anthropic >60 s |

### 8.2 Streaming errors mid-SSE

Already partially specified (`docs/http-api.md:438-442`). The final form:

```
id: 99
event: error
data: {"error":"upstream_error","request_id":"01JXH...","upstream":"anthropic","message":"5xx from provider","details":{"status":502}}

id: done
event: done
data: {"status":"failed"}

```

Contract: `event: error` is always followed by `event: done` with
`"failed"`. Clients that see `error` should NOT retry the same thread — they
should surface the error and let the user decide to start a new thread.

### 8.3 Engine-level errors are `AgentEvent`, NOT SSE errors

`session.error` is an `AgentEvent` variant that rides as `event: event` like
any other. It represents "the agent loop hit a recoverable problem" — e.g. a
tool returned malformed output. The SSE-level `event: error` is reserved for
"the stream itself broke": replay fallback failed, upstream provider 5xx,
tenancy check failed mid-stream. Do not collapse these.

---

## 9. Observability

### 9.1 Correlation

Already implemented (`engine/src/server/app.ts:67-72`):

- `X-Request-Id` in/out — UUID generated if not present.
- Log field `requestId` on every line.

Extension for multi-tenant:

- `X-Jellyclaw-Account-Id` emitted on responses (debug aid).
- Log fields: `accountId`, `orgId`, `tier`, `keyId`, `model`, `threadId`,
  `runId`, `byok` (bool).
- Never log: `access_token`, `refresh_token`, `apiKey`, MCP `env`/`headers`
  values, prompts, tool results. The logger redact list in
  `engine/src/logger.ts` already covers most of these; we extend it with
  `anthropicApiKey`, `x-anthropic-api-key`, `mcp[].env`, `mcp[].headers`.

### 9.2 Per-request log line (one line, structured)

```json
{
  "level":"info",
  "requestId":"01JXH...",
  "accountId":"acct_01JXH...",
  "tier":"free",
  "keyId":"key_01JXH...",
  "path":"POST /v1/threads",
  "status":201,
  "duration_ms":1824,
  "byok":false,
  "model":"sonnet",
  "threadId":"thr_01JXH...",
  "tokens":{"input":1200,"output":48,"cache_read":0,"cache_write":240},
  "cost_usd":0.00342,
  "mcp_calls":3,
  "mcp_servers":["brave"],
  "permission_grants":1,
  "permission_denies":0,
  "terminal_status":"completed"
}
```

### 9.3 Aggregated signals for the dashboard (Agent 5)

Two streams, both sourced from the per-request log:

1. **Real-time** — a Redis Stream (`events:acct:<id>`) populated by the
   request-end hook. Dashboard subscribes via WebSocket from Agent 5's web
   app. 24 h retention.
2. **Historical** — daily-rollup tables in Postgres:
   `usage_daily(acct_id, day, reqs, tokens_in, tokens_out, cost_usd,
   by_model jsonb)`. Feeds the `/v1/usage` endpoint and the billing pipeline.

### 9.4 Audit log (separate)

Permission grants/denies, key creations, magic-link verifications, BYOK
toggles → append-only `audit_log` table, 90-day retention. This is the SOC2
/ incident-response surface.

### 9.5 Health + metrics

- `GET /v1/health` unauthenticated (changed from today — a public health
  probe is normal for a managed service; it returns only `{ok:true,version}`
  with no run counts). The authenticated variant moves to
  `/v1/health/detail`.
- `GET /admin/metrics` — Prometheus format, internal-only, exposes
  `anthropic_tpm_used`, `active_runs_by_tier`, `mcp_children_alive`, etc.

---

## 10. Migration from today — concrete file:line + LOC

### 10.1 The load-bearing insight

The existing bearer auth at `engine/src/server/auth.ts:36-72` is **already**
an indirection layer — it takes `authToken` from `ServerConfig` and checks
equality. The multi-tenant path needs the same shape to return a richer
`Principal` object. So the migration is introduction of one interface and
two new implementations, not a rewrite.

### 10.2 Step-by-step

**1. Introduce `AuthProvider`** (new file: `engine/src/server/tenancy/auth-provider.ts`, ~120 LOC)

```ts
export interface Principal {
  readonly kind: "bearer" | "api_key" | "jwt" | "anon";
  readonly accountId: string;      // "anon:<ip-hash>" for anon
  readonly orgId: string;
  readonly tier: "anon" | "free" | "paid" | "byok";
  readonly keyId?: string;
  readonly scopes: readonly string[];
  readonly byok: { anthropicApiKey: string } | null;
}

export interface AuthProvider {
  authenticate(req: Request, ip: string): Promise<Principal | null>;
}
```

Three concrete impls:

- `BearerAuthProvider` — wraps today's constant-time compare. Returns
  a fixed `tier:"byok"` Principal so self-hosted single-user mode is
  unchanged. **This is the default when `JELLYCLAW_MODE=self-hosted` env
  is set** (or unset — self-hosted is the fallback).
- `MultiTenantAuthProvider` — checks API-key table, JWTs, or anon-IP
  bucket. Only loaded when `JELLYCLAW_MODE=managed`.
- `CompositeAuthProvider` — chains both, used only in tests.

**2. Replace the middleware wire-up**
(`engine/src/server/app.ts:87`, ~20 LOC changed)

```ts
// before:
app.use("*", createAuthMiddleware({ authToken: opts.config.authToken }));

// after:
app.use("*", createAuthMiddleware({ provider: opts.authProvider }));
```

The middleware itself changes from "compare token" to "call provider; set
`c.var.principal`". Old signature preserved with an adapter for the
self-hosted path. `auth.ts:36-72` grows by ~30 LOC; the constant-time
compare helper moves into `BearerAuthProvider` unchanged.

**3. Add `c.var.principal` to `AppVariables`**
(`engine/src/server/types.ts:141-144`, ~3 LOC)

```ts
export interface AppVariables {
  readonly authenticated: true;
  readonly requestId: string;
  readonly principal: Principal;  // NEW
}
```

Every route handler can now `c.get("principal")` — the tenancy check
(`principal.accountId` must own `threadId`) lives in `session-manager.ts`'s
`getSession` via a new `forAccount` filter.

**4. Tenancy filter on `RunManager.get` / `SessionManager.getSession`**
(`engine/src/server/run-manager.ts`, `session-manager.ts`, ~40 LOC)

Two new methods: `get(id, { accountId })` and `listSessions({ accountId })`.
Old overloads preserved for the self-hosted path (they pass a fixed
`accountId` resolved from the single-user Principal).

**5. Persist threads + events**
(`engine/src/server/tenancy/store.ts`, ~220 LOC; migrations ~40 LOC)

New Postgres tables:

```sql
CREATE TABLE accounts    (id text PRIMARY KEY, email text UNIQUE, tier text, created bigint, ...);
CREATE TABLE api_keys    (id text PRIMARY KEY, account_id text, prefix text, hash text, scopes jsonb, ...);
CREATE TABLE threads     (id text PRIMARY KEY, account_id text, model text, created bigint, last_seq int, ...);
CREATE TABLE usage_daily (account_id text, day date, reqs int, usd numeric, by_model jsonb, PRIMARY KEY (account_id, day));
CREATE TABLE audit_log   (id bigserial PRIMARY KEY, account_id text, action text, meta jsonb, at bigint);
```

The JSONL transcript stays — it's the SSE replay source and is cheap. We
mirror metadata into Postgres for list/filter queries.

**6. Mount new route files, keep the old ones**
(`engine/src/server/app.ts:89-113`, ~50 LOC new mounts)

New modules, each ~100–200 LOC:

- `routes/auth.ts` — magic-link + verify + refresh
- `routes/keys.ts` — key CRUD
- `routes/usage.ts` — `/v1/usage`
- `routes/models.ts` — `/v1/models`
- `routes/mcp.ts` — `/v1/mcp/tools` + validate
- `routes/billing.ts` — Stripe portal URL + webhook receiver (webhook at
  `/v1/billing/webhook`, bypasses auth, HMAC-verified)

The existing `routes/runs.ts` / `routes/sessions.ts` / `routes/messages.ts`
/ `routes/permissions.ts` / `routes/events.ts` are **kept** but rewired
under `/v1/threads/*` via re-exports. The old `/v1/runs` path is retained
for one minor version as an alias (marked deprecated in response headers:
`X-Deprecation: use /v1/threads instead`).

**7. BYOK header plumbing**
(`engine/src/providers/anthropic.ts`, ~15 LOC)

The provider already takes `apiKey` at construction. We add a `perRequest`
override in `CreateRunOptions`: `anthropicApiKey?: string`. Run manager
forwards it to provider factory. No change to cache-control logic — it
remains Anthropic-direct-only.

**8. Request-scoped MCP**
(`engine/src/server/run-manager.ts` + new `engine/src/mcp/request-registry.ts`,
~150 LOC)

See §5.2.

**9. Stripe integration**
(`engine/src/billing/stripe.ts` + `routes/billing.ts`, ~180 LOC)

Webhook receiver updates `accounts.tier`, `accounts.usd_limit`, writes an
`audit_log` row. Meter events batched every 60 s from a ring buffer (not
per-request — Stripe recommends batching).

### 10.3 LOC budget, summed

| Area | LOC net new |
|---|---|
| `tenancy/auth-provider.ts` + 3 impls | 280 |
| `tenancy/store.ts` + migrations | 260 |
| `mcp/request-registry.ts` + spawn-sandbox.ts | 220 |
| New route modules (auth, keys, usage, models, mcp, billing) | 900 |
| Modifications to existing routes (tenancy filter + deprecation headers) | 140 |
| `billing/stripe.ts` + meter batcher | 220 |
| Tests | 900 |
| **Total** | **~2 920 LOC** |

Not the "~600 LOC" the TL;DR mentions — that number is **the auth-layer
seam only**, which is the smallest-possible-change claim. Full managed-tier
buildout is ~3 KLOC. The self-hosted path is unaffected by any of it.

### 10.4 Breaking vs non-breaking

| Change | Semver |
|---|---|
| New endpoints under `/v1/*` | minor |
| New response headers (`X-RateLimit-*`, `X-Jellyclaw-*`) | minor |
| `AppVariables.principal` added | minor (internal) |
| `/v1/runs/*` → `/v1/threads/*` rename with deprecation alias | minor |
| `GET /v1/health` becomes unauthenticated | **major** for managed deploy; gated behind `JELLYCLAW_MODE=managed` to keep self-hosted compat |
| Bearer auth token no longer the only auth path | **major** — hidden behind the mode flag, so effectively additive |

Net: we ship 0.2.0 as "managed mode available, self-hosted unchanged." The
self-hosted bearer path is preserved verbatim; selecting managed mode at
boot is the only way to enable the new auth providers.

### 10.5 Sequence (a rough roadmap, not a schedule)

1. Auth-provider seam + tenancy filter (~500 LOC) — unblocks literally
   everything else.
2. Postgres store + key minting + magic link (~900 LOC).
3. Rate limiting + usage endpoints (~400 LOC) — reuse existing token bucket.
4. Request-scoped MCP + sandbox (~400 LOC).
5. Billing + Stripe (~300 LOC).
6. Deprecate `/v1/runs` alias → remove in 0.3.0.

---

## Appendix A — Full TS types (copy-paste ready)

```ts
// Shared
export type Tier = "anon" | "free" | "paid" | "byok";
export type ModelId = "haiku" | "sonnet" | "opus";
export type Scope = "threads:read" | "threads:write" | "mcp:write" | "billing:read";

export interface Principal {
  readonly kind: "bearer" | "api_key" | "jwt" | "anon";
  readonly accountId: string;
  readonly orgId: string;
  readonly tier: Tier;
  readonly keyId?: string;
  readonly scopes: readonly Scope[];
  readonly byok: { readonly anthropicApiKey: string } | null;
}

// Public responses
export interface ThreadCreatedResponse {
  readonly thread_id: string;
  readonly run_id: string;
  readonly status: "running";
  readonly stream_url: string;
  readonly created_at: number;
  readonly usage_estimate_usd: number;
}

export interface UsageResponse {
  readonly tier: Tier;
  readonly period_start: number;
  readonly period_end: number;
  readonly reqs_used: number;
  readonly reqs_limit: number;
  readonly usd_used: number;
  readonly usd_limit: number;
  readonly tokens: { readonly input: number; readonly output: number; readonly cache_read: number };
  readonly by_model: Readonly<Record<ModelId, { readonly reqs: number; readonly usd: number }>>;
}

// Error envelope (§8)
export interface ErrorBody {
  readonly error: string;
  readonly message?: string;
  readonly request_id?: string;
  readonly issues?: readonly unknown[];
  readonly details?: Readonly<Record<string, unknown>>;
}
```

## Appendix B — curl cheat-sheet (realistic payloads)

```bash
# 0. Anonymous probe
curl -sN https://api.jellyclaw.com/v1/threads \
  -H "Content-Type: application/json" \
  -d '{"prompt":"say hi","model":"haiku","ephemeral":true}'

# 1. Sign up via magic link
curl -s https://api.jellyclaw.com/v1/auth/magic-link \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
# → click email link → get token

curl -s https://api.jellyclaw.com/v1/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","token":"724193"}'
# → {"access_token":"eyJ...","refresh_token":"rt_...",...}

# 2. Mint API key (uses the JWT from above)
curl -s https://api.jellyclaw.com/v1/keys \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"name":"laptop","scopes":["threads:read","threads:write"]}'
# → {"id":"key_...","prefix":"jk_live_...","key":"jk_live_..._aZ9pQx..."}

# 3. Stateful thread with BYOK + MCP
curl -s https://api.jellyclaw.com/v1/threads \
  -H "Authorization: Bearer $JELLY_KEY" \
  -H "x-anthropic-api-key: $ANTHROPIC_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt":"Plan a week in Lisbon",
    "model":"sonnet",
    "mcp":[{"transport":"stdio","name":"brave","command":"npx","args":["-y","@modelcontextprotocol/server-brave-search"],"env":{"BRAVE_API_KEY":"'"$BRAVE"'"}}]
  }'
# → {"thread_id":"thr_...","run_id":"run_...","stream_url":"..."}

# 4. Subscribe to events (resumable)
curl -sN https://api.jellyclaw.com/v1/threads/thr_.../events \
  -H "Authorization: Bearer $JELLY_KEY" \
  -H "Last-Event-Id: 42"

# 5. Next turn
curl -s https://api.jellyclaw.com/v1/threads/thr_.../messages \
  -H "Authorization: Bearer $JELLY_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Actually, just the food scene."}'

# 6. Cancel
curl -s -X POST https://api.jellyclaw.com/v1/threads/thr_.../cancel \
  -H "Authorization: Bearer $JELLY_KEY"

# 7. Check usage
curl -s https://api.jellyclaw.com/v1/usage \
  -H "Authorization: Bearer $JELLY_KEY"
```

## Appendix C — Cross-references

- Existing contract: `docs/http-api.md` — **this design preserves every
  endpoint it documents** (with `/v1/runs/*` aliased under `/v1/threads/*`).
- Event schema: `engine/src/events.ts` — **unchanged**.
- SSE replay: `engine/src/server/routes/runs.ts:122-159` — **unchanged**.
- Auth middleware: `engine/src/server/auth.ts:36-72` — wrapped by the new
  `AuthProvider`, inner constant-time compare reused verbatim.
- Rate limiter: `engine/src/ratelimit/token-bucket.ts` — reused for the
  three new bucket keys.
- MCP client types: `engine/src/mcp/types.ts` — `McpServerRef` in §4.1 is a
  direct subset.
- Bind safety: unchanged — managed mode still binds loopback inside the Fly
  machine; the TLS edge is Fly's concern. `assertLoopback` stays.

---

**Last word.** The multi-tenant path is *not* a rewrite. The engine's event
stream is already a serialization boundary that a tenancy layer sits on top
of without touching. Introducing `AuthProvider` + `Principal` is the 80/20
move; the rest (Stripe, magic link, dashboard) is plain SaaS plumbing that
does not require engine changes.
