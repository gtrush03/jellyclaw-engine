---
id: T3-03-plan-mode-toggle-tools
tier: 3
title: "Add EnterPlanMode / ExitPlanMode model-invocable tools"
scope:
  - "engine/src/tools/plan-mode.ts"
  - "engine/src/tools/plan-mode.test.ts"
  - "engine/src/tools/index.ts"
  - "engine/src/permissions/types.ts"
  - "engine/src/permissions/engine.ts"
  - "engine/src/agents/loop.ts"
depends_on_fix:
  - T2-06-permission-mode-wiring
tests:
  - name: plan-mode-tools-registered
    kind: shell
    description: "listTools() contains EnterPlanMode and ExitPlanMode with the correct input schemas"
    command: "bun run test engine/src/tools/plan-mode -t registered"
    expect_exit: 0
    timeout_sec: 30
  - name: enter-plan-blocks-edits
    kind: shell
    description: "after EnterPlanMode, a subsequent Edit tool call is denied by permission engine"
    command: "bun run test engine/src/tools/plan-mode -t enter-plan-blocks-edits"
    expect_exit: 0
    timeout_sec: 45
  - name: exit-plan-restores-prior-mode
    kind: shell
    description: "ExitPlanMode restores the permissions.mode that was active before EnterPlanMode"
    command: "bun run test engine/src/tools/plan-mode -t exit-plan-restores-prior-mode"
    expect_exit: 0
    timeout_sec: 45
human_gate: false
max_turns: 40
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 60
---

# T3-03 — Plan-mode toggle tools

## Context
Claude Code exposes `EnterPlanMode` and `ExitPlanMode` to the model. When active, plan mode blocks every side-effectful tool so the assistant drafts a plan before touching anything. Jellyclaw already understands `"plan"` mode in the permission engine (`engine/src/permissions/engine.ts:170-173`, `:244-248`), but the model has no way to toggle into or out of it mid-session — plan mode is only settable at session bootstrap via CLI flag.

## Root cause (from audit)
- `engine/src/permissions/engine.ts:165-173` — plan mode denies side-effectful tools correctly, but `perms.mode` is immutable after compile (the `CompiledPermissions` is frozen at session start).
- `engine/src/tools/index.ts:40` — no `EnterPlanMode` or `ExitPlanMode` tools registered.
- `engine/src/agents/loop.ts:129` — `permService = opts.toolPermissionService ?? makePermissionService()` — there is no mutable-mode surface threaded through the loop.

## Fix — exact change needed
1. **Mutable mode surface.** Add a small controller in `engine/src/permissions/types.ts`:
   ```ts
   export interface PermissionModeController {
     current(): CompiledPermissions["mode"];
     set(next: CompiledPermissions["mode"]): void;
   }
   export function makePermissionModeController(initial: CompiledPermissions["mode"]): PermissionModeController;
   ```
   Implementation is a closure over a mutable variable. Thread it through `AgentLoopOptions` at `engine/src/agents/loop.ts:48-79` as a new required field `modeController`. Update the `decide()` call at `loop.ts:371-380` to pass `{ ...opts.permissions, mode: opts.modeController.current() }` — a shallow override; `CompiledPermissions` stays frozen for everything except the mode field.
2. **Tool `EnterPlanMode`:**
   - Input schema: `{ type: "object", properties: { plan: { type: "string", description: "The plan to present to the user." } }, required: ["plan"], additionalProperties: false }`.
   - Handler: reads current mode via `ctx.permissions` (extend `PermissionService` to expose `getController()`), snapshots the prior mode on a module-level `Map<sessionId, priorMode>`, calls `controller.set("plan")`, returns the string `"plan mode entered — all side-effectful tools now blocked"`. Include the input `plan` verbatim in the returned output so the transcript shows what was planned.
3. **Tool `ExitPlanMode`:**
   - Input schema: `{ type: "object", properties: {}, additionalProperties: false }`.
   - Handler: reads the snapshot from the module-level map; if no snapshot exists (model called exit without enter), restore to `"default"`. Calls `controller.set(prior)`, deletes the snapshot, returns `"plan mode exited; restored to <prior>"`.
4. **Classifier.** In `engine/src/permissions/engine.ts:42-48` `defaultIsSideEffectFree()`, add `EnterPlanMode` and `ExitPlanMode` to `READ_ONLY_TOOLS` (they're control-plane, zero side effects). Otherwise they'd be blocked while in plan mode — a self-denying recursion.
5. **Register both tools** in `engine/src/tools/index.ts`.
6. **Tests in `engine/src/tools/plan-mode.test.ts`:**
   - `registered` — `listTools()` includes both tools with schemas matching the fixtures (create `test/fixtures/tools/claude-code-schemas/EnterPlanMode.json` + `ExitPlanMode.json` from Anthropic's published shape).
   - `enter-plan-blocks-edits` — call `EnterPlanMode` through the loop, then call `Edit`, assert `tool.error { code: "permission_denied" }` and the Edit handler never runs.
   - `exit-plan-restores-prior-mode` — start in `"default"`, call Enter then Exit, assert controller `current()` returns `"default"` again and a subsequent `Edit` is no longer denied by plan-mode logic (may still go through the ask handler — that's fine).

## Acceptance criteria
- Both tools registered and invoked through the loop (maps to `plan-mode-tools-registered`).
- `EnterPlanMode` activates plan-mode mid-session, blocks Write/Edit/Bash (maps to `enter-plan-blocks-edits`).
- `ExitPlanMode` restores the snapshotted prior mode (maps to `exit-plan-restores-prior-mode`).
- Existing `mode: "plan"` behavior from CLI flag unchanged (no regression).

## Out of scope
- Do NOT add a TUI/dashboard indicator badge for active plan mode — UI polish is a T4 prompt.
- Do NOT persist plan-mode state across sessions — it's per-session only.
- Do NOT let plan-mode snapshots nest beyond depth 1 (enter-enter-exit → prior restored once; second enter snapshots fresh).

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/tools/plan-mode
bun run test engine/src/permissions/engine
```
