# 005 — Jellyclaw wordmark (vendored `logo.ts` rewrite)

**Tag:** `[genie-specific]` `[doc-only patch-log; source edit lives in
`engine/src/tui/_vendored/opencode/src/cli/logo.ts`]`

**Not a `patch-package` patch.** The jellyclaw TUI vendors a copy of
OpenCode's source tree under `engine/src/tui/_vendored/opencode/`, so edits
to those files are made directly in-tree (no runtime diff). This note is
the change-log entry for one such edit, kept alongside the
`patch-package`-era notes in `patches/` so future reviewers have a single
drawer to open when asking "what did we change in the vendored OpenCode
tree and why?".

## Scope

One file changed:

- `engine/src/tui/_vendored/opencode/src/cli/logo.ts`

Two consumers were re-verified (no edits required — the `{ left, right }`
export shape is unchanged):

- `engine/src/tui/_vendored/opencode/src/cli/ui.ts` (non-TTY `logo()` path
  still calls `glyphs.left` / `glyphs.right` directly).
- `engine/src/tui/_vendored/opencode/src/cli/cmd/tui/component/logo.tsx`
  (Solid `<Logo>` component still iterates `logo.left` / `logo.right` and
  renders the shadow-marker chars `_ ^ ~` — none of which appear in the
  new wordmark, which is the intended flat-stencil treatment per the
  brand brief).

One smoke test added:

- `engine/src/tui/logo.test.ts` — asserts the new wordmark contains each
  of the 9 letters `J E L L Y C L A W` in order after stripping block
  glyphs, that every row in each half is the same printable-column width,
  and that each half has exactly 5 rows.

## Motivation

The pre-rebrand vendored `logo.ts` was carrying OpenCode's original
7-glyph "opencode" wordmark shapes with the middle letters swapped out,
which caused the splash to render something like `JELL4CLH` / `JELLYCLW`
— letters were truncated or substituted to fit the old 7-slot grid. The
brand brief calls for a full 9-letter **JELLYCLAW** stencil at exactly 5
rows tall, built only from `█ ▀ ▄ ▌ ▐`, with 1-column letter kerning and
matching width across rows so there's no redraw jitter.

## Design decisions

1. **Data-only module, no ANSI in `logo.ts`.** The vendored `<Logo>`
   component is a Solid + OpenTUI renderer that pulls its colors from
   `useTheme()` — not from chalk/picocolors. Adding a colour dep here
   would (a) violate `CLAUDE.md`'s "no new deps without a phase" rule and
   (b) duplicate Agent 3's theme JSON. The cyan→violet gradient the brief
   requires is delivered by painting the `left` half with
   `theme.textMuted` (= `#3BA7FF` Jelly Cyan) and the `right` half with
   `theme.text` (= `#9E7BFF` Medusa Violet). That split happens in
   `component/logo.tsx` today — no call-site change needed — and
   degrades automatically to flat 256-colour via the theme's
   `textMuted` / `text` anchors on non-truecolor terminals.

2. **Left = `JELLY`, right = `CLAW`.** The consumer renders the two
   halves with different inks; splitting the wordmark at this boundary
   means the gradient "step" lands in the visual middle of the word,
   which matches the brief's "one colour step per letter, J→W" direction
   (the human eye treats the `Y`/`C` junction as the midpoint).

3. **Letter widths and kerning.** Narrow letters (J, E, L, L, C, L) are
   4 cols; wide letters with internal negative space (Y, A, W) are 5
   cols; all letters are separated by a single space column. Row widths
   are 25 cols (left) and 21 cols (right) with an additional 1-col
   `GAP` inserted by `component/logo.tsx`, totalling 47 printable
   columns — fits an 80-col TTY with 30+ cols of breathing room.

4. **No shadow markers.** The renderer still supports `_ ^ ~` (full
   shadow cell, letter-top/shadow-bottom, shadow-top) for drop-shadow
   variants. The brief calls for a stencil-cut steel treatment, not a
   drop shadow, so the new glyphs use only `█ ▀ ▄ ▌ ▐` plus spaces. The
   `marks` export is retained so any downstream variant that does want
   shadows can keep parsing without feature-detection.

5. **No sub-mark (jellyfish silhouette) added.** The brief allows one
   above-wordmark line (hero spinner frame 4's `▄▅▆▇█▇▆▅▄`). It's
   deliberately omitted here because the Solid `<Logo>` component is a
   fixed-layout renderer that sizes itself from `FULL[0]?.length` —
   adding a wider/narrower sub-mark row would require touching
   `component/logo.tsx` mouse/hit-detection, which is Agent 3's
   adjacent surface. The splash route
   (`routes/session/index.tsx`) already renders the static hero spinner
   frame above the wordmark, so the "mark + wordmark" pairing the brief
   asks for is delivered at the composition layer, not inside
   `logo.ts`.

## Call-site impact

Zero. `logo.ts` exports `{ logo: { left: string[]; right: string[] },
marks: string }` — same names, same shapes as pre-rewrite. Both
consumers (`ui.ts` and `component/logo.tsx`) iterate by index and pass
each row string through their own render pipeline.

## Known follow-up (not in this change)

`cli/ui.ts` contains a *separate*, hard-coded 4-row 40-col wordmark
array (lines 7–12) that still spells "opencode" and is used by the
non-TTY `logo()` branch when neither `stdout` nor `stderr` is a TTY.
That array is independent of `logo.ts`'s `{ left, right }` export. A
future patch should either delete that array (and have the non-TTY
branch fall back to a plain-text "jellyclaw" + version string) or
regenerate it from `logo.{left,right}` so there is exactly one source
of truth. Out of scope for this Agent 2 pass — flagged for the next
rebrand sweep.

## Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run engine/src/tui/logo.test.ts
bun run build
```

Expected: typecheck clean, smoke test green, build succeeds. Visual
verification (actually booting `jellyclaw tui` and eyeballing the splash
under truecolor + 256-colour + non-TTY) is the parent agent's pass, not
Agent 2's.
