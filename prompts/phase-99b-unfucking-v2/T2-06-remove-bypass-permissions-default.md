---
id: T2-06-remove-bypass-permissions-default
tier: 2
title: "Stop hardcoding bypassPermissions; resolve mode from flag/settings/env/default"
scope:
  - "engine/src/cli/run.ts"
  - "engine/src/cli/permission-mode-resolver.ts"
  - "engine/src/cli/permission-mode-resolver.test.ts"
depends_on_fix:
  - T2-05-load-settings-json
tests:
  - name: default-mode-prompts-for-permission
    kind: shell
    description: "with no flag / no settings, mode defaults to 'default' and a tool with no allow rule triggers an ask"
    command: "bun run test engine/src/cli/permission-mode-resolver -t default-mode"
    expect_exit: 0
    timeout_sec: 30
  - name: bypass-flag-still-works
    kind: shell
    description: "--permission-mode bypassPermissions restores current behaviour (no ask, no deny)"
    command: "bun run test engine/src/cli/permission-mode-resolver -t bypass-via-flag"
    expect_exit: 0
    timeout_sec: 30
  - name: plan-mode-blocks-writes
    kind: shell
    description: "--permission-mode plan blocks Write/Edit/Bash tool calls at the permission engine"
    command: "bun run test engine/src/cli/permission-mode-resolver -t plan-mode-blocks"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 30
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 30
---

# T2-06 — Remove the `bypassPermissions` hardcode

## Context
Every `jellyclaw run` currently executes with `mode: "bypassPermissions"` baked in — the permission engine is short-circuited and neither the hook gate's `deny` nor user settings' `deny` rules can stop a tool. This is a dev-convenience default that leaked into production. The permission engine is already battle-ready (`engine/src/permissions/engine.ts`, `decide()`), the modes are already modelled in the CLI option type (`RunCliOptions.permissionMode`), and the enum is already in the Zod config schema — only the resolver and the wiring are missing.

## Root cause (from audit)
- `engine/src/cli/run.ts:131` — `compilePermissions({ mode: "bypassPermissions" })` hardcodes the mode with no resolver.
- `engine/src/cli/run.ts:329` — `void maxTurns; void maxCostUsd; void allowedTools; void disallowedTools;` — `options.permissionMode` is one of the ignored fields (see `run.ts:44` `RunCliOptions.permissionMode`).
- `engine/src/cli/main.ts` defines the `--permission-mode` Commander flag but never propagates it to the engine.
- There is no existing environment-variable convention; Anthropic's CLI uses `CLAUDE_PERMISSION_MODE` — we MUST NOT claim that namespace. Use `JELLYCLAW_PERMISSION_MODE`.

## Fix — exact change needed
1. **New file `engine/src/cli/permission-mode-resolver.ts`** — export:
   - `type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan"`.
   - `resolvePermissionMode(input: { flag?: string; settings?: string; env?: NodeJS.ProcessEnv }): PermissionMode` with priority (first wins): (1) `flag`, (2) `settings` (read from `loadClaudeSettings(...).permissions.defaultMode`), (3) `env.JELLYCLAW_PERMISSION_MODE`, (4) `"default"`.
   - Validate inputs against the PermissionMode enum; unknown values throw `InvalidPermissionModeError extends Error` with a listing of valid values. No `any`. Use Zod guard.
2. **`engine/src/cli/run.ts`** — remove the `"bypassPermissions"` hardcode at `:131`. Replace with:
   ```
   const mode = resolvePermissionMode({ flag: options.permissionMode, settings: settingsDefaultMode, env: process.env });
   const permissions = compilePermissions({ mode, allow, deny, ask });
   ```
   where `allow/deny/ask` come from the T2-05 loader. Remove `options.permissionMode` from the `void …` block at `run.ts:329`.
3. **Tests** (`engine/src/cli/permission-mode-resolver.test.ts`):
   - `default-mode` — no flag, no settings, no env → returns `"default"`; `decide()` against a call with no rules returns `"ask"` (or handler-required).
   - `bypass-via-flag` — flag `"bypassPermissions"` wins over settings and env.
   - `plan-mode-blocks` — flag `"plan"` → `decide()` on a `Write` or `Edit` tool returns `"deny"` regardless of allow-rules (per the plan-mode invariant at `engine/src/permissions/engine.ts:14-16`).
   - Invalid flag value → `InvalidPermissionModeError` with a helpful message.

## Acceptance criteria
- `default-mode-prompts-for-permission` — resolver + engine cooperate; default mode no longer blanket-allows (maps to test 1).
- `bypass-flag-still-works` — explicit bypass is still available for dev ergonomics (maps to test 2).
- `plan-mode-blocks-writes` — plan mode enforces the side-effect-free invariant (maps to test 3).
- No occurrence of `compilePermissions({ mode: "bypassPermissions" })` remains in `engine/src/cli/`.

## Out of scope
- Do NOT wire an interactive `askHandler` in this prompt — that is T3 work. In default mode without a handler, calls resolve to `deny` per the permission engine's default-deny invariant (documented at `engine/src/permissions/engine.ts:12`). Tests assert this behaviour, not interactive UX.
- Do NOT touch `engine/src/permissions/**` — always-human-review scope per AUTOBUILD-PHASES.md.
- Do NOT migrate existing scripts that rely on the old behaviour. Document the BC break in the PR description (the worker lists it in its completion summary).

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/cli/permission-mode-resolver
grep -n '"bypassPermissions"' engine/src/cli/run.ts && echo "HARDCODE REMAINS" || echo "clean"
```
