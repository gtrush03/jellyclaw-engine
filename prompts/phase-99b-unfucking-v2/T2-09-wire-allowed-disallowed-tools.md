---
id: T2-09-wire-allowed-disallowed-tools
tier: 2
title: "Thread --allowed-tools / --disallowed-tools into AgentLoopOptions tool filter"
scope:
  - "engine/src/cli/run.ts"
  - "engine/src/agents/loop.ts"
  - "engine/src/agents/tool-filter.ts"
  - "engine/src/agents/tool-filter.test.ts"
depends_on_fix: []
tests:
  - name: disallowed-tools-filtered-from-request
    kind: shell
    description: "--disallowed-tools 'Bash,WebFetch' removes those tools from the provider request tools[] array"
    command: "bun run test engine/src/agents/tool-filter -t filter-out-disallowed"
    expect_exit: 0
    timeout_sec: 30
  - name: allowed-tools-intersects
    kind: shell
    description: "--allowed-tools 'Read,Grep' limits the request to exactly those two tools (and MCP tools remain gated separately)"
    command: "bun run test engine/src/agents/tool-filter -t intersect-allowed"
    expect_exit: 0
    timeout_sec: 30
  - name: tool-use-of-disallowed-returns-error
    kind: shell
    description: "model emits tool_use for a name filtered out → loop responds with tool_error 'tool_not_enabled'"
    command: "bun run test engine/src/agents/loop -t disallowed-tool-error"
    expect_exit: 0
    timeout_sec: 60
human_gate: false
max_turns: 35
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 35
---

# T2-09 — Wire `--allowed-tools` / `--disallowed-tools` through to the loop

## Context
`jellyclaw run --disallowed-tools "Bash,WebFetch"` should remove Bash + WebFetch from the tool set advertised to the model AND reject any fallback `tool_use` that names them. The CSV parsing works; the result is then literally discarded. A consuming user has no way to turn off dangerous tools.

## Root cause (from audit)
- `engine/src/cli/run.ts:54-55` — `allowedTools?: string; disallowedTools?: string;` in `RunCliOptions`.
- `engine/src/cli/run.ts:278-279` — `const allowedTools = parseCsv(options.allowedTools); const disallowedTools = parseCsv(options.disallowedTools);` — the parse is correct.
- `engine/src/cli/run.ts:329-332` — `void maxTurns; void maxCostUsd; void allowedTools; void disallowedTools;` — the ignore comment openly admits the wiring was deferred.
- `engine/src/agents/loop.ts:48-79` — `AgentLoopOptions` has no `allowedTools`/`disallowedTools` fields. `toolsAsProviderTools()` at `loop.ts:568` advertises every registered tool.
- `engine/src/agents/loop.ts:311+` — `executeTool` dispatches without consulting any tool-enable policy. A model that ignores the advertised list and invokes `Bash` anyway succeeds.

## Fix — exact change needed
1. **New file `engine/src/agents/tool-filter.ts`** — export:
   - `interface ToolFilter { readonly allow?: readonly string[]; readonly deny?: readonly string[]; }` where names may include `mcp__server__tool` with trailing `*` wildcard (consistent with `engine/src/permissions/rules.ts:41`'s MCP grammar).
   - `applyToolFilter(tools: ReadonlyArray<{name:string; …}>, filter: ToolFilter): ReadonlyArray<…>`. Rules:
     1. If `deny` contains the tool name (or a matching `mcp__srv__*` pattern) — exclude.
     2. If `allow` is defined AND non-empty AND the tool name is NOT matched — exclude.
     3. Otherwise include.
     Matching reuses the picomatch options from `rules.ts` for consistency. No regex escape bugs; MUST have unit test for `mcp__github__*`.
   - `isToolEnabled(name: string, filter: ToolFilter): boolean` — single-name variant for the runtime check.
2. **`engine/src/agents/loop.ts`**:
   - Add `toolFilter?: ToolFilter` to `AgentLoopOptions` (near `allowedTools` concept, after existing options).
   - In `toolsAsProviderTools(mcp?, filter?)` — apply `applyToolFilter(...)` to the combined builtin+MCP tool list before returning.
   - In `executeTool` — before PreToolUse hook, check `isToolEnabled(tool_name, filter)`. If false, emit `tool.error{code:"tool_not_enabled",message:"<name> is disabled for this session"}` and feed back `tool_result{is_error:true}`. Do NOT call the hook (model should see a clean rejection).
3. **`engine/src/cli/run.ts`**:
   - Remove `allowedTools` and `disallowedTools` from the `void …` block at `:329`.
   - Build `const toolFilter: ToolFilter = { allow: allowedTools, deny: disallowedTools };` and pass into `runAgentLoop({..., toolFilter})`.
4. **Tests**:
   - `engine/src/agents/tool-filter.test.ts`: `filter-out-disallowed` — `applyToolFilter([{name:"Bash"},{name:"Read"}], {deny:["Bash"]})` returns `[{name:"Read"}]`. `intersect-allowed` — `allow:["Read","Grep"]` on a larger set returns exactly those two. MCP wildcard — `deny:["mcp__github__*"]` removes every `mcp__github__*` tool.
   - `engine/src/agents/loop.test.ts :: disallowed-tool-error` — set `toolFilter: {deny:["Bash"]}`, fake provider emits a `tool_use` for `Bash` anyway, assert loop yields `tool.error{code:"tool_not_enabled"}` and feeds `tool_result{is_error:true}` back to the model.

## Acceptance criteria
- `disallowed-tools-filtered-from-request` — `tools[]` in `ProviderRequest` excludes denied names (maps to test 1).
- `allowed-tools-intersects` — allow-list acts as an intersect (maps to test 2).
- `tool-use-of-disallowed-returns-error` — runtime rejection behaves cleanly on attempt (maps to test 3).

## Out of scope
- Do NOT try to unify with the permission engine's `allow/deny/ask` rule system — these are complementary: tool filter is "advertised vs hidden", permissions are "what to do when called". Both run.
- Do NOT modify `engine/src/permissions/**` (always-human-review scope).
- Do NOT support negative patterns (`!Bash`) in the CSV — grammar stays simple.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/agents/tool-filter engine/src/agents/loop
grep -n "void allowedTools\|void disallowedTools" engine/src/cli/run.ts && echo "STILL VOID" || echo "clean"
```
