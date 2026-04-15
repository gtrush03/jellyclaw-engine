# Phase 10.5 — Brand layer — Prompt 02: Jellyfish spinner + purple theme

**When to run:** After Phase 10.5 prompt 01 (OpenCode TUI vendoring) is ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 60 minutes
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if 10.5.01 not ✅. The vendored TUI at engine/src/tui/ must exist with component/spinner.tsx and context/theme/*.json bundled (35 themes). If not, re-run 10.5.01 before continuing. -->
<!-- END paste -->

## Research task

Read in full before writing any code:

1. `/Users/gtrush/Downloads/jellyclaw-engine/jellyfish-spinner-spec.txt` — the authoritative
   spec for the two spinner variants (compact 7-col × 10-frame; hero 3-line × 8-frame),
   color plan, motion profile, fallback rules, and the JS module shape. The full text is also
   reproduced in the appendix of this prompt so you never need to leave this file.
2. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/component/spinner.tsx` — the
   upstream OpenCode spinner component, vendored in 10.5.01. Study how it imports
   `opentui-spinner`, how it's rendered, and every callsite that references `<Spinner>`.
3. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/context/theme/opencode.json` —
   the canonical OpenCode theme. Use it to learn the exact JSON schema (key names like
   `foreground`, `primaryForeground`, `border`, `accent`, `error`, `warning`, `success`,
   `info`, `muted`, etc.). Your new `jellyclaw.json` must match this schema 1:1 — no
   invented keys, no missing keys.
4. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/context/theme.tsx` (or whichever
   file owns theme resolution — grep for `defaultTheme`, `loadTheme`, or `theme =`). Find
   the fallback picker and confirm you understand how user config overrides it.
5. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/config/tui.ts` (or wherever the TUI
   config schema lives) — confirm it exposes a `theme` field with a string default.
6. `/Users/gtrush/Downloads/jellyclaw-engine/engine/CLAUDE.md` §"Coding conventions" —
   Strict TypeScript, `import type`, Zod for runtime validation, kebab-case filenames,
   no `console.log` (use `pino` logger). All changes in this prompt obey those rules.
7. Skim 2–3 other bundled themes (e.g. `tokyonight.json`, `gruvbox.json`, `dracula.json`)
   to sanity-check your schema mental model and to see which keys can be `null` vs must
   be hex strings.

## Implementation task

Brand the vendored OpenCode TUI with the jellyclaw identity: a purple jellyfish/medusa
spinner replacing the upstream `opentui-spinner` glyph, a static `🪼` brand bullet in
front of assistant messages (with an ASCII fallback), and a purple `jellyclaw` theme
shipped as the default. Nothing functional about OpenCode changes — only presentation.

### 1. Add jellyfish spinner frames

Create `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/component/jellyfish-spinner.tsx`.

Export two named Solid components:

```tsx
export function JellyfishSpinner(props: { size?: "compact" | "hero"; ascii?: boolean }): JSX.Element
```

…plus the underlying frame data as plain exports so tests can import frames directly:

```ts
export const jellyfishSpinnerCompact: Spinner  // interval: 80, 10 frames, width 7
export const jellyfishSpinnerHero: Spinner     // interval: 90,  8 frames, 3 lines, width 11
export interface Spinner { interval: number; frames: string[]; staticFrame: string }
```

Frames must be pasted **verbatim from the spec appendix below** — do not re-author them.
Width is load-bearing: every compact frame is exactly 7 chars, every hero line is exactly
11 chars (count trailing spaces).

**Reduced-motion / static-fallback detection.** Render the static frame only (no timer,
no color, no animation) if ANY of these is true:

- `process.env.NO_COLOR` is set (any truthy value)
- `process.env.NO_COLOR` lowercase `no_color` is set (honor both — OS convention is upper,
  the spec uses lower; test both)
- `process.env.CLAUDE_CODE_DISABLE_ANIMATIONS` is set
- `process.env.JELLYCLAW_REDUCED_MOTION` is set
- `process.stdout.isTTY === false`

Static fallback strings (from spec):
- compact: `"(◉)⠇ "`
- hero: frame index 3 (peak pulse — the most jellyfish-looking silhouette)

**ASCII fallback.** When `props.ascii === true` OR `process.env.TERM === "linux"` OR
`process.argv` contains `--ascii`, swap every braille tentacle char (⠄ ⠂ ⠁ ⠆ ⠃ ⠇ ⠧ ⠏ ⠦
⠴ ⠰ ⠤ ⠠) with the ASCII sequence `:·:` (truncated or padded to preserve column width).
Keep ASCII frames in a sibling const `jellyfishSpinnerCompactAscii` / `…HeroAscii` so
frame generation is a lookup, not a runtime string.replace in the render loop.

**Color at render time, not baked in.** Wrap lines using truecolor ANSI escapes pulled
from the active theme:
- Hero line 1 → `bell` (theme `primary` / `#B78EFF`)
- Hero line 2 → `rim` (theme `secondary` / `#8B5CF6`)
- Hero line 3 → `trail` (theme `muted` / `#5B4B7A`); center char of line 3 uses `tip`
  (theme `accent` / `#D4BFFF`) as a heartbeat accent
- Compact: dome chars (◉ ◎ ○) in `bell`; braille in `trail`; parentheses in `rim`

Detect truecolor via `process.env.COLORTERM === "truecolor"`. If not truecolor, fall
back to ANSI 256 codes from the spec (bell→141, tip→189, rim→99, trail→60). If
`NO_COLOR` is set, emit no escapes at all.

**Solid.js reactivity.** The frame index is local state inside the component
(`const [frame, setFrame] = createSignal(0)`). The `setInterval` is created in
`onMount` and cleared in `onCleanup`. Do NOT put the frame index in a context or
store — that would re-render the whole TUI tree 12× per second. Only the spinner
subtree re-renders.

### 2. Replace the sparkle glyph everywhere

The upstream OpenCode TUI uses `opentui-spinner` wrapped by
`engine/src/tui/component/spinner.tsx`. Find every callsite:

```
grep -rn "from.*component/spinner" engine/src/tui/
grep -rn "<Spinner" engine/src/tui/
```

Replace `<Spinner ... />` with `<JellyfishSpinner ... />` at each callsite. If the
upstream component accepts props (`label`, `size`, etc.), adapt them — most callsites
want `size="compact"` inline; the top-of-turn "thinking…" banner wants `size="hero"`.
Leave `component/spinner.tsx` in place as a thin re-export of `JellyfishSpinner` so
future upstream merges from OpenCode still compile (don't delete it).

**Static brand glyph.** Upstream OpenCode prefixes every assistant message with `⏺`
(a filled bullet). Find the code that renders this — most likely in
`engine/src/tui/component/message.tsx` or similar. Replace the literal `⏺` with:

```ts
const BRAND_GLYPH =
  process.env.JELLYCLAW_BRAND_GLYPH ??
  (supportsEmoji() ? "🪼" : "◉");
```

Implement `supportsEmoji()` in a new tiny helper at
`engine/src/tui/util/supports-emoji.ts`. Detection heuristic:
- `process.env.TERM_PROGRAM` is one of `"iTerm.app"`, `"Apple_Terminal"`, `"WezTerm"`,
  `"ghostty"`, `"vscode"`, or `process.env.WT_SESSION` set (Windows Terminal) → true
- `process.env.TERM === "linux"` → false (Linux console can't render emoji)
- otherwise → true (modern default)

Document `JELLYCLAW_BRAND_GLYPH` in the env-vars section of `docs/tui.md` (or wherever
TUI env vars are documented — if nowhere, create that section).

### 3. Create purple theme `jellyclaw.json`

Create `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/context/theme/jellyclaw.json`.

Match the exact JSON schema of `opencode.json` — same keys, same nesting, same
`null`-vs-hex conventions. The color mapping:

| Semantic role                        | Hex       | Notes                                       |
| ------------------------------------ | --------- | ------------------------------------------- |
| Primary / accent (spinner bell)      | `#B78EFF` | Medium purple — the brand signature         |
| Secondary (spinner rim, subtle UI)   | `#8B5CF6` | Violet-500                                  |
| Highlight / focus (tentacle tip)     | `#D4BFFF` | Lighter violet — selections, focus rings    |
| Dim / muted (borders, hints)         | `#5B4B7A` | Purple-grey                                 |
| Error                                | `#F87171` | Red                                         |
| Success                              | `#10B981` | Emerald                                     |
| Warning                              | `#F59E0B` | Amber                                       |
| Info                                 | `#60A5FA` | Blue                                        |
| Background                           | `null`    | Terminal default — do NOT paint it          |
| Foreground                           | `null`    | Terminal default — respect user's bg/fg     |

**Do not invent keys.** If `opencode.json` has a `syntax` block with 20 sub-keys, yours
has the same 20 sub-keys. Map unobvious ones (e.g. `diff.added`, `diff.removed`,
`git.branch`) to semantically sensible picks from the palette above. Keep comments out
of the JSON (it's strict JSON; no JSONC unless the existing themes use it).

**Validation.** If `engine/src/tui/context/theme.tsx` exposes a Zod schema or runtime
validator (it should — 35 bundled themes benefit from one), run `jellyclaw.json`
through it. If no validator exists, add a minimal Zod schema at
`engine/src/tui/context/theme/schema.ts` that at least checks "every required key is
present, every hex value matches `^#[0-9A-Fa-f]{6}$` or is null", and apply it at
theme-load time. This is the load-bearing guard that prevents the "theme JSON missing
a key → TUI crashes at render time" pitfall.

### 4. Set jellyclaw.json as the default theme

Find where the default theme is picked. Most likely `engine/src/tui/context/theme.tsx`
has something like:

```ts
const DEFAULT_THEME = "opencode";
```

Change to:

```ts
const DEFAULT_THEME = "jellyclaw";
```

Keep the user override path intact — a `theme` field in user config still wins. Write
a short comment above the constant explaining that this is the brand default and can
be overridden via `config.tui.theme` or the `JELLYCLAW_THEME` env var (if the TUI
honors env-var overrides — check).

### 5. Update `config/tui.ts`

Edit `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/config/tui.ts` (or wherever
the TUI config schema lives — grep for `z.object({ theme`).

Set the default:

```ts
theme: z.string().default("jellyclaw"),
```

Make sure the Zod inference flows into whatever `TUIConfig` type is exported; no `any`
slipping in.

## Files to create / modify

Create:

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/component/jellyfish-spinner.tsx`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/util/supports-emoji.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/context/theme/jellyclaw.json`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/context/theme/schema.ts` *(only
  if no validator already exists — check first)*
- `/Users/gtrush/Downloads/jellyclaw-engine/test/tui/jellyfish-spinner.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/tui/jellyfish-spinner.snapshot.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/tui/theme-jellyclaw.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/tui/__snapshots__/jellyfish-spinner.compact.txt`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/tui/__snapshots__/jellyfish-spinner.hero.txt`

Modify:

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/component/spinner.tsx` —
  re-export `JellyfishSpinner` so old imports keep resolving.
- Every callsite of `<Spinner>` inside `engine/src/tui/` — swap to `<JellyfishSpinner>`.
- `engine/src/tui/component/message.tsx` (or equivalent) — swap literal `⏺` for
  `BRAND_GLYPH`.
- `engine/src/tui/context/theme.tsx` — change `DEFAULT_THEME` to `"jellyclaw"`; wire
  schema validation at load time.
- `engine/src/config/tui.ts` — set theme default to `"jellyclaw"`.
- `docs/tui.md` — document the new env vars: `JELLYCLAW_REDUCED_MOTION`,
  `JELLYCLAW_BRAND_GLYPH`. *(Create this file if it doesn't exist; keep it tight —
  one section, a table.)*
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — mark Phase 10.5.02 ✅.
- `/Users/gtrush/Downloads/jellyclaw-engine/STATUS.md` — note the brand layer status.

## Public-facing behavior after this prompt

- Opening the jellyclaw TUI shows a pulsing purple medusa spinner instead of the
  upstream quad-dots.
- Assistant messages are prefixed with `🪼` (or `◉` on emoji-weak terminals).
- The overall palette is purple: `#B78EFF` primary, `#D4BFFF` highlight, `#5B4B7A` muted.
- Users can:
  - Disable animations: `NO_COLOR=1`, `CLAUDE_CODE_DISABLE_ANIMATIONS=1`, or
    `JELLYCLAW_REDUCED_MOTION=1` → spinner renders a static single frame.
  - Force ASCII tentacles: `--ascii` CLI flag or `TERM=linux`.
  - Swap the brand glyph: `JELLYCLAW_BRAND_GLYPH="J>"` (or anything printable).
  - Pick a different theme: `config.tui.theme = "tokyonight"` (all 35 bundled themes
    still work; jellyclaw is merely the default).

## Tests

### Unit — `test/tui/jellyfish-spinner.test.ts`

- `jellyfishSpinnerCompact.frames.length === 10`.
- `jellyfishSpinnerHero.frames.length === 8`.
- Every compact frame's `string-width` is exactly 7. Use the `string-width` package
  (not `.length`) because emoji/CJK/ANSI width differs from codepoint count.
- Every hero frame has exactly 3 lines (splits on `\n`); every line width is exactly 11.
- No frame contains ANSI escapes (`/\x1b\[/` must not match any raw frame string) —
  color is applied at render, not baked in.
- ASCII fallback frames exist and preserve the same widths.
- `jellyfishSpinnerCompact.staticFrame === "(◉)⠇ "` (width 7 accounting for terminal
  column width of braille — if `string-width` disagrees, update the spec file AND the
  test in lockstep, don't silently diverge).

### Snapshot — `test/tui/jellyfish-spinner.snapshot.test.ts`

- Render `<JellyfishSpinner size="compact" />` at frame indices 0..9, join with `\n`,
  compare to `__snapshots__/jellyfish-spinner.compact.txt`.
- Render `<JellyfishSpinner size="hero" />` at frame indices 0..7, join with `\n\n`,
  compare to `__snapshots__/jellyfish-spinner.hero.txt`.
- Capture no color in snapshots (set `NO_COLOR=1` at test start) so golden files stay
  diffable.
- Snapshot generation: first run writes the golden, subsequent runs diff. Document the
  regen command in the test file header: `UPDATE_SNAPSHOTS=1 bun test test/tui`.

### Reduced-motion — `test/tui/jellyfish-spinner.test.ts` (same file)

- With `process.env.NO_COLOR = "1"`: render compact; assert output equals
  `jellyfishSpinnerCompact.staticFrame` with no ANSI codes.
- With `process.env.CLAUDE_CODE_DISABLE_ANIMATIONS = "1"`: same.
- With `process.env.JELLYCLAW_REDUCED_MOTION = "1"`: same.
- With `process.stdout.isTTY = false` (stub it): same.
- With lowercase `process.env.no_color = "1"`: same. *(Both casings.)*

### Theme — `test/tui/theme-jellyclaw.test.ts`

- Load `jellyclaw.json`; validate against the schema (Zod or the existing validator).
- Compare key-set to `opencode.json` — `setDifference` must be empty in BOTH
  directions (no missing keys, no extra keys).
- Every hex value matches `/^#[0-9A-Fa-f]{6}$/` or is explicitly `null`.
- Primary `#B78EFF`, accent `#D4BFFF`, muted `#5B4B7A` — load, assert wired through
  to the render-time color resolver.
- Default theme is `"jellyclaw"` when no user override is present.

## Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run lint
bun run test test/tui                                 # expect: green
bun run build

# Manual smoke — visually confirm purple + jellyfish
bun run engine/src/tui/app.tsx                        # look: purple spinner, 🪼 bullet
NO_COLOR=1 bun run engine/src/tui/app.tsx             # look: static frame, no color
JELLYCLAW_BRAND_GLYPH=">" bun run engine/src/tui/app.tsx  # look: ">" instead of 🪼
TERM=linux bun run engine/src/tui/app.tsx             # look: ASCII tentacles, ◉ glyph
```

Expected output:

- Default run: animated medusa spinner in purple (`#B78EFF`), `🪼` before assistant
  messages, overall palette reads purple.
- `NO_COLOR=1`: single static frame, zero ANSI escapes in output.
- `JELLYCLAW_BRAND_GLYPH=">"`: `>` prefix on messages.
- `TERM=linux`: tentacles rendered as `:·:`, bullet is `◉`.
- All unit + snapshot + theme tests green.

## Common pitfalls

- **Frame width drift.** Every compact frame must be exactly 7 columns per
  `string-width` (not `.length`). Braille chars are 1 col, `◉` is 1 col, parens are 1
  col, spaces are 1 col — but a stray CJK char or emoji sneaking in is 2 cols and
  breaks redraw. Re-count after any edit.
- **Terminal emoji support varies.** `🪼` is a Unicode 14 codepoint (2021). Some
  terminals (Linux console, old tmux on stripped-down servers, some CI runners)
  render it as tofu `□`. Always provide the `JELLYCLAW_BRAND_GLYPH` override and
  the `supportsEmoji()` fallback to `◉`.
- **Solid.js reactivity leak.** The spinner's frame index MUST be local to the
  component. Putting it in a `createRoot` at the top of the app, or in the theme
  context, or in a signal returned from a hook that the root consumes, causes the
  whole TUI to re-render at 12 FPS. Test: add a `console.log` to a sibling component
  during development; it should NOT fire on spinner ticks.
- **Theme JSON schema missing a key.** The vendored OpenCode TUI renders keys lazily;
  a missing `diff.added` crashes at render time, not load time. Validate at load with
  a schema that knows the full key-set. Run validation against all 35 bundled themes
  in CI — if one is broken upstream, fix it in the vendor layer and document.
- **OpenTUI frame rate.** The spec says 80 ms (compact) and 90 ms (hero). Do not
  tune down to 60 ms "for smoothness" — terminal redraw of multi-line content below
  60 ms causes visible flicker on SSH, tmux, and slow renderers.
- **`NO_COLOR` casing.** OS convention is `NO_COLOR` (uppercase per no-color.org).
  The spec file uses lowercase `process.env.NO_COLOR` in one snippet and uppercase in
  another. Honor both: check `process.env.NO_COLOR ?? process.env.no_color`.
- **Braille column-width on macOS Terminal.app.** Some fonts render `⠧⠇⠏` as 2-col
  wide, breaking the 7-col compact promise. If CI (Linux) passes but local macOS
  terminal shows jitter, document the font recommendation (Menlo, Berkeley Mono,
  MonoLisa — all render braille as 1 col) in `docs/tui.md`.
- **Upstream OpenCode merge rot.** Keeping `component/spinner.tsx` as a thin
  re-export means future `bun run sync-opencode` merges from upstream won't churn
  callsites. If you delete it and rename everything to `jellyfish-spinner`, every
  future upstream pull hits merge conflicts in dozens of files.
- **Process exit during spinner interval.** If the TUI shuts down mid-tick, the
  `setInterval` handle can keep the process alive. Use `ref()/unref()` on the
  interval, or ensure `onCleanup` is wired in Solid's lifecycle.
- **Snapshot non-determinism.** Don't include timestamps, PIDs, or random IDs in
  snapshot tests. Stub `Date.now()` and `Math.random()` at test start if the render
  path touches them.
- **Bundled theme count regression.** Phase 10.5.01 pulled in 35 OpenCode themes.
  Your new `jellyclaw.json` makes it 36. A stale test asserting "exactly 35 themes"
  will fail — update it.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: Phase 10.5.02 ✅ in COMPLETION-LOG.md; update STATUS.md; next prompt = prompts/phase-10.5/03-<name>.md (or flip Phase 10.5 to ✅ if this is the last prompt in the sub-phase). Bump the progress counter. -->
<!-- END paste -->

**Note:** This prompt is the visible brand differentiator. Once it ships, anyone
opening the TUI sees "jellyclaw," not "OpenCode with a wrapper." Do not skimp on the
snapshot tests — they're the regression guard against future upstream merges
accidentally overwriting the spinner.

---

## Appendix — Full jellyfish spinner spec (verbatim)

<details>
<summary>Click to expand — reproduced from <code>jellyfish-spinner-spec.txt</code> so this prompt is self-contained.</summary>

```
JELLYFISH SPINNER SPEC — jellyclaw-engine Phase 10.5
=====================================================

Purpose: Replace Claude Code's quad-dots with a brand-signature jellyfish/medusa
spinner. Must read as "pulsing medusa with drifting tentacles" on frame 1 —
not abstract motion.

Two variants ship: Compact (inline, 1 line, <=8 cols) and Hero (multi-line,
dominant position). Both purple. Both seamless loops. Both have a static
reduced-motion fallback.

-----------------------------------------------------------------------------
VARIANT A — COMPACT INLINE (1 line, 7 cols)
-----------------------------------------------------------------------------

Anatomy per frame (7 cols):
  [pad] [tip-L] [dome] [tip-R] [tentacle-drift × 3]

The dome (◉ ◎ ○ ⊚) pulses open/contracted. Tentacles are braille micro-motion
that ripple right-to-left underneath, so the medusa appears to propel leftward
while hovering in place.

10 frames (80ms interval = 12.5 FPS):

  Frame 1:  " ◉   ⠄ "   ← dome contracted, single tentacle dot drifting
  Frame 2:  "(◉)  ⠆ "   ← dome flaring, tentacle growing
  Frame 3:  "(◎)  ⠇ "   ← peak pulse, tentacle fuller
  Frame 4:  " ◎  ⠧⠄"   ← dome releases, two tentacle threads
  Frame 5:  " ○ ⠇⠦ "   ← dome smallest, tentacles trailing
  Frame 6:  " ○⠇⠴  "   ← tentacles sweeping left
  Frame 7:  " ◎⠧⠰  "   ← dome begins next pulse
  Frame 8:  "(◎)⠇⠠  "   ← flaring again
  Frame 9:  "(◉)⠆   "   ← near peak, tentacles reset
  Frame 10: " ◉⠄    "   ← back to rest → loops to frame 1

Width: every frame is exactly 7 chars (count spaces). Parentheses read as
the bell flaring outward during propulsion — a real medusa motion.

Static fallback (NO_COLOR / CLAUDE_CODE_DISABLE_ANIMATIONS):  "(◉)⠇ "

-----------------------------------------------------------------------------
VARIANT B — HERO MULTI-LINE (3 lines, 11 cols wide)
-----------------------------------------------------------------------------

Anatomy: line 1 is the bell dome (block elements pulsing), line 2 is the
bell rim + oral arms, line 3 is the trailing tentacles (braille, drift-left).

8 frames at 90ms (≈11 FPS). Ping-pong: frames 1→8→1 via reversing, OR seamless
loop as written (frame 8 leads back into frame 1 cleanly — we ship seamless).

Frame 1  (rest, contracted):
    ▁▂▃▂▁
    ╲│││╱
    ⠄⠂⠁⠂⠄

Frame 2  (beginning pulse):
   ▂▃▄▅▄▃▂
    ╲│││╱
    ⠆⠂⠃⠂⠆

Frame 3  (flaring out):
  ▃▄▅▆▇▆▅▄▃
    ╲╱│╲╱
    ⠇⠆⠇⠆⠇

Frame 4  (peak — full bell, tentacles long):
  ▄▅▆▇█▇▆▅▄
   ╲ ╱│╲ ╱
   ⠧⠇⠏⠇⠧

Frame 5  (contract, thrust — tentacles whip back):
   ▅▆▇█▇▆▅
    ╲│││╱
    ⠴⠦⠇⠦⠴

Frame 6  (relaxing):
    ▄▅▆▅▄
    │╲│╱│
    ⠰⠤⠆⠤⠰

Frame 7  (gliding, tentacles settle):
    ▃▄▅▄▃
    │╲│╱│
    ⠠⠄⠂⠄⠠

Frame 8  (near rest, small tentacle wisp):
    ▁▂▃▂▁
    ╲│││╱
    ⠄⠂⠄⠂⠄    → loops to Frame 1 seamlessly

Each frame: 3 lines, max 11 cols. Shorter lines centered with leading spaces
so the medusa appears to hover.

Frame 1 one-sentence test: "A tiny contracted jellyfish bell with four
tentacles dangling and a dot of water disturbance beneath it."  ✓ reads as
jellyfish.

Static fallback: Frame 4 (peak pulse — most recognizable silhouette).

-----------------------------------------------------------------------------
COLOR PLAN
-----------------------------------------------------------------------------

  Primary bell:      #B78EFF   (medium purple — the brand signature)
  Tentacle tips:     #D4BFFF   (lighter violet — highlight last char of tentacle row)
  Bell rim:          #8B5CF6   (violet-500 — line 2, the rim strokes)
  Trail dim:         #5B4B7A   (muted purple-grey — used for the faintest braille dots)
  Reset / fallback:  default terminal fg

chalk / picocolors:
  import pc from "picocolors";
  const bell   = (s) => `\x1b[38;2;183;142;255m${s}\x1b[0m`;  // #B78EFF
  const tip    = (s) => `\x1b[38;2;212;191;255m${s}\x1b[0m`;  // #D4BFFF
  const rim    = (s) => `\x1b[38;2;139;92;246m${s}\x1b[0m`;   // #8B5CF6
  const trail  = (s) => `\x1b[38;2;91;75;122m${s}\x1b[0m`;    // #5B4B7A

ANSI 256 fallbacks (for terminals without truecolor):
  bell   → 141   tip → 189   rim → 99   trail → 60

Detect via process.env.COLORTERM === "truecolor" or supports-color lib.

-----------------------------------------------------------------------------
MOTION PROFILE
-----------------------------------------------------------------------------

  Compact:  interval = 80ms   (12.5 FPS)   frames = 10   loop = seamless
  Hero:     interval = 90ms   (11.1 FPS)   frames = 8    loop = seamless

Seamless (not ping-pong) — last frame flows into first. Ping-pong on a
medusa would read as "jellyfish inhaling backwards" which breaks biology.

CPU: 11-12 FPS redraws of <200 bytes each = negligible; safe on SSH/tmux.

Reduced-motion:
  if (process.env.NO_COLOR ||
      process.env.CLAUDE_CODE_DISABLE_ANIMATIONS ||
      !process.stdout.isTTY) {
    render(staticFallback);  // no color, no animation
  }

-----------------------------------------------------------------------------
SYMBOLISM CHECK
-----------------------------------------------------------------------------

Compact frame 1:   " ◉   ⠄ "  — "A solid round bell hovering above a single
drifting droplet of tentacle." → reads as jellyfish ✓

Hero frame 1:      ▁▂▃▂▁ / ╲│││╱ / ⠄⠂⠁⠂⠄  — "A small bell-shaped dome with
four tentacles hanging down and water particles beneath." → reads as
jellyfish ✓

Both pass the one-sentence test.

-----------------------------------------------------------------------------
JS MODULE SHAPE
-----------------------------------------------------------------------------

// src/tui/spinners/jellyfish.ts

export interface Spinner {
  interval: number;
  frames: string[];
  staticFrame: string;
}

export const jellyfishSpinnerCompact: Spinner = {
  interval: 80,
  frames: [
    " ◉   ⠄ ",
    "(◉)  ⠆ ",
    "(◎)  ⠇ ",
    " ◎  ⠧⠄",
    " ○ ⠇⠦ ",
    " ○⠇⠴  ",
    " ◎⠧⠰  ",
    "(◎)⠇⠠ ",
    "(◉)⠆  ",
    " ◉⠄   ",
  ],
  staticFrame: "(◉)⠇ ",
};

export const jellyfishSpinnerHero: Spinner = {
  interval: 90,
  frames: [
    "    ▁▂▃▂▁  \n    ╲│││╱  \n    ⠄⠂⠁⠂⠄  ",
    "   ▂▃▄▅▄▃▂ \n    ╲│││╱  \n    ⠆⠂⠃⠂⠆  ",
    "  ▃▄▅▆▇▆▅▄▃\n    ╲╱│╲╱  \n    ⠇⠆⠇⠆⠇  ",
    "  ▄▅▆▇█▇▆▅▄\n   ╲ ╱│╲ ╱ \n   ⠧⠇⠏⠇⠧   ",
    "   ▅▆▇█▇▆▅ \n    ╲│││╱  \n    ⠴⠦⠇⠦⠴  ",
    "    ▄▅▆▅▄  \n    │╲│╱│  \n    ⠰⠤⠆⠤⠰  ",
    "    ▃▄▅▄▃  \n    │╲│╱│  \n    ⠠⠄⠂⠄⠠  ",
    "    ▁▂▃▂▁  \n    ╲│││╱  \n    ⠄⠂⠄⠂⠄  ",
  ],
  staticFrame: "  ▄▅▆▇█▇▆▅▄\n   ╲ ╱│╲ ╱ \n   ⠧⠇⠏⠇⠧   ",
};

// Color application is done at render time, not baked into frames,
// so themes can recolor without editing frames:
//
//   renderFrame(frame, { bell: "#B78EFF", rim: "#8B5CF6", trail: "#5B4B7A" })
//
// Line 1 → bell color; Line 2 → rim color; Line 3 → trail color, with
// center char of line 3 painted in `tip` (#D4BFFF) for a heartbeat accent.

-----------------------------------------------------------------------------
IMPLEMENTATION NOTES FOR PHASE 10.5
-----------------------------------------------------------------------------

1. Frames stored as plain strings — no ANSI baked in. Color is a runtime
   layer so `--no-color`, theme swaps, and truecolor detection work cleanly.

2. Hero spinner uses multi-line frames. The renderer must:
   - save cursor, move up N-1 lines each redraw, erase to end-of-line,
     then reprint — standard multi-line ora/ink pattern.
   - OR use Ink `<Text>` with a key that changes each frame.

3. Padding: every compact frame is exactly 7 chars; every hero line is
   exactly 11 chars (trailing spaces preserved) so no jitter on redraw.

4. Font fallback: if the terminal can't render braille (⠧⠇⠏), swap to
   the block-only fallback:
     tentacle row → ":·:·:" (simple ASCII)
   Detect via process.env.TERM === "linux" or an explicit --ascii flag.

5. Reduced motion: render staticFrame once, no timer. Honors NO_COLOR,
   CLAUDE_CODE_DISABLE_ANIMATIONS, and non-TTY stdout.

-----------------------------------------------------------------------------
END OF SPEC
```

</details>
