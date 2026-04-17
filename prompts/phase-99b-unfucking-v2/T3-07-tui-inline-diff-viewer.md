---
id: T3-07-tui-inline-diff-viewer
tier: 3
title: "Render Edit/Write tool calls as an inline diff view in the TUI transcript"
scope:
  - "engine/src/tui/components/diff-view.tsx"
  - "engine/src/tui/components/diff-view.test.tsx"
  - "engine/src/tui/components/tool-call.tsx"
  - "engine/src/tui/components/transcript.tsx"
  - "engine/src/tui/lib/diff.ts"
  - "engine/src/tui/lib/diff.test.ts"
depends_on_fix: []
tests:
  - name: edit-renders-diff-card
    kind: shell
    description: "an Edit tool call message renders a <DiffView> with +/- prefixed lines"
    command: "bun run test engine/src/tui/components/diff-view -t edit-renders-diff"
    expect_exit: 0
    timeout_sec: 30
  - name: write-renders-full-insert
    kind: shell
    description: "a Write tool call (no prior content) renders all lines with + prefix"
    command: "bun run test engine/src/tui/components/diff-view -t write-renders-full-insert"
    expect_exit: 0
    timeout_sec: 30
  - name: large-diff-collapses
    kind: shell
    description: "a diff with > 40 changed lines collapses to first 20 + last 20 with a '… N lines elided' marker"
    command: "bun run test engine/src/tui/components/diff-view -t large-diff-collapses"
    expect_exit: 0
    timeout_sec: 30
  - name: non-edit-tools-unchanged
    kind: shell
    description: "Bash/Read/Grep tool calls still render via <ToolCall>, not <DiffView>"
    command: "bun run test engine/src/tui/components/tool-call -t non-edit-tools-use-toolcall"
    expect_exit: 0
    timeout_sec: 30
human_gate: true
max_turns: 60
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 90
---

# T3-07 — Inline diff viewer in TUI transcript

## Context
Phase 10.5 promised an "inline diff viewer" for Edit/Write tool calls. Reality: `engine/src/tui/components/tool-call.tsx:26-45` renders every tool call as the same bordered card with a truncated body. Users see `old_string: "foo"\nnew_string: "bar"` jammed into a text blob — no visual indication of what actually changed. Claude Code renders Edit calls as a GitHub-style diff.

## Root cause (from audit)
- `engine/src/tui/components/tool-call.tsx:17-22` — generic card, no per-tool branching.
- `engine/src/tui/components/transcript.tsx` — routes every `ToolCallMessage` to `<ToolCall>` without discrimination.
- No diff library is in the deps. Either import `diff` (MIT, tiny, zero-dep) or hand-roll a Myers LCS. Hand-rolling avoids a new dep but is ~80 lines; `diff@7.x` is 22KB unpacked and widely audited.

## Fix — exact change needed
1. **Add `diff` dep.** `bun add diff` + `bun add -d @types/diff`. Pin to `^7.0.0`. This is a scoped change — ONE new runtime dep, documented in the commit message.
2. **New `engine/src/tui/lib/diff.ts`:**
   ```ts
   export interface DiffLine {
     readonly kind: "add" | "del" | "ctx";
     readonly text: string;
   }
   export function unifiedDiff(oldText: string, newText: string, contextLines?: number): DiffLine[];
   ```
   Wrap `diff.diffLines()` and project into `DiffLine[]`. Default `contextLines = 3`.
3. **New component `engine/src/tui/components/diff-view.tsx`:**
   - Props: `{ diff: DiffLine[]; maxRows?: number; }` — default `maxRows = 40`.
   - Render each line inside a `<Box>` with:
     - `add` → green foreground, `"+ "` prefix. Use `brand.mizuya` (Obsidian & Gold green accent) — check `engine/src/tui/theme/brand.ts` for the exact token; if no green token, add one alongside the existing tokens (`brand.diffAdd` at `brand.ts`, value `#5A8C66` for gold-tinted green).
     - `del` → red foreground, `"- "` prefix. Use `brand.rust` or add `brand.diffDel` (`#8C5A5A`).
     - `ctx` → `brand.tidewater` (muted) foreground, `"  "` prefix.
   - Border: `borderStyle: "single"`, `borderColor: brand.gold`. Match the existing `<ToolCall>` aesthetic.
   - When `diff.length > maxRows`: render first `maxRows / 2` lines, then a `<Text color={brand.tidewaterDim}>{"… N lines elided …"}</Text>`, then the last `maxRows / 2` lines. Also render a hint: `"[press 'd' to expand]"` — BUT do NOT implement the keybinding in this prompt; the hint is visual only and a T4 follow-up wires the state.
4. **Route Edit / Write / NotebookEdit through `<DiffView>` in `engine/src/tui/components/transcript.tsx`:**
   - For `ToolCallMessage` where `tool_name ∈ {"Edit", "Write", "NotebookEdit"}`:
     - Parse `input` to get `old_string` + `new_string` (Edit) or `file_path` + `content` (Write) or `old_source` + `new_source` (NotebookEdit). For Write: `old = ""`, `new = content`.
     - Compute `unifiedDiff(old, new)`, render `<DiffView diff={...} />`.
     - Fall back to `<ToolCall>` if parsing fails (defensive).
   - For all other tools: continue to render via `<ToolCall>` — zero regression.
5. **Tests:**
   - `engine/src/tui/lib/diff.test.ts` — cover `unifiedDiff` happy path + empty strings + identical strings.
   - `engine/src/tui/components/diff-view.test.tsx` — use `ink-testing-library`:
     - `edit-renders-diff` — render `<DiffView>` with a 2-line del + 2-line add; assert the frame contains `"- "` and `"+ "` prefixes.
     - `write-renders-full-insert` — `unifiedDiff("", "a\nb\nc")` → 3 add lines.
     - `large-diff-collapses` — 50 added lines → rendered output contains `"lines elided"`.
   - `engine/src/tui/components/tool-call.test.tsx` add `non-edit-tools-use-toolcall` — a `Bash` call still renders via `<ToolCall>`.

## Acceptance criteria
- Edit tool calls render as a recognizable diff (maps to `edit-renders-diff-card`).
- Write renders an all-add diff (maps to `write-renders-full-insert`).
- Diffs >40 lines collapse (maps to `large-diff-collapses`).
- Non-Edit tools unchanged (maps to `non-edit-tools-unchanged`).
- `bun run typecheck` + `bun run lint` clean.

## Why `human_gate: true`
This prompt changes visible TUI output and adds a new runtime dep (`diff`). George should eyeball the rendering and the dep-review diff before we auto-commit.

## Out of scope
- Do NOT wire a keybinding to expand collapsed diffs — the hint string is visual only for now.
- Do NOT change `<PermissionModal>` previews — that's a different surface.
- Do NOT add a side-by-side view — unified only.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/tui/lib/diff
bun run test engine/src/tui/components/diff-view
bun run test engine/src/tui/components/tool-call
```
