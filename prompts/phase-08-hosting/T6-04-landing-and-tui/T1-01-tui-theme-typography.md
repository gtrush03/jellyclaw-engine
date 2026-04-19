---
id: T1-01-tui-theme-typography
tier: 1
title: "Refine TUI theme tokens + add typography/density/border scales"
scope:
  - engine/src/tui/theme/brand.ts
  - engine/src/tui/theme/typography.ts
  - engine/src/tui/theme/density.ts
  - engine/src/tui/theme/borders.ts
  - engine/src/tui/theme/index.ts
  - engine/src/tui/theme/theme.test.ts
depends_on_fix:
  - T0-02-ultrathink-design-research
tests:
  - name: theme-unit
    kind: shell
    description: "theme tests pass, tokens exported"
    command: "bun run test engine/src/tui/theme"
    expect_exit: 0
    timeout_sec: 60
  - name: typecheck
    kind: shell
    description: "strict TS still clean"
    command: "bun run typecheck"
    expect_exit: 0
    timeout_sec: 120
  - name: contrast-check
    kind: shell
    description: "all foreground/background pairs hit WCAG AA (4.5:1)"
    command: "bun run test engine/src/tui/theme/contrast"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 35
max_cost_usd: 10
max_retries: 3
estimated_duration_min: 25
---

# T1-01 — TUI theme + typography + density tokens

## Context
`T6-04-DESIGN-BRIEF.md` § 1 defined the palette refinement. This prompt
lands those tokens and adds three sibling token files the rest of T1 will
consume: typography (heading/body/mono weights & heights), density (spacing
scales), and borders (glyph sets for rounded/square/ascii).

Today the TUI only has `brand.ts`. Components inline magic numbers
(`paddingX={1}`, `height={3}`). T1-02/03/04 will replace those with token
references — but first, the tokens must exist.

## Source of truth
- `T6-04-DESIGN-BRIEF.md` § 1 Brand palette (authoritative)
- `engine/src/tui/theme/brand.ts` (existing baseline — preserve exports)

## Work

### 1. Update `engine/src/tui/theme/brand.ts`
Apply Agent A's palette refinement from the design brief. Keep all existing
exports (`brand`, `ROW_ACCENT_VARIANTS`, `rowAccentsFor…`) as stable; only
add or tweak the 3 tokens the brief justified. Bump a new `PALETTE_VERSION`
const (string, semver) — increment minor.

### 2. Create `engine/src/tui/theme/typography.ts`
```ts
export interface Typography {
  readonly heading: { readonly bold: boolean; readonly dimRatio: 1 };
  readonly body: { readonly bold: false; readonly dim: false };
  readonly mono: { readonly bold: false };  // code/tool output
  readonly caption: { readonly bold: false; readonly dim: true };
  readonly pill: { readonly bold: true; readonly underline: false };
}
export const typography: Typography = { /* ... */ };
```
Ink's `<Text>` only has bold/dim/italic/underline — not sizes. The "scale" is
really weight + dim. Keep it simple.

### 3. Create `engine/src/tui/theme/density.ts`
```ts
export interface Density {
  /** Horizontal paddings in columns. */
  readonly padX: { readonly none: 0; readonly sm: 1; readonly md: 2; readonly lg: 3 };
  /** Vertical paddings in rows. */
  readonly padY: { readonly none: 0; readonly sm: 0; readonly md: 1; readonly lg: 2 };
  /** Gap between sibling stacked boxes. */
  readonly gap: { readonly xs: 0; readonly sm: 1; readonly md: 1; readonly lg: 2 };
}
export const density: Density = { /* ... */ };
```

### 4. Create `engine/src/tui/theme/borders.ts`
Ink supports `borderStyle="round"|"single"|"double"|"bold"|"singleDouble"|"doubleSingle"|"classic"|"arrow"`.
```ts
export type BorderVariant = 'round' | 'single' | 'ascii';
export const borders: Record<BorderVariant, { style: string; color: string }> = {
  round:  { style: 'round',  color: brand.tidewaterDim },
  single: { style: 'single', color: brand.tidewaterDim },
  ascii:  { style: 'classic', color: brand.tidewaterDim },
};
```
Add a `pickBorderForTerm(term?: string)` helper that returns `ascii` when
`TERM` is `dumb`/`linux` or `LANG` lacks UTF-8, else `round`.

### 5. Barrel export via `engine/src/tui/theme/index.ts`
Re-export `brand`, `typography`, `density`, `borders`, `PALETTE_VERSION`,
`pickBorderForTerm`, `rowAccentsFor…`. All `export type` for type-only.

### 6. Contrast test — `engine/src/tui/theme/contrast.test.ts`
For every `{foreground,background}` pair used in the brand file, compute
WCAG contrast ratio. Fail the test if any pair is below 4.5:1 (AA normal
text) — except for `tidewaterDim` which is allowed 3:1 (AA large text only).
Use a pure JS contrast ratio implementation (no deps — it's 10 lines).

### 7. Theme snapshot test
`engine/src/tui/theme/theme.test.ts` — vitest snapshot of the full exported
object. Commits the current look as a baseline so T1-02/03/04 can't
accidentally drift tokens.

## Acceptance criteria
- All token files exist, exported via `index.ts`.
- `bun run test engine/src/tui/theme` passes (includes contrast + snapshot).
- `bun run typecheck` clean.
- No component files (`components/*.tsx`) edited — this prompt is tokens
  only. T1-02 onward wires them in.
- `PALETTE_VERSION` bumped (record the new version in the DONE line).

## Out of scope
- Do NOT edit any `components/*.tsx` file.
- Do not add Ink gradient libs — we do gradients via color blending in text.
- No runtime deps.

## Verification the worker should self-run before finishing
```bash
bun run test engine/src/tui/theme
bun run typecheck
bun run lint engine/src/tui/theme
grep -R "padX\|paddingX" engine/src/tui/components/ | head   # untouched
echo "DONE: T1-01-tui-theme-typography (PALETTE_VERSION=<X.Y>)"
```
