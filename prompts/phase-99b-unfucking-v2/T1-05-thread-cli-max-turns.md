---
id: T1-05-thread-cli-max-turns
tier: 1
title: "Thread --max-turns flag into AgentLoopOptions; raise default 25 → 50"
scope:
  - "engine/src/cli/run.ts"
  - "engine/src/agents/loop.ts"
  - "engine/src/internal.ts"
  - "engine/src/agents/loop.test.ts"
  - "engine/src/cli/run.test.ts"
depends_on_fix: []
tests:
  - name: default-max-turns-is-50
    kind: shell
    description: "runAgentLoop uses 50 as the default cap when caller doesn't override"
    command: "bun run test engine/src/agents/loop -t default-max-turns"
    expect_exit: 0
    timeout_sec: 30
  - name: cli-max-turns-threaded
    kind: shell
    description: "--max-turns 10 from the CLI is honored — loop stops after 10 tool-use turns"
    command: "bun run test engine/src/cli/run -t max-turns-threaded"
    expect_exit: 0
    timeout_sec: 30
  - name: cli-max-turns-above-cap-rejected
    kind: shell
    description: "--max-turns 200 errors with a clear message (above MAX_ITERATIONS=150)"
    command: "bun run test engine/src/cli/run -t max-turns-above-cap"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 35
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 30
---

# T1-05 — Thread `--max-turns` through the CLI; raise default to 50

## Context
The CLI at `engine/src/cli/run.ts:329` parses `--max-turns` and then drops it with `void maxTurns;`. Combined with the loop's own default of 25, users get whatever the default is — their flag is silently ignored. Thread the value through, bump the default to 50 (long-running agent sessions routinely exceed 25 tool-use turns), and enforce a hard upper bound of 150.

## Root cause (from audit)
- `engine/src/cli/run.ts:247` — `const maxTurns = parseIntStrict(options.maxTurns, "--max-turns");` parsed.
- `engine/src/cli/run.ts:329` — `void maxTurns;` — intentionally discarded.
- `engine/src/agents/loop.ts:115` — `const maxTurns = opts.maxTurns ?? 25;` default is too low for real-world multi-step work.
- Impact: users who raise their budget via `--max-turns 60` still hit `max_turns_exceeded` at turn 25.

## Fix — exact change needed
1. In `engine/src/agents/loop.ts`:
   - Add a module-level constant near the top:
     ```ts
     export const DEFAULT_MAX_TURNS = 50;
     export const MAX_ITERATIONS = 150;
     ```
   - At `loop.ts:115`, change `const maxTurns = opts.maxTurns ?? 25;` to `const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;`.
   - After that line, validate: `if (maxTurns > MAX_ITERATIONS) throw new Error(`maxTurns=${maxTurns} exceeds MAX_ITERATIONS=${MAX_ITERATIONS}`);`. (The CLI catches and re-throws as `ExitError` — see below.)
2. In `engine/src/internal.ts`, extend `RunOptions` with an optional `maxTurns?: number` field. Follow existing field conventions (readonly, `exactOptionalPropertyTypes`).
3. In `engine/src/cli/run.ts`:
   - At `:329`, remove `void maxTurns;`.
   - At `:323-325` where `runOptions: RunOptions = { wish: prompt }` is built, add `if (maxTurns !== undefined) runOptions.maxTurns = maxTurns;`.
   - In `realRunFn` at `:120-158`, forward `opts.maxTurns` to `runAgentLoop({... maxTurns: opts.maxTurns ...})` (only when defined — respect `exactOptionalPropertyTypes`).
   - Before passing, validate at the CLI layer: if `maxTurns > 150`, throw `new ExitError(2, `--max-turns must be <= 150 (got ${maxTurns})`)`.
4. Add three vitest cases:
   - `default-max-turns` in `engine/src/agents/loop.test.ts`: call `runAgentLoop` with no `maxTurns`; stub provider to loop forever with empty tool calls; assert the `session.error{code:"max_turns_exceeded"}` message contains `maxTurns=50`.
   - `max-turns-threaded` in `engine/src/cli/run.test.ts`: drive `createRunAction` with `options.maxTurns = "10"`; assert `runFn` receives `runOptions.maxTurns === 10`.
   - `max-turns-above-cap` in `engine/src/cli/run.test.ts`: drive with `options.maxTurns = "200"`; assert `ExitError` with message matching `/must be <= 150/`.

## Acceptance criteria
- `--max-turns 10` honored end-to-end (maps to `cli-max-turns-threaded`).
- Default is 50 (maps to `default-max-turns-is-50`).
- `--max-turns 200` rejected with `--max-turns must be <= 150` (maps to `cli-max-turns-above-cap-rejected`).

## Out of scope
- Do NOT also thread `--max-cost-usd` here — that's T1-06.
- Do NOT wire `--allowed-tools` / `--disallowed-tools` (covered by T0-04).
- Do NOT change `MAX_ITERATIONS` value from 150.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/agents/loop
bun run test engine/src/cli/run
grep -n "void maxTurns" engine/src/cli/run.ts && echo "STILL PRESENT" || echo "clean"
```
