---
id: T3-11-expand-stream-json-init
tier: 3
title: "Expand system.init frame to match Claude Code's 20+ field shape"
scope:
  - "engine/src/cli/output-claude-stream-json.ts"
  - "engine/src/cli/output-claude-stream-json.test.ts"
  - "engine/src/cli/output-claude-stream-json-writer.test.ts"
  - "test/fixtures/stream-json/system-init.golden.jsonl"
depends_on_fix:
  - T0-01-fix-serve-shim
tests:
  - name: system-init-has-all-required-fields
    kind: shell
    description: "first frame of any session contains all 20+ fields present in Claude Code's real system.init"
    command: "bun run test engine/src/cli/output-claude-stream-json -t system-init-fields"
    expect_exit: 0
    timeout_sec: 30
  - name: system-init-empty-state-defaults
    kind: shell
    description: "agents/skills/slash_commands/plugins default to [] (not undefined); permissionMode defaults to 'default'"
    command: "bun run test engine/src/cli/output-claude-stream-json -t system-init-empty-defaults"
    expect_exit: 0
    timeout_sec: 30
  - name: system-init-uuid-per-event
    kind: shell
    description: "each frame carries a per-event uuid (v4); the system.init uuid differs from subsequent assistant frame uuids"
    command: "bun run test engine/src/cli/output-claude-stream-json -t system-init-uuid"
    expect_exit: 0
    timeout_sec: 30
  - name: system-init-api-key-source-accurate
    kind: shell
    description: "apiKeySource reflects actual auth: 'apiKeyHelper'|'env'|'subscription' — NOT hard-coded 'env'"
    command: "bun run test engine/src/cli/output-claude-stream-json -t system-init-api-key-source"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 40
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 60
---

# T3-11 — Expand `system.init` frame to Claude Code's real shape

## Context
`engine/src/cli/output-claude-stream-json.ts:164-179` emits a `system.init` frame with 12 fields. Real `claude -p --output-format stream-json` emits 20+, and consumers of the Jelly-Claw dispatcher (`genie-server/src/core/dispatcher.mjs`) parse fields we don't emit — specifically `cache_creation.ephemeral_{5m,1h}_input_tokens`, per-event `uuid`, `output_style`, and populated `agents[]` / `skills[]` / `slash_commands[]` / `plugins[]` lists. Our writer passes empty arrays and hard-codes `apiKeySource: "env"`.

## Root cause (from audit)
- `engine/src/cli/output-claude-stream-json.ts:164-179` — fixed field list. Missing: `uuid`, `cache_creation`, `output_style`. `apiKeySource` hard-coded at `:172`. `agents`/`skills`/`slash_commands`/`plugins` hard-coded to `[]` at `:175-178` — we DO have skills/slash-command/agent registries populated at runtime (`engine/src/skills`, `engine/src/tui/commands/registry.ts:208-240`, `engine/src/agents`). Not wired.
- `engine/src/cli/output-claude-stream-json.ts:82-87` — options carry `cwd`, `tools`, `permissionMode` only. No `apiKeySource` / `agents` / `skills` / `slashCommands` / `plugins` / `outputStyle`.

## Fix — exact change needed
1. **Widen `ClaudeStreamJsonWriterOptions` at `output-claude-stream-json.ts:49-53`:**
   ```ts
   export interface ClaudeStreamJsonWriterOptions {
     readonly cwd: string;
     readonly tools: readonly string[];
     readonly permissionMode?: string;
     readonly apiKeySource?: "env" | "apiKeyHelper" | "subscription" | "dotenv" | "none";
     readonly agents?: readonly { readonly name: string; readonly description?: string }[];
     readonly skills?: readonly { readonly name: string; readonly description?: string }[];
     readonly slashCommands?: readonly string[];
     readonly plugins?: readonly { readonly name: string; readonly version?: string }[];
     readonly outputStyle?: string;           // default: "default"
     readonly mcpServers?: readonly { readonly name: string; readonly status: "connected" | "failed" | "disconnected" }[];
     readonly claudeCodeVersion?: string;     // default: jellyclaw package.json version
   }
   ```
