---
id: T1-04-tui-statusbar-input-polish
tier: 1
title: "Polish status bar + input box + slash-command hints"
scope:
  - engine/src/tui/components/status-bar.tsx
  - engine/src/tui/components/input-box.tsx
  - engine/src/tui/components/status-bar.test.tsx
  - engine/src/tui/commands/
  - engine/src/tui/hooks/
depends_on_fix:
  - T1-03-tui-transcript-toolcall-polish
tests:
  - name: statusbar-unit
    kind: shell
    description: "status bar renders model + cost + context pills"
    command: "bun run test engine/src/tui/components/status-bar"
    expect_exit: 0
    timeout_sec: 60
  - name: input-unit
    kind: shell
    description: "input box: multi-line, history, paste"
    command: "bun run test engine/src/tui/components/input-box"
    expect_exit: 0
    timeout_sec: 60
  - name: commands-registry
    kind: shell
    description: "slash commands registry exports, matches autocomplete"
    command: "bun run test engine/src/tui/commands"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 35
max_cost_usd: 10
max_retries: 3
estimated_duration_min: 25
---

# T1-04 — Status bar + input box + command hints

## Context
Design brief § 2: status bar should show model pill + cost pill +
context-used pill right-aligned, with the session slug left-aligned. Input
box should support multi-line (Shift+Enter), paste (bracketed paste), and
slash-command autocomplete.

## Work

### 1. `status-bar.tsx`
- Layout (one row): `<session-slug> · <cwd-basename> <right-align> <model-pill> <cost-pill> <ctx-pill>`.
- Pills use `typography.pill` (bold) + a tinted background. Because Ink can't
  do real backgrounds with color, simulate with `<Text backgroundColor>` on a
  short label (e.g. ` opus-4-7 `).
- Model pill: `jellyCyan` bg.
- Cost pill: `amberEye` bg, shown only when > $0.01.
- Context pill: `medusaViolet` bg, shows `<used>/<max>` tokens.
- Narrow terminal (< 80 cols): collapse to `<model-pill>` only.

### 2. `input-box.tsx`
- Multi-line: Shift+Enter inserts newline, Enter submits.
- Paste: bracketed paste sequence `\x1b[200~…\x1b[201~` stripped; content
  merged as single submission if no newlines, else multi-line.
- History: Up / Down cycles through last 50 submissions (persisted in
  `~/.jellyclaw/history.jsonl`, 0600 perms).
- Placeholder text when empty (dim): `"Ask jellyclaw · / for commands"`.
- Slash-command hint strip shown below input when text starts with `/`:
  top 5 matching commands from registry, with short descriptions.

### 3. `commands/` registry
- Read current commands dir. Ensure a `registry.ts` exports a `Command[]`
  with `{ name, aliases, description, handler }`.
- Add at least these if missing: `/help`, `/clear`, `/exit`, `/key` (open
  key-rotation flow), `/model <id>` (change model mid-session).
- Autocomplete matches prefix against `name` + `aliases`.

### 4. Hooks
- `useHistory` — loads/persists `~/.jellyclaw/history.jsonl`; ring buffer 50.
- `useSlashCompletion(input, registry)` — pure; returns top 5 matches.

## Acceptance criteria
- All 3 unit tests green.
- `bun run typecheck` + `bun run lint` clean.
- No inline hex colors in any `components/*.tsx` (same grep rule as T1-03).
- History file perms exactly `0600` (verified in a test).
- Session manual smoke: `node engine/bin/jellyclaw tui`, type `/he`, see
  autocomplete strip with `/help` first.

## Out of scope
- Landing page — T2.
- Web TUI container — T3.
- Anything in `transcript.tsx` — done in T1-03.

## Verification the worker should self-run before finishing
```bash
bun run test engine/src/tui/components/status-bar engine/src/tui/components/input-box engine/src/tui/commands
bun run typecheck && bun run lint
grep -E "#[0-9A-Fa-f]{6}" engine/src/tui/components/status-bar.tsx engine/src/tui/components/input-box.tsx && echo "INLINE HEX — FAIL" || echo "clean"
echo "DONE: T1-04-tui-statusbar-input-polish"
```
