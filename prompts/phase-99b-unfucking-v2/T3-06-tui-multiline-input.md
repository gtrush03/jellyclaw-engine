---
id: T3-06-tui-multiline-input
tier: 3
title: "Replace ink-text-input with a multi-line raw-stdin editor in TUI InputBox"
scope:
  - "engine/src/tui/components/input-box.tsx"
  - "engine/src/tui/components/input-box.test.tsx"
  - "engine/src/tui/hooks/use-multiline-input.ts"
  - "engine/src/tui/hooks/use-multiline-input.test.ts"
depends_on_fix: []
tests:
  - name: multiline-paste-preserved
    kind: shell
    description: "pasting a 3-line string via stdin produces a state with 3 rendered lines and a single internal string containing \\n"
    command: "bun run test engine/src/tui/hooks/use-multiline-input -t paste-preserved"
    expect_exit: 0
    timeout_sec: 30
  - name: shift-enter-newline
    kind: shell
    description: "Shift+Enter inserts a newline; Enter submits"
    command: "bun run test engine/src/tui/hooks/use-multiline-input -t shift-enter-newline"
    expect_exit: 0
    timeout_sec: 30
  - name: arrow-navigation-works
    kind: shell
    description: "Up/Down/Left/Right arrows move the caret correctly across line boundaries"
    command: "bun run test engine/src/tui/hooks/use-multiline-input -t arrow-navigation"
    expect_exit: 0
    timeout_sec: 30
  - name: ctrl-a-ctrl-e-home-end
    kind: shell
    description: "Ctrl-A jumps to line start, Ctrl-E jumps to line end"
    command: "bun run test engine/src/tui/hooks/use-multiline-input -t ctrl-a-e"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 50
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 90
---

# T3-06 — Multi-line TUI input

## Context
`engine/src/tui/components/input-box.tsx:11` carries a TODO noting that `ink-text-input@6` is single-line only. Pasting a multi-line prompt into the TUI silently joins lines (or worse, the first `\n` submits partial input). Claude Code's TUI handles multi-line natively: Shift+Enter inserts a newline, Enter submits, arrow keys navigate, Ctrl-A/E jump to line bounds.

## Root cause (from audit)
- `engine/src/tui/components/input-box.tsx:16-52` — imports `TextInput` from `ink-text-input` and delegates everything to it. The TODO comment at `:11-13` explicitly flags this is deferred.
- `ink-text-input@6` documentation: single-line only, no API for custom keybindings or multi-line buffer.
- Ink 5 ships a `useInput` hook that reads raw stdin keystrokes — this is the replacement vector.

## Fix — exact change needed
1. **New hook `engine/src/tui/hooks/use-multiline-input.ts`:**
   ```ts
   export interface MultilineInputState {
     readonly value: string;       // full string, lines joined by "\n"
     readonly caret: { line: number; col: number };
   }
   export interface UseMultilineInputArgs {
     readonly value: string;
     readonly onChange: (next: string) => void;
     readonly onSubmit: (text: string) => void;
     readonly disabled?: boolean;
   }
   export function useMultilineInput(args: UseMultilineInputArgs): MultilineInputState;
   ```
   Wire Ink's `useInput((input, key) => { … })` to:
   - **Enter** (`key.return === true` AND `key.shift === false`) → call `onSubmit(value)` and do NOT mutate buffer.
   - **Shift+Enter** (`key.return && key.shift`) → insert `"\n"` at caret.
   - **Left/Right** → move caret one column; wrap across lines.
   - **Up/Down** → move caret one line; preserve column when possible (clamp to line length).
   - **Ctrl-A** (`key.ctrl && input === "a"`) → caret.col = 0 for current line.
   - **Ctrl-E** (`key.ctrl && input === "e"`) → caret.col = current line length.
   - **Backspace** (`key.backspace || key.delete`) → delete the char before caret; if caret is at col 0, merge with previous line.
   - **Printable** (`input` is a string, not a control char) → insert at caret; handle multi-char paste in ONE `input` callback (Ink batches terminal paste).
2. **Rewrite `engine/src/tui/components/input-box.tsx`:**
   - Remove `ink-text-input` import.
   - Mount `useMultilineInput(...)` when not disabled; render lines as `<Text>{line}</Text>` rows inside the `<Box>`.
   - Render the caret as a single inverse-video character (use Ink's `inverse` prop on a `<Text>`).
   - When disabled, keep the existing `"(streaming…)"` placeholder — unchanged.
   - Preserve the prop surface: `value`, `onChange`, `onSubmit`, `placeholder`, `disabled`. `placeholder` renders as dim text when `value === ""`.
3. **Uninstall `ink-text-input`** — remove the import AND drop the dep from `package.json`. BUT: `engine/src/tui/components/api-key-prompt.tsx:18` also imports it (for the masked API-key field). KEEP that usage — the ApiKeyPrompt is single-line + uses `mask="•"` which our new multi-line hook doesn't support. That's fine; it's a different surface. Do NOT drop the dep from package.json until the ApiKeyPrompt is also migrated — out of scope for this prompt, so leave it.
4. **Tests in `engine/src/tui/hooks/use-multiline-input.test.ts`** use `ink-testing-library` (already in devDeps) to render a harness component that surfaces the hook's state:
   - `paste-preserved` — render harness, simulate `stdin.write("one\ntwo\nthree")` as a single chunk, assert state has `value === "one\ntwo\nthree"` and 3 logical lines.
   - `shift-enter-newline` — type `"hi"`, press Shift+Enter, type `"yo"`. Assert `value === "hi\nyo"`. Press Enter (no shift) — assert `onSubmit` fired with `"hi\nyo"`.
   - `arrow-navigation` — set value to `"abc\ndef"`, press Up twice from (1, 2), assert caret lands at (0, 2).
   - `ctrl-a-e` — on `"hello"` with caret at col 3, Ctrl-A → col 0; Ctrl-E → col 5.

## Acceptance criteria
- Multi-line paste survives intact (maps to `multiline-paste-preserved`).
- Shift+Enter vs Enter behaviors correct (maps to `shift-enter-newline`).
- Arrow navigation works across line boundaries (maps to `arrow-navigation-works`).
- Ctrl-A / Ctrl-E work within the current line (maps to `ctrl-a-ctrl-e-home-end`).
- No regression in the `disabled` streaming state.
- `bun run typecheck` + `bun run lint` clean.

## Out of scope
- Do NOT migrate `engine/src/tui/components/api-key-prompt.tsx:229` off `ink-text-input` — masked single-line field is fine as-is.
- Do NOT add vim-mode bindings — Ctrl-A/E and arrows only.
- Do NOT add auto-complete / history navigation — Ctrl-P/N is future work.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/tui/hooks/use-multiline-input
bun run test engine/src/tui/components/input-box
```