2. **Per-event `uuid`.** Import `randomUUID` from `node:crypto`. Add a private `#nextUuid()` method to the writer that returns a fresh v4 UUID. Call it at the top of every `#emit(frame)` and merge `uuid` into `frame` just before serialization. This satisfies the "per-event uuid" requirement across ALL frame types (system/assistant/user/result).
3. **Rewrite `#onSessionStarted` at `output-claude-stream-json.ts:160-180`:**
   ```ts
   await this.#emit({
     type: "system",
     subtype: "init",
     session_id: ev.session_id,
     model: ev.model,
     cwd: this.#cwd,
     tools: this.#tools,
     permissionMode: this.#permissionMode,
     apiKeySource: this.#apiKeySource,                // injected
     claude_code_version: this.#claudeCodeVersion,
     mcp_servers: this.#mcpServers,
     slash_commands: this.#slashCommands,
     agents: this.#agents,
     skills: this.#skills,
     plugins: this.#plugins,
     output_style: this.#outputStyle,
     cache_creation: {
       ephemeral_5m_input_tokens: 0,
       ephemeral_1h_input_tokens: 0,
     },
   });
   ```
4. **Track cache_creation cumulatively.** In `#onUsage` at `:282-290`, split `ev.cache_write_tokens` (if the adapter exposes breakout fields — check `engine/src/providers/adapter.ts`). If adapter only gives a single `cache_write_tokens`, route it to `ephemeral_5m_input_tokens` (the common case per Anthropic default TTL) and leave `ephemeral_1h_input_tokens: 0` — add a TODO.
5. **Update the `result` frame** at `:327-345` to emit a matching `cache_creation` breakdown in `usage`. Add a new `modelUsage` sub-object per Claude Code's real shape:
   ```ts
   modelUsage: { [this.#model]: { inputTokens: this.#inputTokens, outputTokens: this.#outputTokens, cacheReadInputTokens: this.#cacheRead, cacheCreationInputTokens: this.#cacheCreate, webSearchRequests: 0, costUSD: this.#costSum, contextWindow: 200_000 } }
   ```
6. **Default population** — callers that don't provide the new options get safe defaults:
   ```ts
   apiKeySource: opts.apiKeySource ?? (process.env.ANTHROPIC_API_KEY ? "env" : "none"),
   agents: opts.agents ?? [],
   skills: opts.skills ?? [],
   slashCommands: opts.slashCommands ?? [],
   plugins: opts.plugins ?? [],
   mcpServers: opts.mcpServers ?? [],
   outputStyle: opts.outputStyle ?? "default",
   claudeCodeVersion: opts.claudeCodeVersion ?? readPackageVersion(),
   ```
7. **Upstream caller plumbing.** In `engine/src/cli/run.ts` (the CLI entry that constructs the writer), pass real data:
   - `agents`: list from `engine/src/agents/` discovery (if registry doesn't exist yet, pass `[]`).
   - `skills`: list from `engine/src/skills/` discovery.
   - `slashCommands`: map `COMMANDS` in `engine/src/tui/commands/registry.ts:208-240` to `c.name`. Note: these are TUI-only today, but they should surface in stream-json anyway for parity.
   - `plugins`: `[]` — jellyclaw has no plugin registry yet. Stub.
8. **Golden fixture** — create `test/fixtures/stream-json/system-init.golden.jsonl` with the exact expected shape. Tests compare the first emitted line to this fixture (modulo `uuid` and `session_id`, which vary).

## Acceptance criteria
- `system.init` carries all 20+ fields (maps to `system-init-has-all-required-fields`).
- Empty-state defaults are the right shape, not undefined (maps to `system-init-empty-state-defaults`).
- Every frame has a unique v4 `uuid` (maps to `system-init-uuid-per-event`).
- `apiKeySource` reflects actual auth (maps to `system-init-api-key-source-accurate`).
- Existing stream-json consumer tests still pass (no backwards-incompatible field removals).
- `bun run typecheck` + `bun run lint` clean.

## Out of scope
- Do NOT change the `user` / `assistant` / `result` frame shapes beyond adding `uuid` and the `modelUsage` enrichment.
- Do NOT try to populate `plugins[]` from a real registry — stub `[]` until a plugin system exists.
- Do NOT add web-search counters to usage accounting — hard-code `webSearchRequests: 0`.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/cli/output-claude-stream-json
bun run test engine/src/cli/output-claude-stream-json-writer
```
