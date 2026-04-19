---
id: T1-03-tui-transcript-toolcall-polish
tier: 1
title: "Polish transcript + tool-call + diff + thinking + markdown renderers"
scope:
  - engine/src/tui/components/transcript.tsx
  - engine/src/tui/components/tool-call.tsx
  - engine/src/tui/components/diff-view.tsx
  - engine/src/tui/components/thinking.tsx
  - engine/src/tui/components/markdown.tsx
  - engine/src/tui/components/tool-call.test.tsx
  - engine/src/tui/components/diff-view.test.tsx
depends_on_fix:
  - T1-02-tui-splash-boot-polish
tests:
  - name: components-unit
    kind: shell
    description: "all component tests green"
    command: "bun run test engine/src/tui/components"
    expect_exit: 0
    timeout_sec: 90
  - name: typecheck-lint
    kind: shell
    description: "strict TS + biome clean"
    command: "bun run typecheck && bun run lint"
    expect_exit: 0
    timeout_sec: 180
  - name: markdown-fuzz
    kind: shell
    description: "markdown render doesn't crash on edge cases"
    command: "bun run test engine/src/tui/components/markdown"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 45
max_cost_usd: 15
max_retries: 3
estimated_duration_min: 35
---

# T1-03 — Transcript + tool-call + diff polish

## Context
Design brief § 2 mockups define the target look for each of these five
components. The theme tokens from T1-01 and the new spinner from T1-02 are
in place; this prompt wires them in and polishes.

## Work

### 1. `transcript.tsx`
- Row layout: `<accent-bar> <role-prefix> <content>` with `density.md`
  between rows.
- User accent bar = row accents `user`. Assistant = `assistant`. Tool = `tool`.
- Long assistant messages: word-wrap via `<Text wrap="wrap">`; preserve code
  fences as `<Box borderStyle={borders.round.style} borderColor={tool}>`
  blocks.
- Scroll-back: keep last N rendered rows visible (hook `useMaxHeight()` from
  `hooks/`). Older rows are not re-rendered to preserve terminal scrollback.

### 2. `tool-call.tsx`
- Banner: `[tool] <tool-name> … <spinner|✔|✖>` on one line.
- Expanded detail (default collapsed): args (JSON, 2-line summary) + truncated
  result (≤ 10 lines, "… show more" hint).
- Press `?` over a tool-call row → expand/collapse (existing keymap; if
  missing, add it to `commands/`).
- Tool success = `success` color, error = `error` color, running =
  `amberEye` + spinner.

### 3. `diff-view.tsx`
- Unified diff rendering using `diffAdd` / `diffDel` tokens.
- Hunk header dimmed (`typography.caption`).
- Line wrap: wrap at terminal width − 4; never horizontally scroll.
- Large diffs (>60 lines): collapse body, show "+42 / -17, press Enter to
  expand" summary; Enter binds via `useInput`.

### 4. `thinking.tsx`
- Subtle italic dim text ("thinking…") with minimal spinner from T1-02.
- Stays on screen ≤500ms after last thinking event; then fades to the next
  assistant chunk.

### 5. `markdown.tsx`
- Already uses `marked`? If so, swap to `marked-terminal` OR a tiny custom
  renderer that maps: h1/h2/h3 → bold, code → mono+diffAdd-bg, bullet →
  `  •`, link → underline + foam-colored.
- No deps added if possible — write the 80-line renderer inline.
- Fuzz test: markdown.test.ts feeds 12 edge cases (nested lists, code in
  list, malformed link, unicode headers, empty doc). Must not throw.

### 6. Tests
- Update `tool-call.test.tsx` and `diff-view.test.tsx` snapshots.
- Add `markdown.test.tsx` with fuzz cases.
- Add `transcript.test.tsx` if not present: covers 3 rows (user/assistant/tool)
  rendered in order with correct accents.

## Acceptance criteria
- `bun run test engine/src/tui/components` all green.
- `bun run typecheck` + `bun run lint` clean.
- No hex colors inlined in any `.tsx` file — must reference `brand.*` or
  `typography.*` or `density.*`.
  Enforce via: `grep -E "#[0-9A-Fa-f]{6}" engine/src/tui/components/` returns 0 lines.
- No new runtime deps in `engine/package.json`.

## Out of scope
- Status bar + input box — T1-04.
- Splash/boot — already done in T1-02.

## Verification the worker should self-run before finishing
```bash
bun run test engine/src/tui/components
bun run typecheck
bun run lint engine/src/tui/components
grep -E "#[0-9A-Fa-f]{6}" engine/src/tui/components/ && echo "INLINE HEX — FAIL" || echo "clean"
echo "DONE: T1-03-tui-transcript-toolcall-polish"
```
