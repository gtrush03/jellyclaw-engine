---
id: T1-03-raise-max-output-tokens-default
tier: 1
title: "Raise default maxOutputTokens from 4096 to 16384"
scope:
  - "engine/src/agents/loop.ts"
  - "engine/src/agents/loop.test.ts"
  - "engine/src/providers/types.ts"
depends_on_fix: []
tests:
  - name: default-max-output-tokens-is-16384
    kind: shell
    description: "runAgentLoop issues ProviderRequest with maxOutputTokens=16384 when caller passes no override"
    command: "bun run test engine/src/agents/loop -t default-max-output-tokens"
    expect_exit: 0
    timeout_sec: 30
  - name: explicit-override-respected
    kind: shell
    description: "caller-provided maxOutputTokens overrides the default"
    command: "bun run test engine/src/agents/loop -t override-max-output-tokens"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 25
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 15
---

# T1-03 — Raise default `maxOutputTokens` to 16384

## Context
Current default `maxOutputTokens: 4096` truncates any moderately-sized answer (code generation, multi-file edits, structured JSON). Claude Sonnet 4.5 supports up to 64K output tokens; 16384 is a safe middle ground that avoids premature truncation for the common case without uncapping runaway streams. The value must remain overridable per-request.

## Root cause (from audit)
- `engine/src/agents/loop.ts:116` — `const maxOutputTokens = opts.maxOutputTokens ?? 4096;`
- Callers (`engine/src/cli/run.ts`, `engine/src/server/run-manager.ts`) do not currently set a value, so the 4096 fallback is what ships.
- Impact: answers truncate at ~4K tokens output (≈3000 words of code). Combined with T1-02, every mid-sentence cutoff now surfaces as `max_output_tokens` error — but with a realistic default, those errors become rare instead of the norm.

## Fix — exact change needed
1. In `engine/src/agents/loop.ts`, introduce a module-level constant at the top of the file (below imports, above `AgentLoopOptions`):
   ```ts
   /** Default per-turn model output budget. Overridable via `AgentLoopOptions.maxOutputTokens`. */
   export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
   ```
2. At `loop.ts:116`, change:
   ```ts
   const maxOutputTokens = opts.maxOutputTokens ?? 4096;
   ```
   to:
   ```ts
   const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
   ```
3. Update the JSDoc on `AgentLoopOptions.maxOutputTokens` (currently at `loop.ts:75-76`) from `"Default 4096."` to `"Default DEFAULT_MAX_OUTPUT_TOKENS (16384)."`.
4. Verify `ProviderRequest.maxOutputTokens` in `engine/src/providers/types.ts:32` is already `number` (not bounded). No change required there — document the fact the field is a hard per-turn cap enforced by the provider.
5. Add two vitest cases to `engine/src/agents/loop.test.ts`:
   - `default-max-output-tokens`: spy on `provider.stream` and assert the received `ProviderRequest.maxOutputTokens === 16384` when the caller passes no `maxOutputTokens` in `AgentLoopOptions`.
   - `override-max-output-tokens`: caller passes `maxOutputTokens: 8192`; assert the request carries `8192`.

## Acceptance criteria
- Default is 16384 (maps to `default-max-output-tokens-is-16384`).
- Explicit caller override respected (maps to `explicit-override-respected`).
- `DEFAULT_MAX_OUTPUT_TOKENS` exported from `engine/src/agents/loop.ts`.

## Out of scope
- Do NOT change `maxTurns` default (that's T1-05).
- Do NOT add per-model dynamic maxOutputTokens resolution. Single constant is fine for T1.
- Do NOT wire a new CLI flag. Caller override remains programmatic.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/agents/loop
grep -n "DEFAULT_MAX_OUTPUT_TOKENS\|4096" engine/src/agents/loop.ts
```
