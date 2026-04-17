---
id: T3-01-implement-compaction
tier: 3
title: "Auto-compact conversation at 80% of model context window"
scope:
  - "engine/src/agents/loop.ts"
  - "engine/src/agents/compaction.ts"
  - "engine/src/agents/compaction.test.ts"
  - "engine/src/agents/loop.test.ts"
depends_on_fix:
  - T1-02-handle-max-tokens-stop-reason
  - T1-03-raise-max-output-tokens-default
tests:
  - name: long-transcript-triggers-compaction
    kind: shell
    description: "transcript that exceeds 80% of context window is summarized before next turn; messages[] shrinks"
    command: "bun run test engine/src/agents/compaction -t long-transcript-triggers-compaction"
    expect_exit: 0
    timeout_sec: 60
  - name: precompact-hook-fires
    kind: shell
    description: "PreCompact hook is invoked with { sessionId, tokenCount, threshold } payload before rewrite"
    command: "bun run test engine/src/agents/compaction -t precompact-hook-fires"
    expect_exit: 0
    timeout_sec: 60
  - name: summary-replaces-old-messages
    kind: shell
    description: "after compaction, messages[] = [summary, ...last-3-turns]; older turns are dropped"
    command: "bun run test engine/src/agents/compaction -t summary-replaces-old-messages"
    expect_exit: 0
    timeout_sec: 60
human_gate: false
max_turns: 50
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 75
---

# T3-01 — Auto-compact conversation at 80% of model context window

## Context
Claude Code silently summarizes long conversations when the input-token budget approaches the model's context window, so sessions don't die with HTTP 400 `prompt_too_long`. Jellyclaw has a `PreCompact` hook kind declared at `engine/src/hooks/types.ts:39` and schema-exported at `engine/src/hooks/types.ts:127-131`, but **nothing ever fires it** — the agent loop has no compaction pass. A 25-turn session with heavy tool output (even after T1-01's 200KB cap) will eventually 400 out.

## Root cause (from audit)
- `engine/src/agents/loop.ts:142-295` — the main turn loop pushes onto `messages[]` (`:256-259`, `:280-283`) without ever summarizing. No token accounting against a context-window budget.
- `engine/src/hooks/types.ts:127-131` — `PreCompactPayload { sessionId, tokenCount, threshold }` is defined but has zero call sites outside test scaffolding.
- `engine/src/agents/loop.ts:182-187` — `usage.updated` events expose running input-token counts, but the loop never consults them for a compaction trigger.

## Fix — exact change needed
1. **New module `engine/src/agents/compaction.ts`** exposing:
   ```ts
   export interface ContextBudget { readonly windowTokens: number; readonly triggerRatio: number; }
   export function contextBudgetForModel(model: string): ContextBudget;
   // Returns { windowTokens: 200_000, triggerRatio: 0.8 } for Sonnet/Opus/Haiku 4.x.
   // Covers claude-{opus,sonnet,haiku}-4-*, claude-3-5-*. Unknown → { 200_000, 0.8 } (safe default).
   export async function compactMessages(args: {
     readonly messages: ReadonlyArray<Anthropic.Messages.MessageParam>;
     readonly system: readonly SystemBlock[];
     readonly provider: Provider;
     readonly model: string;
     readonly sessionId: string;
     readonly signal: AbortSignal;
     readonly logger: Logger;
   }): Promise<{ readonly summary: string; readonly rewritten: Anthropic.Messages.MessageParam[] }>;
   ```
   - `compactMessages` issues a single non-streaming provider turn with a system prompt: `"Produce a compact running summary of the conversation so far, preserving every file path, tool invocation, and open task. Return prose only."`
   - It returns `rewritten = [{ role: "user", content: "[prior-conversation-summary] " + summary }, ...lastThreeTurns]` where a "turn" is one user→assistant pair (keep the last 3 fully, including any trailing `tool_result` block).
2. **In `engine/src/agents/loop.ts:142-154`**, before building `req`, sum `inputTokens` from state (track a running total via the adapter's `usage.updated` events). If `running_input_tokens >= budget.windowTokens * budget.triggerRatio`:
   - Fire the `PreCompact` hook with `{ sessionId: opts.sessionId, tokenCount: running_input_tokens, threshold: Math.floor(budget.windowTokens * budget.triggerRatio) }` via `runHooks`.
   - If hook result is `deny`, skip this iteration's compaction and proceed (compaction is advisory, not required — matches Claude Code behavior).
   - Otherwise call `compactMessages(...)`, replace the local `messages[]` array, and reset the running-token counter to an estimate of the new prefix size (approx `summary.length / 4`).
3. **Track running input tokens.** Widen the `for await (const chunk of …)` block at `loop.ts:164-204` so that when `ev.type === "usage.updated"`, add `ev.input_tokens + ev.cache_read_tokens + ev.cache_write_tokens` to a `runningInputTokens` accumulator declared at turn-scope. This is intentionally cumulative across turns — compaction is evaluated at the top of each turn.
4. **Tests in `engine/src/agents/compaction.test.ts`:**
   - `long-transcript-triggers-compaction` — build 30 fake turns at ~6K tokens each, stub the provider to return a short summary, assert the loop calls `compactMessages` exactly once and `messages.length` drops to `1 + (3*2) = 7`.
   - `precompact-hook-fires` — spy on `runHooks`; assert a call with `event.kind === "PreCompact"` and payload matching the formula.
   - `summary-replaces-old-messages` — after compaction, assert `messages[0].role === "user"` and its content starts with `"[prior-conversation-summary]"`.
5. Add one integration test in `engine/src/agents/loop.test.ts` covering the happy path — the loop keeps running after a compaction pass, no error events.

## Acceptance criteria
- 80%-of-window trigger fires compaction exactly once per overflow event (not per turn).
- `PreCompact` hook fires with correct payload (maps to `precompact-hook-fires`).
- After compaction, `messages[]` = `[summary, ...last 3 turns]` (maps to `summary-replaces-old-messages`).
- `bun run typecheck` + `bun run lint` clean.

## Out of scope
- Do NOT add a `/compact` slash command (UI follow-up, separate prompt if needed).
- Do NOT persist compaction history to `~/.jellyclaw/sessions/` — the session writer already records `messages[]` snapshots.
- Do NOT handle partial compaction (e.g. "summarize only tool results") — one-shot full compact is the target.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/agents/compaction
bun run test engine/src/agents/loop
```
