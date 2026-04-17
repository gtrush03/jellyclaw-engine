---
id: T2-01-wire-mcp-tools-into-loop
tier: 2
title: "Wire McpRegistry tools into the agent loop's provider request + dispatch"
scope:
  - "engine/src/agents/loop.ts"
  - "engine/src/agents/loop.test.ts"
  - "engine/src/cli/run.ts"
depends_on_fix:
  - T1-01-cap-tool-output-bytes
tests:
  - name: mcp-echo-tool-invoked
    kind: shell
    description: "provider request includes mcp__<srv>__echo; the tool round-trips via registry.callTool()"
    command: "bun run test engine/src/agents/loop -t mcp-tools-merged"
    expect_exit: 0
    timeout_sec: 60
  - name: mcp-tool-result-event-emitted
    kind: shell
    description: "tool_use on an mcp__ name emits matching tool.result AgentEvent fed back as tool_result block"
    command: "bun run test engine/src/agents/loop -t mcp-tool-result-dispatch"
    expect_exit: 0
    timeout_sec: 60
  - name: no-mcp-registry-no-regression
    kind: shell
    description: "existing loop tests (no MCP configured) still pass untouched"
    command: "bun run test engine/src/agents/loop"
    expect_exit: 0
    timeout_sec: 120
human_gate: false
max_turns: 45
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 50
---

# T2-01 — Wire McpRegistry tools into the agent loop

## Context
`McpRegistry` at `engine/src/mcp/registry.ts` fully works — it connects stdio/http/sse servers, tracks `ready` status, exposes `listTools()` and routes namespaced calls through `callTool()`. But the agent loop never sees it. The provider request advertises only the builtin tool set, so the model is structurally unable to call any MCP tool even when a server is connected and healthy.

## Root cause (from audit)
- `engine/src/agents/loop.ts:568-577` — `toolsAsProviderTools()` takes no arguments and calls `listTools()` from `../tools/index.js` (builtin-only). MCP tools never appear in `ProviderRequest.tools`.
- `engine/src/agents/loop.ts:48-79` — `AgentLoopOptions` does not accept an `McpRegistry`. There is no seam to pass one in.
- `engine/src/agents/loop.ts:311+` (`executeTool`) dispatches via `getTool(tool_name)` from the builtin registry. A `tool_use` whose `name` starts with `mcp__` has no handler and falls through to `errorResult`, even though `registry.callTool("mcp__<srv>__<tool>", input)` would have worked.
- `engine/src/cli/run.ts:120-158` (`realRunFn`) never constructs an `McpRegistry` and never reads `mcpConfig`.

## Fix — exact change needed
1. **`engine/src/agents/loop.ts`** — add an optional `mcp?: McpRegistry` field to `AgentLoopOptions` (import type only; no runtime dep cycle because `registry.ts` is leaf). Thread it into:
   - `toolsAsProviderTools(mcp?)` → append `mcp.listTools().map(t => ({ name: t.namespacedName, description: t.description, input_schema: t.inputSchema }))` to the returned array. Keep builtin-first ordering so model preference is stable.
   - `executeTool` — when `tool_name.startsWith("mcp__")`, skip `getTool(...)` and call `await opts.mcp.callTool(tool_name, toolInput)`. Map the `McpCallToolResult` into the same `ToolExecutionOutcome` shape: success → `{ type: "tool_result", content: stringifyResult(result), tool_use_id: tool_id }`; thrown `McpNotReadyError`/`McpUnknownServerError` → `tool.error` event + `tool_result{is_error:true}`. Still run the PreToolUse hook + permission gate + T1-01 byte cap — MCP tools are not a bypass.
2. **`engine/src/cli/run.ts`** — construct an `McpRegistry` when config declares servers, `await registry.start(configs)`, pass into `runAgentLoop({..., mcp: registry})`. Call `registry.stop()` in the `finally` block alongside the SIGINT cleanup at `run.ts:154-157`. Do NOT crash when registry is undefined (no MCP configured).
3. **Tests** (`engine/src/agents/loop.test.ts`):
   - Inject a fake `McpRegistry`-shaped object (DI via `AgentLoopOptions`; no real subprocess). `listTools()` returns a single `{ name:"echo", namespacedName:"mcp__test__echo", inputSchema, description }`. `callTool("mcp__test__echo", {msg:"hi"})` returns `{ content: [{ type:"text", text:"hi" }], isError: false }`.
   - Mock provider stream to emit a `tool_use` block with `name: "mcp__test__echo"`, assert (a) the request sent to the provider included that tool descriptor; (b) the loop emitted `tool.called` + `tool.result` events; (c) `callTool` was invoked exactly once with the matching input.
   - Second test: `McpUnknownServerError` from `callTool` → `tool.error{code:"tool_error"}` and `tool_result{is_error:true}` fed back.

## Acceptance criteria
- `mcp-echo-tool-invoked` — provider request includes `mcp__test__echo` in `tools[]` (maps to test 1).
- `mcp-tool-result-event-emitted` — `tool.result` AgentEvent with matching `tool_id` fires; provider sees a `tool_result` block on the next turn (maps to test 2).
- `no-mcp-registry-no-regression` — existing tests unchanged when `mcp` option is undefined (maps to test 3).

## Out of scope
- Do NOT add a `--mcp-config` CLI loader here; that is T2-05's settings.json loader territory.
- Do NOT implement any OAuth flow changes.
- Do NOT change `McpRegistry` internals — all wiring happens in `loop.ts` + `cli/run.ts`.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/agents/loop
bun run test engine/src/mcp/registry
```
