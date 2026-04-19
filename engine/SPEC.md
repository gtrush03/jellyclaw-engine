# jellyclaw — Engine SPEC

**Status:** Draft v2 (April 2026) — supersedes all prior specs
**Owner:** George Trushevskiy
**Repo root:** `/Users/gtrush/Downloads/jellyclaw-engine/`
**Package name:** `@jellyclaw/engine`
**Binary name:** `jellyclaw`

> **Naming note.** This project is called **jellyclaw** (one word). It is NOT "jelly-claw" (the video-calling app at `/Users/gtrush/Downloads/jelly-claw/`), "OpenClaw", or "Claw Code". The single-token name was chosen deliberately to avoid npm/GitHub/trademark collisions with the `jelly-claw` product name and the `claw` prefix cluster. The long-term goal is for jellyclaw to be embedded INSIDE jelly-claw as its Genie layer — see §21.

---

## 1. Project layout

```
/Users/gtrush/Downloads/jellyclaw-engine/
├── engine/                       # @jellyclaw/engine — Node/TS, CLI + library
│   ├── SPEC.md                   # this file
│   ├── CVE-MITIGATION.md         # security posture + CVE write-up
│   ├── src/
│   │   ├── cli.ts                # argv parsing, --print mode, streaming I/O
│   │   ├── session.ts            # OpenCode server lifecycle per invocation
│   │   ├── provider/
│   │   │   ├── anthropic.ts      # DEFAULT — direct Messages API
│   │   │   ├── openrouter.ts     # opt-in only, caching caveats documented
│   │   │   └── index.ts          # provider registry + factory
│   │   ├── plugin/
│   │   │   ├── sdk.ts            # hook contract (mirrors OpenCode plugin API)
│   │   │   └── subagent-shim.ts  # runtime half of issue #5894 mitigation
│   │   ├── cache/
│   │   │   └── breakpoints.ts    # cache_control insertion policy
│   │   ├── config/
│   │   │   ├── schema.ts         # zod schemas
│   │   │   └── loader.ts         # ~/.jellyclaw/config.json + env merging
│   │   ├── telemetry.ts          # opt-out-by-default stub
│   │   └── permissions.ts        # agent ruleset enforcement (subagent safe)
│   ├── patches/
│   │   └── opencode-subagent-hooks.patch   # issue #5894 patch
│   ├── bin/
│   │   └── jellyclaw             # shim → node dist/cli.js
│   └── package.json
├── desktop/                      # optional Electron/Tauri GUI shell (later)
├── integration/                  # jelly-claw bridge (Swift + Node IPC)
│   ├── swift/
│   │   └── JellyclawBridge.swift
│   └── node/
│       └── ipc-server.ts
├── docs/                         # rendered user-facing documentation
├── phases/                       # phased rollout plans (p1.md … p4.md)
├── skills/                       # bundled skill library (markdown)
├── agents/                       # agent preset definitions (YAML)
├── test/                         # integration + E2E tests
└── scripts/                      # dev/release tooling
```

The engine is intentionally self-contained in `engine/`. The `desktop/` and
`integration/` trees consume `@jellyclaw/engine` as a dependency; they do not
reach into its internals.

---

## 2. Goals and non-goals

**Goals.**
1. Drop-in replacement for `claude -p` as invoked by Genie's `dispatcher.mjs`.
   The contract is: read a prompt on stdin or `--prompt`, stream assistant
   output to stdout, exit 0 on success.
2. First-class Anthropic Messages API support with aggressive prompt caching.
3. OpenCode execution substrate for tools, skills, sub-agents, and MCP.
4. Pluggable provider layer so non-Anthropic models remain reachable via
   OpenRouter without compromising the Anthropic-direct hot path.
5. Embeddable: library-mode entrypoint for jelly-claw integration (§21).

**Non-goals.**
- We do NOT ship a TUI. The CLI is headless `--print`-style only.
- We do NOT re-implement Claude Code's UI layer.
- We do NOT fork OpenCode. We depend on it and ship a small patch set.

---

## 3. Invocation contract

