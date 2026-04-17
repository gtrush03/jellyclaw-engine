---
id: T0-04-thread-cli-flags
tier: 0
title: "Thread --max-turns / --max-cost-usd / permission / tool flags into runAgentLoop"
scope:
  - "engine/src/cli/run.ts"
depends_on_fix:
  - T0-03-fix-hardcoded-model-id
tests:
  - name: max-turns-flows-through
    kind: jellyclaw-run
    description: "--max-turns=3 is visible in debug log from loop init"
    command: "JELLYCLAW_LOG_LEVEL=debug ANTHROPIC_API_KEY=sk-test node engine/bin/jellyclaw run 'hi' --max-turns 3 --output-format json || true"
    wait_for_stderr: "\"maxTurns\":3"
    timeout_sec: 15
    teardown: "process exits on its own"
  - name: no-void-leftovers
    kind: shell
    description: "the `void maxTurns;` etc. dead statements are gone"
    command: "grep -nE 'void (maxTurns|maxCostUsd|allowedTools|disallowedTools|permissionMode);' engine/src/cli/run.ts || true"
    expect_exit: 0
  - name: run-unit-tests-green
    kind: shell
    description: "existing run.ts tests still pass after threading"
    command: "bun run test engine/src/cli/run"
    expect_exit: 0
human_gate: false
max_turns: 25
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 20
---

# T0-04 — Thread CLI flags into `runAgentLoop`

## Context
`jellyclaw run` parses `--max-turns`, `--max-cost-usd`, `--permission-mode`, `--allowed-tools`, `--disallowed-tools` correctly but then discards them with `void` statements — so the agent loop always runs with defaults. This prompt wires the parsed values into the `AgentLoopOptions` passed to `runAgentLoop`.

## Root cause (from audit)
- `engine/src/cli/run.ts:329-332` currently contains:
  ```ts
  void maxTurns;
  void maxCostUsd;
  void allowedTools;
  void disallowedTools;
  ```
  These statements exist only to silence `noUnusedLocals`; the values never reach the agent.
- `permissionMode` is parsed via Commander but similarly never propagated past `createRunAction`.
- `realRunFn` at `run.ts:120-158` builds `permissions` with a hardcoded `compilePermissions({ mode: "bypassPermissions" })` at `:131` and never reads `options.permissionMode`.

## Fix — exact change needed
1. Delete `engine/src/cli/run.ts:329-332` (all five `void` statements, including `permissionMode` if you add it).
2. Extend `RunOptions` (in `engine/src/internal.ts`, or wherever declared) to optionally carry `maxTurns?: number`, `maxCostUsd?: number`, `allowedTools?: readonly string[]`, `disallowedTools?: readonly string[]`, `permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan"`. If `RunOptions` lives outside `scope`, instead pass the values via a new `AgentLoopParams` local that `realRunFn` reads from a module-scope closure — but prefer the clean option-object approach and add the extension to `internal.ts` (that file is already in `engine/src`; this is a minimal type extension, not logic).
3. In `createRunAction` at `engine/src/cli/run.ts:323-325`, populate the new `RunOptions` fields from the parsed locals.
4. In `realRunFn` at `engine/src/cli/run.ts:142-153`, pass `maxTurns`, `maxOutputTokens` (leave alone; T1), and (critically) `allowedTools`/`disallowedTools` into `runAgentLoop({...})`. Wire `permissionMode` into `compilePermissions({ mode: opts.permissionMode ?? "bypassPermissions" })` at `:131`.
5. If `AgentLoopOptions` does not already accept `allowedTools`/`disallowedTools`, note it in a TODO comment referencing T1 — but still thread `maxTurns` today; that one is already accepted (see `engine/src/agents/loop.ts:115`).
6. No `console.log`. No `any`. Use `import type` for type-only imports.

## Acceptance criteria
- `grep -nE 'void (maxTurns|maxCostUsd|allowedTools|disallowedTools|permissionMode);' engine/src/cli/run.ts` returns zero lines (maps to `no-void-leftovers`).
- Running `jellyclaw run 'hi' --max-turns 3` with debug logging shows `"maxTurns":3` on stderr (maps to `max-turns-flows-through`).
- Existing `engine/src/cli/run.test.ts` continues to pass (maps to `run-unit-tests-green`).

## Out of scope
- Do not change defaults inside `engine/src/agents/loop.ts:115-116` (`maxTurns=25`, `maxOutputTokens=4096`). That is T1.
- Do not refactor `compilePermissions` internals.
- Do not introduce new CLI flags.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/cli/run
grep -nE 'void (maxTurns|maxCostUsd|allowedTools|disallowedTools|permissionMode);' engine/src/cli/run.ts || echo "clean"
JELLYCLAW_LOG_LEVEL=debug ANTHROPIC_API_KEY=sk-test node engine/bin/jellyclaw run "hi" --max-turns 3 2>&1 | grep -o 'maxTurns":3' | head -1
```
