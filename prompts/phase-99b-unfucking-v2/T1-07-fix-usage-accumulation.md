---
id: T1-07-fix-usage-accumulation
tier: 1
title: "Fix token usage accumulation: adapter replaces per-turn, reducer double-counts"
scope:
  - "engine/src/providers/adapter.ts"
  - "engine/src/providers/adapter.test.ts"
  - "engine/src/session/reduce.ts"
  - "engine/src/session/reduce.test.ts"
depends_on_fix: []
tests:
  - name: adapter-accumulates-usage-across-turns
    kind: shell
    description: "output_tokens in usage.updated events is monotonically non-decreasing across turns"
    command: "bun run test engine/src/providers/adapter -t usage-accumulates"
    expect_exit: 0
    timeout_sec: 30
  - name: reducer-does-not-double-count
    kind: shell
    description: "replaying a session's events produces the same cumulative usage the adapter emitted last"
    command: "bun run test engine/src/session/reduce -t usage-no-double-count"
    expect_exit: 0
    timeout_sec: 30
  - name: jsonl-replay-round-trip
    kind: shell
    description: "write events to JSONL, replay+reduce, final usage matches in-memory reduce"
    command: "bun run test engine/src/session/reduce -t usage-replay-round-trip"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 40
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 45
---

# T1-07 — Fix token usage accumulation

## Context
Two bugs compound. The provider adapter REPLACES `state.outputTokens` every turn (`engine/src/providers/adapter.ts:280`), so a 3-turn session with outputs [100, 200, 300] emits `usage.updated` events reading `output_tokens: 100`, `200`, `300` — NOT the cumulative `[100, 300, 600]` callers expect. Meanwhile the session reducer at `engine/src/session/reduce.ts:46-58` SUMS every `usage.updated` event it sees — so the reducer's final `outputTokens` becomes `100+200+300 = 600`, which happens to be right by coincidence but only because the adapter was emitting per-turn values. If either bug is fixed in isolation, totals break. Fix both together.

## Root cause (from audit)
- `engine/src/providers/adapter.ts:280` — `if (output !== undefined) state.outputTokens = output;` (assignment, should be `+=`).
- `engine/src/providers/adapter.ts:281-286` — same pattern for `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`. All assignments, all per-turn replacement.
- `engine/src/session/reduce.ts:46-58` — `accumulateUsage(prev, ev)` does `prev.outputTokens + ev.output_tokens`, treating each `usage.updated` event as a DELTA.
- Contract intent (from the rest of the codebase): `usage.updated.output_tokens` is a CUMULATIVE session-total. The reducer should therefore OVERWRITE (take max / last) not SUM.
- Impact: token counts in the dashboard are wrong, cost caps (T1-06) compute on the wrong numbers, the Haiku self-check / Sonnet tester budget tracking (AUTOBUILD-PHASES.md) is unreliable.

## Fix — exact change needed
1. In `engine/src/providers/adapter.ts:277-287`, change the four usage assignments to accumulate:
   ```ts
   const output = num(usage.output_tokens);
   if (output !== undefined) state.outputTokens += output;
   const input = num(usage.input_tokens);
   if (input !== undefined) state.inputTokens += input;
   const cacheRead = num(usage.cache_read_input_tokens);
   if (cacheRead !== undefined) state.cacheReadTokens += cacheRead;
   const cacheWrite = num(usage.cache_creation_input_tokens);
   if (cacheWrite !== undefined) state.cacheWriteTokens += cacheWrite;
   ```
   Rationale: Anthropic's `message_delta.usage` carries DELTAS per message (per assistant turn). Summing them into `AdapterState` across turns gives the cumulative session total in every emitted `usage.updated` event.
2. In `engine/src/session/reduce.ts:46-58`, change `accumulateUsage` to take-last-seen instead of sum:
   ```ts
   function accumulateUsage(
     _prev: CumulativeUsage,
     ev: Extract<AgentEvent, { type: "usage.updated" }>,
   ): CumulativeUsage {
     const costCents = ev.cost_usd === undefined ? 0 : Math.round(ev.cost_usd * 100);
     return {
       inputTokens: ev.input_tokens,
       outputTokens: ev.output_tokens,
       cacheReadTokens: ev.cache_read_tokens,
       cacheWriteTokens: ev.cache_write_tokens,
       costUsdCents: costCents,
     };
   }
   ```
   Rename the function to `takeLatestUsage` to reflect the new semantics; update the single call site.
3. Update existing tests that bake in the old behavior:
   - `engine/src/session/reduce.test.ts:257` (`"usage.updated accumulates across events + rounds cost_usd to cents"`) — rename + rewrite: feed two events with cumulative-total values, assert the reducer's final state matches the last event.
4. Add three new vitest cases:
   - `usage-accumulates` in `engine/src/providers/adapter.test.ts`: feed three `message_delta` chunks with per-turn usage `{output: 100}`, `{output: 200}`, `{output: 300}`; assert the three emitted `usage.updated` events read `output_tokens: 100, 300, 600` (strictly monotonic).
   - `usage-no-double-count` in `engine/src/session/reduce.test.ts`: feed the events from the adapter test above into `reduceEvents`; assert final `outputTokens === 600` (matches adapter's last emission, not `900`).
   - `usage-replay-round-trip` in `engine/src/session/reduce.test.ts`: write the same events through `writeJsonl` + `replayJsonl` + `reduceEvents`; assert identical final usage.

## Acceptance criteria
- Adapter emits monotonically non-decreasing `output_tokens` (maps to `adapter-accumulates-usage-across-turns`).
- Reducer takes last-seen cumulative values; replay matches in-memory (maps to `reducer-does-not-double-count`).
- JSONL round-trip gives identical usage totals (maps to `jsonl-replay-round-trip`).

## Out of scope
- Do NOT change `AgentEvent.usage_updated` schema shape — field names and types stay.
- Do NOT touch `engine/src/providers/gate.ts` (separate cost-guard concern).
- Do NOT alter cost_usd computation logic in `AnthropicProvider` — only fix accumulation.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/providers/adapter
bun run test engine/src/session/reduce
grep -nE "state\.(output|input|cacheRead|cacheWrite)Tokens = " engine/src/providers/adapter.ts && echo "STILL ASSIGNING" || echo "clean"
```
