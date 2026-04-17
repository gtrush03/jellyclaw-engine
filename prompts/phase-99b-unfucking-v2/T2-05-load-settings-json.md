---
id: T2-05-load-settings-json
tier: 2
title: "Load ~/.claude/settings.json layering into HookRegistry + CompiledPermissions"
scope:
  - "engine/src/config/settings-loader.ts"
  - "engine/src/config/settings-loader.test.ts"
  - "engine/src/cli/run.ts"
depends_on_fix: []
tests:
  - name: pretooluse-hook-from-settings-fires
    kind: shell
    description: "a PreToolUse hook declared in project settings.json runs when a tool is called"
    command: "bun run test engine/src/config/settings-loader -t pre-tool-hook-loaded"
    expect_exit: 0
    timeout_sec: 60
  - name: deny-rule-blocks-tool
    kind: shell
    description: "a 'deny' permission rule from settings.json causes the tool call to be denied by the permission engine"
    command: "bun run test engine/src/config/settings-loader -t deny-rule-blocks"
    expect_exit: 0
    timeout_sec: 60
  - name: layering-order-user-project-local
    kind: shell
    description: "project settings override user; local settings override both; deny-wins across layers"
    command: "bun run test engine/src/config/settings-loader -t layering-priority"
    expect_exit: 0
    timeout_sec: 60
human_gate: false
max_turns: 45
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 55
---

# T2-05 — Load settings.json into HookRegistry + CompiledPermissions

## Context
The existing CLI path installs **empty** hooks and a **bypass-all** permission policy at every invocation. Users cannot configure PreToolUse/PostToolUse hooks or permission rules via `~/.claude/settings.json` even though both the hook registry and the permission engine fully support it. T2-05 adds the settings loader + CLI wiring. T2-06 removes the bypass default (separate concern).

## Root cause (from audit)
- `engine/src/cli/run.ts:130` — `const hooks = new HookRegistry([], { logger });` — the config array is hardcoded empty.
- `engine/src/cli/run.ts:131` — `const permissions = compilePermissions({ mode: "bypassPermissions" });` — rules arrays (`allow`, `deny`, `ask`) are never populated. Mode hardcoded (addressed in T2-06).
- `engine/src/config.ts` — the jellyclaw Zod schema exists but does NOT include hooks or a Claude-compatible settings.json shape. Claude Code's settings.json carries `{ hooks: {...}, permissions: { allow:[...], deny:[...], ask:[...] } }` as documented in Claude Code's public docs.
- There is no layered-settings loader anywhere in the engine.

## Fix — exact change needed
1. **New file `engine/src/config/settings-loader.ts`** — export:
   - `ClaudeSettings` Zod schema with:
     - `hooks: z.record(z.enum(["PreToolUse","PostToolUse","UserPromptSubmit","Stop","SubagentStop","Notification"]), z.array(HookConfig))` where `HookConfig` matches the shape already accepted by `engine/src/hooks/registry.ts:~30-80` (matcher, command/type, timeout).
     - `permissions: z.object({ allow: z.array(z.string()).default([]), deny: z.array(z.string()).default([]), ask: z.array(z.string()).default([]), additionalDirectories: z.array(z.string()).default([]), defaultMode: z.enum(["default","acceptEdits","bypassPermissions","plan"]).optional() })`.
   - `loadClaudeSettings(opts: { home?; cwd?; overrideMode?: PermissionMode })` — read, parse, and merge in this order (later wins for scalars; deny-lists concatenate; hook arrays concatenate by event kind):
     1. `~/.claude/settings.json`
     2. `./.claude/settings.json`
     3. `./.claude/settings.local.json`
   - Returns `{ hookConfigs: HookConfig[], permissions: CompiledPermissions, warnings: string[] }`. Permission compilation goes through existing `compilePermissions({allow, deny, ask, mode})`. Mode resolution priority: `overrideMode` → `settings.permissions.defaultMode` → `undefined` (let T2-06's resolver decide).
   - MUST not throw on missing files (treat as empty). On JSON parse error, collect into `warnings` and continue with the remaining layers.
2. **`engine/src/cli/run.ts:realRunFn`** — replace the hardcoded `new HookRegistry([], ...)` and `compilePermissions({mode:"bypassPermissions"})` with:
   ```
   const { hookConfigs, permissions } = await loadClaudeSettings({ overrideMode: options.permissionMode });
   const hooks = new HookRegistry(hookConfigs, { logger });
   ```
   Thread `options.permissionMode` through `RunCliOptions` → `RunOptions` → `realRunFn`. (Currently voided at `run.ts:329`.)
3. **Tests** (`engine/src/config/settings-loader.test.ts`):
   - `pre-tool-hook-loaded` — write tmp `~/.claude/settings.json` with `{hooks:{PreToolUse:[{matcher:"Bash",command:"echo from-hook",timeout:5000}]}}`, call `loadClaudeSettings({home})`, drive a fake tool call through `runHooks`, assert the `PreToolUse` hook fired.
   - `deny-rule-blocks` — settings with `{permissions:{deny:["Bash(rm -rf *)"]}}`. Call `decide()` from `permissions/engine.ts` against the compiled result; assert `decision: "deny"` for a matching `Bash` call.
   - `layering-priority` — `~/.claude/settings.json` allows Bash, `./.claude/settings.json` denies Bash, assert deny wins. `./.claude/settings.local.json` adds a Bash ask rule, assert still denied (deny-wins).

## Acceptance criteria
- `pretooluse-hook-from-settings-fires` — hooks declared in settings.json execute via the real `HookRegistry` (maps to test 1).
- `deny-rule-blocks-tool` — deny rules from settings flow into `CompiledPermissions` and block at `decide()` (maps to test 2).
- `layering-order-user-project-local` — precedence + deny-wins invariant preserved (maps to test 3).

## Out of scope
- Do NOT change the permission mode default here — that is T2-06.
- Do NOT implement `additionalDirectories` wiring — that is T2-10 (`--add-dir`).
- Do NOT support environment-variable interpolation inside settings.json — future work.
- Do NOT touch `engine/src/hooks/**` or `engine/src/permissions/**` — both are "always-human-review" per AUTOBUILD-PHASES.md. The loader consumes their public API only.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/config/settings-loader
bun run test engine/src/hooks engine/src/permissions
```
