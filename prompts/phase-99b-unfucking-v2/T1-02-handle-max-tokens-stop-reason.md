---
id: T1-02-handle-max-tokens-stop-reason
tier: 1
title: "Emit session.error when model stops with stop_reason=max_tokens"
scope:
  - "engine/src/agents/loop.ts"
  - "engine/src/agents/loop.test.ts"
depends_on_fix: []
tests:
  - name: max-tokens-emits-error
    kind: shell
    description: "a turn that ends with stop_reason=max_tokens and no pending tools emits session.error{code: max_output_tokens}"
    command: "bun run test engine/src/agents/loop -t max-tokens-stop-reason"
    expect_exit: 0
    timeout_sec: 60
  - name: normal-stop-emits-completed
    kind: shell
    description: "a normal end_turn still emits session.completed (no regression)"
    command: "bun run test engine/src/agents/loop -t end-turn-stop-reason"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 30
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 25
---

# T1-02 — Handle `stop_reason: max_tokens`

## Context
When the model hits `max_tokens` mid-answer the adapter sets `state.stopReason = "max_tokens"` and the provider stream ends. The loop then checks `queuedTools.length === 0`, sees no tools queued, and calls `adaptDone` — emitting `session.completed` as if the answer were complete. Users see a mid-sentence truncated response labeled "success" and have no signal to retry. Fix: detect `max_tokens` explicitly and surface it as a typed error.

## Root cause (from audit)
- `engine/src/agents/loop.ts:223-230` — when `queuedTools.length === 0 && adapterToolErrors.length === 0`, the loop unconditionally emits `session.completed` via `adaptDone`. It does NOT consult `state.stopReason`.
- `engine/src/providers/adapter.ts:289-290` — adapter already writes `state.stopReason` from `message_delta.delta.stop_reason`, so the signal is available.
- Impact: a user's long-form answer ends mid-sentence and the CLI prints "done" with no error.

## Fix — exact change needed
1. In `engine/src/agents/loop.ts`, immediately after the stream `for await` block completes (around `loop.ts:220`) and before the `queuedTools.length === 0` check at `:223`, inspect `state.stopReason`:
   ```ts
   if (queuedTools.length === 0 && adapterToolErrors.length === 0 && state.stopReason === "max_tokens") {
     yield {
       type: "session.error",
       session_id: opts.sessionId,
       ts: now(),
       seq: state.seq++,
       code: "max_output_tokens",
       message: `model response truncated at max_output_tokens=${maxOutputTokens} (turn ${turn})`,
       recoverable: true,
     };
     return;
   }
   ```
2. If `session.error.recoverable` is not currently a field on the event, keep `recoverable: false` to match existing shape — match whatever the other `session.error` emissions in this file already use. Do NOT widen the event schema.
3. Preserve the existing flow for all other `stop_reason` values (`end_turn`, `tool_use`, `stop_sequence`) — only `max_tokens` triggers the new branch.
4. Add two vitest cases to `engine/src/agents/loop.test.ts`:
   - `max-tokens-stop-reason`: stub a provider whose final `message_delta` yields `stop_reason: "max_tokens"` with no tool_use blocks. Assert the generator yields a `session.error` with `code: "max_output_tokens"` and does NOT yield `session.completed`.
   - `end-turn-stop-reason`: same shape but `stop_reason: "end_turn"`. Assert `session.completed` is still emitted.

## Acceptance criteria
- `stop_reason: "max_tokens"` with no queued tools → `session.error{code: "max_output_tokens"}` (maps to `max-tokens-emits-error`).
- `stop_reason: "end_turn"` → `session.completed` unchanged (maps to `normal-stop-emits-completed`).
- Tool-use continuation (stop_reason "tool_use") is unchanged — handled by existing code path.

## Out of scope
- Do NOT implement auto-continue / multi-turn extension here. That's T3 territory.
- Do NOT change `maxOutputTokens` default — that's T1-03.
- Do NOT touch adapter logic in `engine/src/providers/adapter.ts`.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/agents/loop
grep -n "max_output_tokens" engine/src/agents/loop.ts
```
