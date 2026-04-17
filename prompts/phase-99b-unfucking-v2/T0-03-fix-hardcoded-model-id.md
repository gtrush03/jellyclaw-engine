---
id: T0-03-fix-hardcoded-model-id
tier: 0
title: "Replace hardcoded claude-opus-4-6 with real model + resolver"
scope:
  - "engine/src/cli/run.ts"
  - "engine/src/cli/serve.ts"
  - "engine/src/providers/models.ts"
depends_on_fix: []
tests:
  - name: run-uses-default-model
    kind: jellyclaw-run
    description: "jellyclaw run defaults to claude-sonnet-4-5 when no flag/config/env is set"
    command: "JELLYCLAW_LOG_LEVEL=debug ANTHROPIC_API_KEY=sk-test-stub node engine/bin/jellyclaw run 'hello' --output-format json || true"
    wait_for_stderr: "claude-sonnet-4-5"
    timeout_sec: 15
    teardown: "process exits on its own"
  - name: model-registry-unit
    kind: shell
    description: "known-model registry rejects unknown model ids"
    command: "bun run test engine/src/providers/models"
    expect_exit: 0
  - name: run-respects-model-flag
    kind: jellyclaw-run
    description: "--model flag overrides default in the debug log"
    command: "JELLYCLAW_LOG_LEVEL=debug ANTHROPIC_API_KEY=sk-test-stub node engine/bin/jellyclaw run 'hi' --model claude-opus-4-5 --output-format json || true"
    wait_for_stderr: "claude-opus-4-5"
    timeout_sec: 15
    teardown: "process exits on its own"
human_gate: false
max_turns: 25
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 25
---

# T0-03 — Fix hardcoded `claude-opus-4-6` model id

## Context
`run` and `serve` both hardcode the model id `"claude-opus-4-6"` — a string that does not correspond to any real Anthropic model. Every agent call ships with a bogus model and the provider rejects it. The fix: centralise model resolution with a real default and a known-model registry.

## Root cause (from audit)
- `engine/src/cli/run.ts:146` passes `model: "claude-opus-4-6"` into `runAgentLoop({...})`.
- `engine/src/cli/serve.ts:31` sets `const DEFAULT_SERVE_MODEL = "claude-opus-4-6";` and wires it into `createRunManager` at `:364`.
- There is no central list of known models, so typos in `--model` fall through silently.

## Fix — exact change needed
1. Create new file `engine/src/providers/models.ts` exporting:
   - `KNOWN_MODELS: readonly string[]` including at least `"claude-sonnet-4-5"`, `"claude-opus-4-5"`, `"claude-haiku-4-5"`.
   - `DEFAULT_MODEL = "claude-sonnet-4-5"` (real id).
   - `isKnownModel(id: string): boolean` (zod-backed or pure guard; no `any`).
   - `resolveModel(opts: { flag?: string; configModel?: string; env?: NodeJS.ProcessEnv }): string` that applies priority: (1) `flag`, (2) `configModel`, (3) `env.ANTHROPIC_DEFAULT_MODEL`, (4) `DEFAULT_MODEL`. Throws `InvalidModelError extends Error` if the resolved id is not in `KNOWN_MODELS`.
   - Adjacent vitest file `engine/src/providers/models.test.ts` covering each priority rung and the unknown-id rejection.
2. In `engine/src/cli/run.ts`:
   - Import `{ resolveModel }` from `../providers/models.js`.
   - At `run.ts:146`, replace the hardcoded string with the resolver result. The resolver's `flag` arg is `opts.model` (thread `options.model` from `RunCliOptions` through `realRunFn`'s caller; `RunOptions` already allows forwarding — add a `model?: string` field if absent).
   - Read `configModel` by lazily loading `~/.jellyclaw/config.json` (best-effort; on parse failure, treat as undefined — do NOT throw).
3. In `engine/src/cli/serve.ts`:
   - Delete the `DEFAULT_SERVE_MODEL` constant at `:31`.
   - At the `defaultModel:` assignment (currently `:364`), call `resolveModel({ env: process.env })` and pass the result.
4. All new code: strict TS, no `any`, zod at boundaries (config.json parse), pino for any log, `import type` for type-only.

## Acceptance criteria
- `jellyclaw run` with no flags emits a debug log containing `claude-sonnet-4-5` (maps to `run-uses-default-model`).
- `jellyclaw run --model claude-opus-4-5` emits a debug log containing `claude-opus-4-5` (maps to `run-respects-model-flag`).
- `engine/src/providers/models.test.ts` passes, covering unknown-id rejection (maps to `model-registry-unit`).
- No occurrence of `"claude-opus-4-6"` remains in the repo under `engine/src/`.

## Out of scope
- Do not touch `engine/src/agents/loop.ts` — `maxTurns`/`maxOutputTokens` defaults are T1 territory.
- Do not add model-pricing data. Registry is names-only for now.
- Do not add a `--list-models` subcommand.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/providers/models
grep -R "claude-opus-4-6" engine/src/ && echo "STILL PRESENT" || echo "clean"
JELLYCLAW_LOG_LEVEL=debug ANTHROPIC_API_KEY=sk-test node engine/bin/jellyclaw run "hi" --output-format json 2>&1 | head -5
```
