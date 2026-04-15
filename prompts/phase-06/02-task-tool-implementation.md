# Phase 06 — Subagent system — Prompt 02: Task tool + dispatch + semaphore

**When to run:** After Phase 06 prompt 01 (subagent definitions) is ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 4–6 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if 06.01 not ✅. -->
<!-- END paste -->

## Research task

1. Re-read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-06-subagents.md`, Steps 3–7.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` — find the `Task` tool section; match its input schema exactly.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — rules on tool intersection (subagent tools must be a subset of parent's allowed tools) and on depth limits.
4. Read the existing tool registry: `engine/src/tools/` (or wherever built-in tools are registered in Phase 04). Understand the `ToolHandler` signature, how tool results are emitted, and how events are streamed.
5. Read `engine/src/agents/` (prompt 01 output).
6. Study how OpenCode sessions are created in `engine/src/opencode/` (or similar). A subagent dispatch should start a **separate OpenCode session** bound to the same server/process, not a new child process.
7. Skim `patches/001-subagent-hook-fire.patch` — understand what it changes in OpenCode. Your dispatch must rely on that patch (prompt 03 verifies it).

## Implementation task

Wire the `Task` tool: given `{ subagent_type, description, prompt }`, spawn a subagent with isolated context and return its summary. Enforce concurrency cap and depth limits.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/agents/semaphore.ts` — `p-limit`-based concurrency gate; default 3, max 5, configurable via `config.agents.maxConcurrency`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/agents/context.ts` — builds isolated context: `{ systemPrompt, tools, skills, model, maxTurns, maxTokens, parentSessionId, depth }`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/agents/dispatch.ts` — main orchestrator; implements `dispatch(input, env): AsyncIterable<AgentEvent>`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tools/task.ts` — registers the `Task` tool with the tool registry; input schema + handler that calls `dispatch`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/events/subagent-events.ts` — `subagent.start`, `subagent.progress`, `subagent.end` event types + emitters.
- Modify tool registry to include `Task`.
- Tests: `dispatch.test.ts`, `semaphore.test.ts`, `context.test.ts`, `task-tool.test.ts`.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/agents.md`.

### Task tool schema (exact)

```ts
{
  name: "Task",
  description: "Dispatch a specialized subagent to perform a focused task with isolated context.",
  input_schema: {
    type: "object",
    required: ["subagent_type", "description", "prompt"],
    properties: {
      subagent_type: { type: "string", description: "Name of the agent from the registry" },
      description:   { type: "string", description: "Short label (≤ 10 words) shown in event stream" },
      prompt:        { type: "string", description: "Full prompt passed to the subagent" }
    }
  }
}
```

### Isolated context rules

- `systemPrompt` = agent body (post-substitution) prepended with inherited CLAUDE.md content (if present). The PARENT transcript is NOT included.
- `tools` = `agent.tools ?? parent.allowedTools`, then intersected with parent's allowed set. If intersection empty → error `"subagent has no usable tools"`.
- `skills` = only those in `agent.skills`; empty → no skills injected.
- `model` = `agent.model ?? parent.model`.
- `maxTurns` / `maxTokens` = agent frontmatter values (prompt 01 defaults).
- `depth` = `parent.depth + 1`. If `depth > 2` → refuse with `"subagent depth exceeded"` (configurable `config.agents.maxDepth`, default 2).
- `parentSessionId` = propagated for audit / event tagging.

### Dispatch flow

1. Look up agent by `subagent_type` in the registry. 404 → emit `subagent.end { reason: "unknown_agent" }` and return tool error.
2. Check depth; enforce.
3. Acquire semaphore slot (wait if full).
4. Emit `subagent.start { parentSessionId, subagentSessionId, agentName, description }`.
5. Build isolated context; start a new OpenCode session with that context.
6. Stream subagent events upstream, rewriting `sessionId` to the parent's id and adding a `subagent` metadata field with `{ sessionId, name, depth }` so consumers can group them.
7. On model turn end or tool output containing the expected summary, capture final assistant text.
8. Enforce `maxTurns` and `maxTokens`. On exceed: terminate subagent cleanly, emit `subagent.end { reason: "max_turns"|"max_tokens" }`. Tool result still returns whatever summary was produced.
9. Release semaphore slot (in `finally`).
10. Tool result payload: `{ summary: string, usage: { input_tokens, output_tokens }, turns: number, reason: "complete"|"max_turns"|... }`.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/agents engine/src/tools/task.test.ts
bun run lint
```

### Expected output

- Tool registry exposes `Task` to the model.
- 3 parallel dispatches run concurrently, 4th waits. No deadlock.
- Subagent events are interleaved in the parent event stream but never crossed within the same `tool_use_id`.

### Tests to add

- `semaphore.test.ts` — 5 tasks, cap 3; assert only 3 run simultaneously, 4th starts after one completes; timing via fake clock or `Promise.all` + resolver ordering.
- `context.test.ts`:
  - Empty tool intersection → throws `"no usable tools"`.
  - Depth > max → throws `"depth exceeded"`.
  - `model`/`maxTurns`/`maxTokens` fallbacks.
- `dispatch.test.ts` (integration with mocked OpenCode session):
  - Unknown subagent → tool error with `unknown_agent`.
  - Successful dispatch emits start + end events with matching session ids.
  - `max_turns` exceeded → `subagent.end { reason: "max_turns" }`.
- `task-tool.test.ts`:
  - Model emits `Task` tool call → handler returns the summary payload.
  - Tool input validation: missing `prompt` → tool error (not thrown).

### Verification

```bash
bun run test engine/src/agents engine/src/tools   # expect: all green
bun run typecheck
bun run lint

# Manual smoke with two example agents
bun run build
./dist/cli.js run "Dispatch the echo subagent with prompt 'hello world' and return its summary."
```

You should see `subagent.start` then `subagent.end` events in the stream.

### Common pitfalls

- `p-limit` returns a function, not a class — cache the instance at module init.
- Forgetting to release the semaphore on error → deadlock. Use try/finally.
- Event ids: every subagent event must carry the parent `sessionId` AND the subagent's own `sessionId` so consumers can render trees.
- Tool result must be serializable (no Error instances, no functions).
- Do NOT let the subagent inherit the parent's transcript — that defeats the whole isolated-context point.
- CLAUDE.md: read once per engine boot, cache; don't re-read per dispatch.
- Nested Task calls: enforce depth in dispatch, not in the tool handler, so even custom callers can't bypass.
- When the subagent fails mid-turn, the Task tool should still return a graceful tool result (with `reason: "error"`) — never throw out of the handler; the parent turn must continue.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: check off 06.02 in COMPLETION-LOG.md, next prompt = prompts/phase-06/03-verify-hook-patch.md. -->
<!-- END paste -->
