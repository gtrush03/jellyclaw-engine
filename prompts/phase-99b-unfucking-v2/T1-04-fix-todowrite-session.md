---
id: T1-04-fix-todowrite-session
tier: 1
title: "Inject ctx.session so TodoWrite stops throwing SessionUnavailable"
scope:
  - "engine/src/agents/loop.ts"
  - "engine/src/agents/loop.test.ts"
  - "engine/src/tools/todowrite.ts"
depends_on_fix: []
tests:
  - name: todowrite-succeeds-with-three-items
    kind: shell
    description: "TodoWrite with 3 items does NOT throw SessionUnavailableError and emits session.update"
    command: "bun run test engine/src/agents/loop -t todowrite-session-inject"
    expect_exit: 0
    timeout_sec: 30
  - name: todowrite-state-readable
    kind: shell
    description: "after TodoWrite, the session handle reflects the written todos"
    command: "bun run test engine/src/agents/loop -t todowrite-state-readback"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 35
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 30
---

# T1-04 — Inject `ctx.session` into ToolContext

## Context
`TodoWrite` exists and is registered, but every call throws `SessionUnavailableError` because the agent loop builds a `ToolContext` without a `session` handle. The model sees every planning call fail and abandons structured planning entirely. Fix: construct an in-memory `SessionHandle` per agent-loop run, wire it into `ToolContext.session`, and surface its `update()` calls as outbound events.

## Root cause (from audit)
- `engine/src/agents/loop.ts:452-460` — `ToolContext` is built with `cwd`, `sessionId`, `readCache`, `abort`, `logger`, `permissions`, `subagents` — no `session`.
- `engine/src/tools/todowrite.ts:59-61` — handler checks `if (!ctx.session) throw new SessionUnavailableError("TodoWrite")`. Every invocation hits this branch.
- `engine/src/tools/types.ts:57-65` — `SessionHandle` contract already exists: `{ state: SessionState; update(patch: Partial<SessionState>): void }` with `SessionState = { todos: readonly TodoItem[] }`.
- Impact: model cannot plan multi-step work. Every `/plan` or self-directed todo list silently fails tool-side and the model gives up structured planning.

## Fix — exact change needed
1. In `engine/src/agents/loop.ts`, after `readCache` / `permService` / `subagents` are set up (around `loop.ts:128-130`), construct a per-run session handle:
   ```ts
   const sessionState: { todos: readonly import("../tools/types.js").TodoItem[] } = { todos: [] };
   const sessionHandle: import("../tools/types.js").SessionHandle = {
     get state() { return sessionState; },
     update(patch) {
       if (patch.todos !== undefined) sessionState.todos = patch.todos;
       // NOTE(T2): forward to an outbound `session.update` AgentEvent once the
       // event type lands. For T1 the in-memory state + tool return value is
       // sufficient to unblock planning.
     },
   };
   ```
   Use `import type` if possible; the inline `import("...")` dodges a circular-import risk at the top of the file. Prefer pulling the types into the existing `import` block at top.
2. At the `ctx: ToolContext = { ... }` construction at `loop.ts:452-460`, add `session: sessionHandle` as the last property.
3. Defense-in-depth: in `engine/src/tools/todowrite.ts:59-61`, when `ctx.session` is still `undefined` (should now be impossible from the loop but may happen in direct tool invocation), log a pino warning via `ctx.logger.warn({ tool: "TodoWrite" }, "session handle missing; returning no-op")` and return `{ todos: [], count: 0 }` instead of throwing. This makes the tool strictly safer without changing the success path.
4. Add two vitest cases to `engine/src/agents/loop.test.ts`:
   - `todowrite-session-inject`: drive a single loop turn whose assistant yields a `tool_use` for TodoWrite with 3 items; assert no `tool.error{code:"SessionUnavailable"}` event, and a `tool.result` event is emitted with `output.count === 3`.
   - `todowrite-state-readback`: second turn re-reads via TodoWrite with an empty list + then fires a getter; assert the second call sees the prior state (in-memory handle persists across turns within the same loop).

## Acceptance criteria
- TodoWrite with 3 items succeeds; no `SessionUnavailableError` (maps to `todowrite-succeeds-with-three-items`).
- State persists within a single loop invocation (maps to `todowrite-state-readable`).
- Logger warning (not throw) on direct tool invocation without session.

## Out of scope
- Do NOT add a new `AgentEvent` variant `session.update` yet. In-memory handle is enough for T1; outbound wiring is T2.
- Do NOT persist todos to SQLite — that's `engine/src/session/writer.ts` territory and belongs to a later phase.
- Do NOT modify the `SessionHandle` / `SessionState` interface shape in `engine/src/tools/types.ts`.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/agents/loop
bun run test engine/src/tools/todowrite
grep -n "sessionHandle" engine/src/agents/loop.ts
```
