---
id: T2-02-implement-real-session-runner
tier: 2
title: "Replace stubSubagentService with a real SessionRunner driving runAgentLoop"
scope:
  - "engine/src/subagents/runner.ts"
  - "engine/src/subagents/runner.test.ts"
  - "engine/src/subagents/stub.ts"
  - "engine/src/cli/run.ts"
depends_on_fix: []
tests:
  - name: task-tool-spawns-subagent
    kind: shell
    description: "Task tool call produces subagent.start + subagent.end events via the real runner"
    command: "bun run test engine/src/subagents/runner -t task-spawn-and-return"
    expect_exit: 0
    timeout_sec: 60
  - name: subagent-depth-guard-rejects
    kind: shell
    description: "nested Task at depth > maxDepth surfaces SubagentDepthExceededError as a subagent.end error"
    command: "bun run test engine/src/subagents/runner -t depth-guard"
    expect_exit: 0
    timeout_sec: 60
  - name: subagent-not-implemented-error-gone
    kind: shell
    description: "production path no longer throws SubagentsNotImplementedError when CLI runs Task"
    command: "bun run test engine/src/cli/run -t real-subagent-runner-wired"
    expect_exit: 0
    timeout_sec: 60
human_gate: false
max_turns: 45
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 60
---

# T2-02 — Implement a real SessionRunner for subagent dispatch

## Context
The subagent dispatch plumbing (`SubagentDispatcher`, `AgentRegistry`, `Semaphore`, `buildSubagentContext`, event schema) landed in Phase 06 but the production path still injects `stubSubagentService` that throws `SubagentsNotImplementedError`. The `Task` tool is therefore permanently broken in the CLI — any prompt that triggers a subagent fails loudly.

## Root cause (from audit)
- `engine/src/subagents/stub.ts:12-17` — `stubSubagentService.dispatch()` unconditionally throws `SubagentsNotImplementedError`.
- `engine/src/agents/loop.ts:130` — `const subagents = opts.subagents ?? stubSubagentService;` — the default is the throw-stub.
- `engine/src/cli/run.ts:142-153` — `runAgentLoop({...})` never passes `subagents`, so the default bites.
- `engine/src/agents/dispatch.ts:49-60` — `SubagentDispatcherOptions` already requires a `SessionRunner`; the real implementation is missing.

## Fix — exact change needed
1. **New file `engine/src/subagents/runner.ts`** — export a `createSessionRunner(deps)` factory that returns a `SessionRunner` (per `engine/src/agents/dispatch-types.ts:146` and the `SessionRunner` interface). `deps` receives `{ provider, permissions, hooks, logger, mcp?, clock?, now? }`. Inside the runner:
   - Resolve the subagent's tool subset from the registered `AgentDefinition` (filter the builtin+MCP tool set by `agent.tools`).
   - Recursively call `runAgentLoop({...})` with: the child `SubagentContext`'s isolated `systemPrompt`, the tool-filtered subset (pass `allowedTools` to the inner loop if T2-09 lands; otherwise pre-filter via a cheaper means — register the Subagent via `buildSubagentContext` then feed its prompt). Session id = `ctx.sessionId`. Depth comes from the context.
   - Collect events into the runner's `events: AsyncIterable<Event>`; map the final `session.completed` / `session.error` into the `SessionRunResult` discriminated union expected by the dispatcher.
   - Enforce `maxTurns` from `DispatchConfig` by forwarding it as `runAgentLoop`'s `maxTurns`.
2. **`engine/src/subagents/stub.ts`** — keep for tests but remove it from the production default. Delete the `?? stubSubagentService` at `engine/src/agents/loop.ts:130`; instead require `opts.subagents` OR default to a lazy "feature disabled" runner that emits a single `tool.error` (not a throw). The CLI path MUST always supply one.
3. **`engine/src/cli/run.ts`** — at `realRunFn`, build an `AgentRegistry`, `Semaphore(cap=2)`, `DispatchConfig` (maxDepth from config or `DEFAULT_MAX_AGENT_CHAIN_DEPTH`), `SubagentDispatcher` with the new runner, then pass `subagents: dispatcher` into `runAgentLoop(...)`. Wire `opts.signal` through so aborts cascade.
4. **Tests** (`engine/src/subagents/runner.test.ts`):
   - Build a fake `Provider` whose first stream yields a `tool_use` for `Task` with an agent name registered in a test `AgentRegistry`. The child run's provider yields a plain text reply + `session.completed`.
   - Assert events (in order): `subagent.start{agent,depth:1}` → … → `subagent.end{reason:"complete"}`.
   - Second test: configure `maxDepth: 1`, have the child trigger another `Task` → assert `SubagentDepthExceededError` maps to `subagent.end{reason:"error", error.code:"depth_exceeded"}` (mapped per `dispatch.ts:215`).
   - Third test in `engine/src/cli/run.test.ts`: end-to-end wiring — inject a fake `runAgentLoop` and assert the `subagents` field on the options bag is the real `SubagentDispatcher`, not the stub.

## Acceptance criteria
- `task-tool-spawns-subagent` — `subagent.start` + `subagent.end{reason:"complete"}` emitted in order (maps to test 1).
- `subagent-depth-guard-rejects` — depth overflow returns a subagent error result, not a thrown exception (maps to test 2).
- `subagent-not-implemented-error-gone` — CLI wiring check confirms the throw-stub is not installed in the production path (maps to test 3).

## Out of scope
- Do NOT implement agent definition discovery here; assume `AgentRegistry` already loaded them (Phase 06 Prompt 01 work). If the registry is empty, `Task` tool returns a permission-style "no such agent" `tool.error`.
- Do NOT tune `Semaphore` cap beyond a sensible default of 2.
- Do NOT add cost accounting plumbing — `SubagentUsage` is already shaped by the dispatcher.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/subagents
bun run test engine/src/agents/dispatch
grep -R "stubSubagentService" engine/src/cli engine/src/agents/loop.ts && echo "STILL WIRED IN PROD" || echo "clean"
```