```
jellyclaw [--prompt "<text>"] [--input-file path] [--config path]
          [--provider anthropic|openrouter] [--model id]
          [--session <id>] [--json] [--quiet] [--no-telemetry]
```

Streaming mode (Genie dispatcher default): prompt on stdin, NDJSON events on
stdout, human text to stderr. Exit codes: `0` success, `1` user error,
`2` provider/network error, `3` tool sandbox violation, `4` config invalid.

Minimal example:

```sh
echo "List the files in cwd and summarize" | jellyclaw --json
```

From Genie, `dispatcher.mjs` replaces `spawn("claude", ["-p", …])` with
`spawn("jellyclaw", ["--json"])`. No other call-site changes.

---

## 4. Runtime topology

```
┌────────────────────────────────────────────────────────────┐
│ jellyclaw CLI process                                      │
│  ┌──────────────┐   ┌────────────────┐   ┌──────────────┐  │
│  │  cli.ts      │──▶│  session.ts    │──▶│ provider/*   │  │
│  │  argv + I/O  │   │  OpenCode boot │   │ anthropic    │  │
│  └──────────────┘   │  plugin load   │   │ openrouter   │  │
│                     │  hook wiring   │   └──────┬───────┘  │
│                     └───────┬────────┘          │          │
│                             ▼                   ▼          │
│                     ┌────────────────┐   ┌──────────────┐  │
│                     │ OpenCode server│   │ Anthropic    │  │
│                     │ 127.0.0.1:rand │   │ api.anthropic│  │
│                     │ OPENCODE_PW    │   │ .com         │  │
│                     └───────┬────────┘   └──────────────┘  │
│                             ▼                              │
│         ┌─────────────┬──────────────┬─────────────┐       │
│         │ tools       │ skills       │ subagents   │       │
│         │ (fs, bash,  │ (markdown)   │ (task tool) │       │
│         │  playwright)│              │             │       │
│         └─────────────┴──────────────┴─────────────┘       │
└────────────────────────────────────────────────────────────┘
```

Every invocation boots a fresh OpenCode server on `127.0.0.1:<random-port>`
with a per-session random 32-byte hex `OPENCODE_SERVER_PASSWORD`. The server
is killed on CLI exit (finally block + `SIGTERM` then `SIGKILL` at 5s).

---

## 5. Plugin SDK and subagent hooks

jellyclaw surfaces OpenCode's plugin hook interface unchanged: `tool.execute.before`,
`tool.execute.after`, `chat.message`, `chat.params`, `auth.*`, `permission.ask`,
`event`. Plugins are TypeScript modules resolved from `~/.jellyclaw/plugins/*`
and `<repo>/.jellyclaw/plugins/*`, loaded at session boot.

### 5.1 Issue #5894 mitigation (subagent hook observability gap)

Original research assumed upstream OpenCode silently skipped
`tool.execute.before/after` for tools called from within a subagent spawned
via the `task` tool. A v1.4.5 audit (see `engine/opencode-research-notes.md`
§3) corrected this: plugins are Instance-scoped via `plugin/index.ts`'s
`InstanceState.get(state)` path, and `task.ts` re-enters the same in-process
prompt loop through `ops.prompt(...)`, so hooks **do** fire for subagent tool
calls. What is missing is *identity* — the three `plugin.trigger("tool.execute.*", …)`
call sites in `packages/opencode/src/session/prompt.ts` (built-in tool, MCP
tool, and task tool) ship an envelope with `{ tool, sessionID, callID }` but
no `agent`, `parentSessionID`, or `agentChain`, so downstream permission and
audit plugins cannot tell *which* agent made a given call. jellyclaw closes
this gap with a **two-layer defense**, both landing in Phase 1:

**Layer A — jellyclaw plugin, not a source patch.**
`engine/src/plugin/agent-context.ts` is a first-party jellyclaw plugin that
runs ahead of every user plugin in the hook chain. On each `tool.execute.before`
and `tool.execute.after` invocation it enriches the envelope with `agent`,
`parentSessionID`, and `agentChain` fields derived from the session graph the
plugin itself maintains (indexed on `sessionID`/`callID`). Downstream user
plugins — permissions, audit logging, rate-limiters — therefore see a fully
qualified envelope and can reason about root vs. subagent calls without
needing an upstream change.

