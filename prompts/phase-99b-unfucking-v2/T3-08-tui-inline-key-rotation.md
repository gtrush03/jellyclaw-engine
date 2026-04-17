---
id: T3-08-tui-inline-key-rotation
tier: 3
title: "Mount ApiKeyPrompt as inline modal on /key instead of exiting TUI"
scope:
  - "engine/src/tui/commands/registry.ts"
  - "engine/src/tui/commands/dispatch.ts"
  - "engine/src/tui/app.tsx"
  - "engine/src/tui/state/types.ts"
  - "engine/src/tui/state/reducer.ts"
  - "engine/src/tui/components/api-key-prompt.tsx"
  - "engine/src/tui/commands/registry.test.ts"
depends_on_fix: []
tests:
  - name: key-command-opens-modal
    kind: shell
    description: "/key dispatches a 'open-key-prompt' action; reducer sets state.modal === 'api-key'"
    command: "bun run test engine/src/tui/state/reducer -t key-command-opens-modal"
    expect_exit: 0
    timeout_sec: 30
  - name: key-modal-persists-and-closes
    kind: shell
    description: "ApiKeyPrompt onAccepted triggers 'close-modal'; state.modal === null; no TUI exit"
    command: "bun run test engine/src/tui/state/reducer -t key-modal-persists-and-closes"
    expect_exit: 0
    timeout_sec: 30
  - name: key-command-does-not-exit
    kind: shell
    description: "ctx.exit is NEVER called by handleKey; was broken behavior in registry.ts:140"
    command: "bun run test engine/src/tui/commands/registry -t key-does-not-exit"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 45
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 75
---

# T3-08 — Inline `/key` rotation (no TUI exit)

## Context
`engine/src/tui/commands/registry.ts:132-141` — today, `/key` prints a message saying "API-key rotation requires a non-TUI terminal" and CALLS `ctx.exit(0)`. The user is thrown out of their session to run `jellyclaw key`, re-auth, and re-enter. That's terrible UX and unnecessary: we already have a working `<ApiKeyPrompt>` Ink component at `engine/src/tui/components/api-key-prompt.tsx:96` that runs inside the Ink render tree.

## Root cause (from audit)
- `engine/src/tui/commands/registry.ts:132-141` — `handleKey` literally calls `ctx.exit(0)` after printing a hint. The comment says this is because "The API-key rotation flow … drives raw stdio" but that comment is stale: `<ApiKeyPrompt>` is a pure Ink component and doesn't touch raw stdio.
- `engine/src/tui/state/types.ts` — `UiState` has no `modal` field. The only modal-ish surface is `pendingPermission`, which is event-driven.
- `engine/src/tui/app.tsx:283-323` — layout has room for a modal overlay between `<Transcript>` and `<InputBox>`, the same slot `<PermissionModal>` currently occupies.

## Fix — exact change needed
1. **Add modal state to `engine/src/tui/state/types.ts`:**
   ```ts
   export type UiModalKind = "api-key" | null;
   export interface UiState {
     ...;
     readonly modal: UiModalKind;
   }
   ```
   Update `createInitialState()` to set `modal: null`.
2. **Reducer actions in `engine/src/tui/state/reducer.ts`:**
   ```ts
   | { kind: "open-modal"; modal: Exclude<UiModalKind, null> }
   | { kind: "close-modal" }
   ```
   Both are pure state swaps. `open-modal` must NOT clear existing state (e.g. transcript, runId).
3. **Rewrite `handleKey` in `engine/src/tui/commands/registry.ts:132-141`:**
   ```ts
   function handleKey(_cmd: ParsedCommand, ctx: CommandContext): void {
     ctx.dispatchAction({ kind: "open-modal", modal: "api-key" });
     ctx.pushSystem("rotate API key — paste a new key below, or Esc to cancel");
   }
   ```
   Remove the `ctx.exit(0)` call entirely. Update the description string at `engine/src/tui/commands/registry.ts:226` to `"rotate API key (inline, no restart)"`.
4. **Mount modal in `engine/src/tui/app.tsx:283-323`:**
   Between the `<Transcript>` block at `:302-311` and `<PermissionModal>` at `:312-314`, add:
   ```tsx
   {state.modal === "api-key" ? (
     <ApiKeyPrompt
       onAccepted={() => dispatch({ kind: "close-modal" })}
       onCancelled={() => dispatch({ kind: "close-modal" })}
     />
   ) : null}
   ```
   Import `<ApiKeyPrompt>` at the top.
5. **Disable input while modal is open.** Update `inputDisabled` at `engine/src/tui/app.tsx:279`:
   ```ts
   const inputDisabled = state.status === "streaming" || state.status === "awaiting-permission" || state.modal !== null;
   ```
6. **Ensure `<ApiKeyPrompt>` continues to work.** No code change needed there — it already calls `updateCredentials()` from `engine/src/cli/credentials.ts` which is process-wide; the next run will pick up the new key via `loadCredentials()`. Verify `engine/src/tui/components/api-key-prompt.tsx:98` — the `useApp().exit` fallback in `cancel` — only fires when `onCancelled` is undefined; our wiring provides it, so no accidental exit.
7. **Tests:**
   - `engine/src/tui/state/reducer.test.ts` — add `key-command-opens-modal` and `key-modal-persists-and-closes`.
   - `engine/src/tui/commands/registry.test.ts` — add `key-does-not-exit`: stub `ctx.exit` as a spy, invoke `handleKey`, assert spy not called and `dispatchAction` called with `{ kind: "open-modal", modal: "api-key" }`.

## Acceptance criteria
- `/key` opens an inline modal; session continues (maps to all three tests).
- New key validates + persists to `~/.jellyclaw/credentials.json` via existing `<ApiKeyPrompt>` logic (already tested in `api-key-prompt.test.tsx`).
- Modal closes on success OR Esc; no process exit in either path.
- `bun run typecheck` + `bun run lint` clean.

## Out of scope
- Do NOT refactor `<ApiKeyPrompt>` to add a "cancel" button — the existing Esc-to-cancel path is sufficient.
- Do NOT remove the `jellyclaw key` subcommand — it's still useful outside the TUI.
- Do NOT add a modal for other commands — that's a T4 polish prompt.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/tui/state/reducer
bun run test engine/src/tui/commands/registry
bun run test engine/src/tui/components/api-key-prompt
```
