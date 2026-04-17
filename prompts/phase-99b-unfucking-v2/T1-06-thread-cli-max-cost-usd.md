---
id: T1-06-thread-cli-max-cost-usd
tier: 1
title: "Thread --max-cost-usd flag into agent loop budget"
scope:
  - "engine/src/cli/run.ts"
  - "engine/src/internal.ts"
  - "engine/src/agents/loop.ts"
  - "engine/src/agents/loop.test.ts"
  - "engine/src/cli/run.test.ts"
depends_on_fix: []
tests:
  - name: max-cost-usd-threaded
    kind: shell
    description: "--max-cost-usd 0.01 aborts the loop via session.error{code: max_cost_usd_exceeded}"
    command: "bun run test engine/src/cli/run -t max-cost-threaded"
    expect_exit: 0
    timeout_sec: 30
  - name: max-cost-usd-unlimited-by-default
    kind: shell
    description: "when --max-cost-usd is not supplied, the loop runs without a cost gate"
    command: "bun run test engine/src/agents/loop -t max-cost-unlimited-default"
    expect_exit: 0
    timeout_sec: 30
  - name: max-cost-error-code-stable
    kind: shell
    description: "the emitted session.error code is literally 'max_cost_usd_exceeded'"
    command: "bun run test engine/src/agents/loop -t max-cost-error-code"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 35
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 30
---

# T1-06 — Thread `--max-cost-usd` through the CLI

## Context
`engine/src/cli/run.ts:329` parses `--max-cost-usd` and discards it with `void maxCostUsd;`. The agent loop has an untested `maxBudgetUsd` path already (`engine/src/agents/loop.ts:183-200`) that aborts on cost overrun — but it emits `code: "budget_exceeded"`. Wire the CLI flag through and standardize the error code to `max_cost_usd_exceeded` so consumers (Genie, jelly-claw) can pattern-match reliably.

## Root cause (from audit)
- `engine/src/cli/run.ts:248` — `const maxCostUsd = parseFloatStrict(options.maxCostUsd, "--max-cost-usd");` parsed.
- `engine/src/cli/run.ts:330` — `void maxCostUsd;` — discarded.
- `engine/src/agents/loop.ts:183-200` — existing cost gate fires `code: "budget_exceeded"` (inconsistent name).
- Impact: no way to cap agent spend from the CLI; hackathon-style runs go unbounded.

## Fix — exact change needed
1. In `engine/src/internal.ts`, add `maxCostUsd?: number` to `RunOptions` (readonly).
2. In `engine/src/cli/run.ts`:
   - At `:330`, remove `void maxCostUsd;`.
   - At the `runOptions` construction (`:323-325`), add: `if (maxCostUsd !== undefined) runOptions.maxCostUsd = maxCostUsd;`.
   - In `realRunFn` (`:120-158`), forward: pass `maxBudgetUsd: opts.maxCostUsd` into `runAgentLoop` (only when defined — respect `exactOptionalPropertyTypes`).
3. In `engine/src/agents/loop.ts:194`, change:
   ```ts
   code: "budget_exceeded",
   ```
   to:
   ```ts
   code: "max_cost_usd_exceeded",
   ```
   Also tighten the `message` to: `cumulative cost $${ev.cost_usd.toFixed(4)} exceeded cap $${opts.maxBudgetUsd.toFixed(4)}`.
4. Add three vitest cases:
   - `max-cost-threaded` in `engine/src/cli/run.test.ts`: drive `createRunAction` with `options.maxCostUsd = "0.01"`; assert `runFn` receives `runOptions.maxCostUsd === 0.01`.
   - `max-cost-unlimited-default` in `engine/src/agents/loop.test.ts`: no `maxBudgetUsd` passed; stub provider yielding `usage.updated{cost_usd: 99.99}`; assert the loop completes normally (no session.error).
   - `max-cost-error-code` in `engine/src/agents/loop.test.ts`: pass `maxBudgetUsd: 0.05`; stub provider emitting `usage.updated{cost_usd: 1.0}`; assert the generator yields `session.error` with `code: "max_cost_usd_exceeded"` verbatim.

## Acceptance criteria
- `--max-cost-usd 0.01` threaded into the loop (maps to `max-cost-usd-threaded`).
- Default is unlimited — absence of flag ⇒ no gating (maps to `max-cost-usd-unlimited-by-default`).
- Error code is literally `max_cost_usd_exceeded` (maps to `max-cost-error-code-stable`).

## Out of scope
- Do NOT introduce a global daily/per-session cost tracker — that's the autobuild rig's concern, not the engine.
- Do NOT rename `AgentLoopOptions.maxBudgetUsd` (it's stable public API). Only the emitted error code changes.
- Do NOT thread `--max-turns` here (that's T1-05).

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/agents/loop
bun run test engine/src/cli/run
grep -n "void maxCostUsd" engine/src/cli/run.ts && echo "STILL PRESENT" || echo "clean"
grep -n "budget_exceeded" engine/src/ && echo "STILL PRESENT" || echo "clean"
```