Why a plugin and not a patch? `opencode-ai` ships a compiled Bun-built
standalone binary on npm — there is no consumer-side TypeScript for
`patch-package` to diff against. The plugin path is the only consumer-side
seam into the hook pipeline. See §15 for the toolchain consequences and
`engine/opencode-research-notes.md` §3.3, §5.1, §6.1, §6.2 for the full
investigation.

**Layer B — declarative permission ruleset enforced at the provider wrapper.**
**Unchanged.** jellyclaw evaluates `permissions.ts` on every tool invocation
inside the provider wrapper, a layer that subagents cannot bypass because
they route through the same provider call. Layer B remains the load-bearing
safety net and the final authority — even if Layer A were ever lost to a
plugin-loader regression, Layer B still denies the call.

Both layers are required. Neither is deferred.

---

## 6. Provider configuration

### 6.1 Anthropic direct (DEFAULT)

- Endpoint: `https://api.anthropic.com/v1/messages`
- SDK: `@anthropic-ai/sdk` ≥ the current minor, consumed directly.
- Auth: `ANTHROPIC_API_KEY` env or config file.
- Models: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-6` (aliases
  and explicit dated IDs both accepted).
- Prompt caching: enabled by default with `cache_control: { type: "ephemeral" }`
  breakpoints — see §7.
- Extended thinking: supported via `thinking: { type: "enabled", budget_tokens }`.
- Streaming: SSE, forwarded as NDJSON events to stdout in `--json` mode.

### 6.2 OpenRouter (opt-in secondary)

Activated only when `provider: "openrouter"` is set in config or `--provider
openrouter` is passed, OR when the resolved model ID is for a non-Anthropic
vendor.

**Known-broken caching (April 2026):** OpenRouter's Anthropic proxy path has
two open regressions that make it unsuitable as the default:

- GitHub issue #1245 — `cache_control` breakpoints silently dropped on
  Anthropic-via-OpenRouter requests, zeroing cache hit rate.
- GitHub issue #17910 — OAuth-scoped tokens + `cache_control` returns HTTP 400
  since 2026-03-17.

Net effect: 4-10× worse cache economics on OpenRouter for the same Anthropic
model. jellyclaw MUST print a warning on boot when OpenRouter is selected with
an Anthropic model:

```
[jellyclaw] OpenRouter provider active with an Anthropic model.
            Prompt caching is currently broken on this route
            (upstream issues #1245, #17910). Expect 4-10× higher
            token cost. Use --provider anthropic for full caching.
```

Non-Anthropic models via OpenRouter (Gemini, Llama, Qwen, etc.) are fine and
do not emit the warning.

### 6.3 Resolution order

1. `--provider` CLI flag
2. `provider` field in resolved config
3. Heuristic from model ID prefix (`claude-*` → anthropic, else openrouter)
4. Hard default: `anthropic`

---

## 7. Anthropic caching strategy

jellyclaw inserts up to four `cache_control` breakpoints per request, in the
order Anthropic evaluates them (longest stable prefix first):

| # | Location                         | Contents                                  | TTL       |
|---|----------------------------------|-------------------------------------------|-----------|
| 1 | `system` block, first chunk      | System prompt + agent identity            | 1h (beta) |
| 2 | `tools` array, last tool         | Tool definitions (entire array is cached) | 5m        |
| 3 | First user message, `CLAUDE.md`  | Project memory file, if present           | 5m        |
| 4 | First user message, skills bundle| Most-recent-N skills markdown             | 5m        |

Rules:
- Never place a breakpoint inside user-variable turns.
- Skills bundle is rotated: we include the top-N most-recently-used skills
  (N=12 default, config `cache.skillsTopN`) to maximize reuse probability.
- If any of (system, tools, CLAUDE.md) are unchanged across invocations,
  reuse is automatic. Config hash is surfaced in telemetry (opt-in).
- `cache_control` is ONLY emitted on the Anthropic provider path. The
  OpenRouter path omits it entirely to avoid the #17910 400 error.

Target hit rate in steady-state Genie usage: ≥85% on system+tools,
≥60% on CLAUDE.md.

---

## 8. Tool surface

Built-in tools exposed by the OpenCode substrate (unchanged): `read`, `write`,
`edit`, `bash`, `glob`, `grep`, `task`, `webfetch`, `todowrite`.

MCP servers configured via `<cwd>/jellyclaw.json` or `~/.jellyclaw/jellyclaw.json`
under the `.mcp[]` array. Playwright is included by default but pinned — see §15.

---

## 9. Config schema

All config is validated with `zod` at load time. Invalid config → exit 4.

```ts
// engine/src/config/schema.ts
import { z } from "zod";

export const Config = z.object({
  provider: z.enum(["anthropic", "openrouter"]).default("anthropic"),
  model: z.string().default("claude-sonnet-4-6"),
  anthropic: z.object({
    apiKey: z.string().optional(),      // else ANTHROPIC_API_KEY env
    baseURL: z.string().url().optional()
  }).default({}),
  openrouter: z.object({
    apiKey: z.string().optional(),      // else OPENROUTER_API_KEY env
    baseURL: z.string().url().default("https://openrouter.ai/api/v1")
  }).default({}),
  cache: z.object({
    enabled: z.boolean().default(true),
    skillsTopN: z.number().int().min(0).max(64).default(12),
    systemTTL: z.enum(["5m", "1h"]).default("1h")
  }).default({}),
  server: z.object({
    host: z.literal("127.0.0.1").default("127.0.0.1"),  // LOCKED
    portRange: z.tuple([z.number(), z.number()]).default([49152, 65535])
  }).default({}),
  telemetry: z.object({
    enabled: z.boolean().default(false) // OPT-IN
  }).default({}),
  permissions: z.record(z.string(), z.enum(["allow","ask","deny"])).default({})
});
export type Config = z.infer<typeof Config>;
```

Resolution order: defaults ← `~/.jellyclaw/config.json` ← `<cwd>/.jellyclaw/config.json`
← env vars ← CLI flags.

---

## 10. Example configs

**Minimal (Anthropic direct).**
```json
{ "provider": "anthropic", "model": "claude-sonnet-4-6" }
```

**Mixed routing.**
```json
{
  "provider": "anthropic",
  "model": "claude-opus-4-6",
  "cache": { "skillsTopN": 20, "systemTTL": "1h" },
  "permissions": { "bash": "ask", "write": "allow", "webfetch": "deny" }
}
```

**OpenRouter for non-Anthropic only.**
```json
{ "provider": "openrouter", "model": "google/gemini-2.5-pro" }
```

---

## 11. Session lifecycle

```
start → load config → validate (zod) → pick free port →
  generate OPENCODE_SERVER_PASSWORD (32 bytes hex) →
  spawn opencode server bound to 127.0.0.1:port →
  wait for /health 200 → apply subagent patch at runtime check →
  load plugins → open provider → stream prompt →
  pipe NDJSON to stdout → on EOF/error: SIGTERM server →
  wait 5s → SIGKILL if alive → exit
```

The password is never written to disk. It lives in the spawned process env and
the client's Authorization header only.

---

## 12. Telemetry

- Default: **disabled**. No data leaves the machine.
- Opt-in via `telemetry.enabled: true` or `JELLYCLAW_TELEMETRY=1`.
- Opt-out override: `--no-telemetry` flag always wins, even over config.
- When enabled, payload is local-first: writes to `~/.jellyclaw/telemetry.ndjson`.
  A separate, explicit `jellyclaw telemetry upload` command uploads to a
  configured endpoint. No background uploads, ever.
- Contents: model, token counts, cache hit rate, tool call histogram. No
  prompt or tool-output bodies.

---

## 13. Permissions

The permissions map in §9 is consulted inside the provider wrapper BEFORE a
tool call is dispatched. This is the Layer B defense from §5.1. Semantics:

- `allow` — execute silently.
- `ask` — pause, emit `permission.ask` event, wait for `stdin` ack or the
  host GUI (desktop/integration) to resolve the prompt.
- `deny` — refuse, return a tool-error to the model.

Permissions apply identically in top-level and subagent contexts.

---

## 14. Sandboxing

- bash tool runs under a cwd jail; no `cd ..` above the project root unless
  `permissions.bash = allow`.
- write/edit refuse paths outside the project root by default.
- webfetch respects a denylist (localhost, link-local, RFC1918) unless
  explicitly allowed — closes SSRF against developer machines.

---

## 15. Version pinning

Exact pins enforced in `engine/package.json`:

```json
{
  "dependencies": {
    "opencode-ai": ">=1.4.4",
    "@anthropic-ai/sdk": "^0.40.0",
    "@playwright/mcp": "0.0.41",
    "zod": "^3.23.0",
    "patch-package": "^8.0.0"
  }
}
```

Pin rationale:

- **`opencode-ai >=1.4.4`** — CVE-2026-22812 (unauth RCE, CVSS 8.8) affected
  `<v1.0.216`. Fix chain: v1.0.216 added auth, v1.1.10 disabled the server
  by default, v1.4.4 shipped the final hardening we rely on. See
  `CVE-MITIGATION.md`. NEVER downgrade.
- **`@playwright/mcp 0.0.41` exact pin** — newer releases (0.0.42+) are
  missing several tool definitions per our ecosystem scan. Pinned exactly
  until upstream restores the manifest.
- **`@anthropic-ai/sdk ^0.40.0`** — first line with stable 1h cache TTL beta.

`npm ci` with a committed lockfile is the only supported install path.

**Patch-package posture.** `patch-package` is retained as a dependency and
its `postinstall` hook still runs on every install, but the `patches/`
directory currently holds no active patches; `opencode-ai` ships a compiled
binary so all controls live in `engine/src/plugin/` and
`engine/src/bootstrap/` instead. See `patches/README.md` for the rationale
and the historical design-intent records for the three originally-planned
patches. The tool stays in the toolchain for future non-binary dependencies
that may need small diffs.

---

## 16. Testing

- Unit: provider adapters, cache-breakpoint placement, zod schema.
- Patch regression: subagent-hooks patch must cause `before` hooks to fire
  for a tool call two subagents deep. Test lives in `test/subagent-hooks.test.ts`.
- E2E: Genie dispatcher swap — run a 20-prompt fixture against `claude -p` vs
  `jellyclaw`, diff outputs within tolerance.
- Security: a test that asserts the OpenCode server refuses requests from
  `0.0.0.0` bind attempts and from requests without the password header.

---

## 17. Release process

1. `npm ci && npm test` on macOS 14, macOS 15, Ubuntu 24.04.
2. `npm run build` → `dist/`.
3. `npm publish --access public` as `@jellyclaw/engine`.
4. Tag `engine-vX.Y.Z` on the monorepo.
5. Bump Genie's `dispatcher.mjs` pin.

---

## 18. Phased rollout

- **P1 (week 1-2):** provider/anthropic, OpenCode boot, subagent patch +
  permission layer, zod config, basic caching. Ships as `0.1.x`.
- **P2 (week 3-4):** OpenRouter provider, telemetry scaffolding, skills
  rotation for cache §7, MCP passthrough.
- **P3 (week 5-6):** desktop shell (optional), session persistence, resume.
- **P4 (week 7-8):** jelly-claw integration bridge (§21), Swift glue, signed
  release.

---

## 19. Non-compliance exits

The CLI MUST exit non-zero and emit a structured error when:
- OpenCode version resolves to `<1.4.4` (exit 4, CVE reason).
- Config fails zod validation (exit 4).
- OpenCode server binds anything other than `127.0.0.1` (exit 3).
- `ANTHROPIC_API_KEY` missing for anthropic provider (exit 1).

---

## 20. Open questions (tracked, not blocking)

- Should we ship an auto-updater? Probably yes for desktop, no for CLI.
- Do we expose raw `thinking` blocks to the Genie dispatcher, or summarize?
  Tentative: raw, gated by `--show-thinking`.
- Skills format convergence with Anthropic's SKILL.md spec — track, don't
  fork yet.

---

## 21. Integration path into jelly-claw video-calling app

The jelly-claw macOS app (Swift/Xcode, at `/Users/gtrush/Downloads/jelly-claw/`)
will embed jellyclaw as its Genie sub-service. This section specifies the
bridge.

### 21.1 Constraints

- Host language: Swift. Target: macOS 14+, Apple Silicon primary.
- Engine language: Node/TypeScript. Node binary must be bundled or located.
- The engine is stateful per-session but cheap to re-spawn.
- Distribution: jelly-claw ships as a notarized `.app`. No Homebrew dependency.

### 21.2 Options considered

| Option                       | Pros                         | Cons                              |
|------------------------------|------------------------------|-----------------------------------|
| A. Shell out per call        | Simplest                     | 200-400ms boot cost per prompt    |
| B. Bundle Node as resource   | Reproducible, notarizable    | +40MB app size                    |
| C. Long-running Node IPC     | Zero per-prompt boot cost    | Lifecycle management complexity   |
| D. Loopback HTTP server      | Language-neutral, testable   | Needs auth header discipline      |

### 21.3 Chosen design: B + C + D (hybrid)

1. **Bundle Node** as `jelly-claw.app/Contents/Resources/node/bin/node`
   (arm64 + x86_64 slices, lipo'd). Pulled from the official Node tarball at
   build time, SHA pinned. This removes the "is Node installed" failure mode.
2. **Spawn a long-running `jellyclaw daemon`** on app launch, bound to
   `127.0.0.1:<random>` with an `OPENCODE_SERVER_PASSWORD`-style per-launch
   secret. Lifetime: from app launch to app quit. Crash-restart with
   exponential backoff, capped at 3 attempts per 60s.
3. **Loopback HTTP** for Swift→Node IPC. Endpoints:
   - `POST /v1/prompt` — body: `{ prompt, sessionId?, model? }`, response:
     SSE stream of NDJSON events (same shape as CLI `--json` mode).
   - `POST /v1/session/close` — body: `{ sessionId }`.
   - `GET /v1/health` — liveness.
   - Auth: `Authorization: Bearer <per-launch-secret>` required on every
     request. Secret is passed to the child via env, held by Swift in memory
     only (never Keychain, never disk).
4. **Swift bridge** at `integration/swift/JellyclawBridge.swift` exposes:
   ```swift
   final class JellyclawBridge {
     static let shared = JellyclawBridge()
     func start() throws
     func stop()
     func prompt(_ text: String,
                 session: String? = nil,
                 onEvent: @escaping (JellyclawEvent) -> Void)
                 async throws
   }
   ```
   Uses `URLSession` with a `URLSessionDataDelegate` for SSE.

### 21.4 Security for the bridge

- Bind strictly `127.0.0.1`. Verified at boot by checking `getsockname()`
  output in the Node daemon — if anything else, exit 3.
- Bearer token entropy ≥ 256 bits.
- No CORS. Loopback only; browsers cannot reach it from non-loopback origins
  anyway, and we reject non-loopback `Origin` headers defensively.
- App Sandbox: the `com.apple.security.network.server` entitlement is NOT
  required because the server is bound to loopback and accepts only
  in-process connections initiated from the same app.

### 21.5 Build wiring

- Xcode build phase `Embed Node Runtime`: copies Node binary + `@jellyclaw/engine`
  `dist/` into `Contents/Resources/jellyclaw/`.
- Xcode build phase `Validate Node SHA`: fails the build if either hash
  drifts from the values in `integration/node-pins.json`.
- Notarization: Node binary and engine JS are ad-hoc signed during Archive;
  notarization then covers the entire `.app`.

### 21.6 Migration plan from Genie

- Today: Genie spawns `claude -p` → future: Genie spawns `jellyclaw --json`.
- After jelly-claw integration: Genie inside jelly-claw calls
  `JellyclawBridge.shared.prompt(...)` directly instead of spawning a process
  per prompt, inheriting the long-running daemon's warm cache.

---

*End of SPEC.*
