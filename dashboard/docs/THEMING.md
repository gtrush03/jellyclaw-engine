# Theming — Obsidian & Gold

Jellyclaw Engine ships with a single theme, by design: **Obsidian & Gold**.

There is no light mode. There will not be a light mode. This document exists
so future contributors don't waste an afternoon wiring a toggle that we will
reject.

## The palette

| Token           | Value                    | Usage                                    |
| --------------- | ------------------------ | ---------------------------------------- |
| `--bg`          | `#050505`                | Page background (matte obsidian)         |
| `--surface`     | `rgba(10, 10, 10, 0.85)` | Glass panels (with `backdrop-blur(40px)`) |
| `--border`      | `rgba(146, 132, 102, 0.25)` | Default panel border                  |
| `--border-hot`  | `rgba(146, 132, 102, 0.6)`  | Hover / active border                 |
| `--fg`          | `#e8e6e1`                | Primary foreground                       |
| `--fg-muted`    | `rgba(232, 230, 225, 0.6)` | Secondary text                         |
| `--gold`        | `#928466`                | Primary gold (brand)                     |
| `--gold-high`   | `#d4bf8f`                | Highlight gold (headings, accents)       |
| `--gold-deep`   | `#6b6146`                | Deep gold (shadows, gradients)           |
| `--error`       | `#d66a5b`                | Validation / errors only                 |

Keep reds, greens, blues, and any other saturated colour off the main
surfaces. Errors get the one warm red token, and nothing else.

## Why dark-only

1. **Brand consistency.** Obsidian & Gold is the house aesthetic across every
   G.TRU surface. A dashboard that suddenly glows white breaks the spell.
2. **Focus.** Dark backgrounds reduce scan fatigue when reading prompts for an
   hour at a time. Jellyclaw is a reading tool first.
3. **Lower maintenance.** Every theme token you add is two values to maintain,
   two screenshots to take, two accessibility passes to run. We'd rather spend
   that time on the product.
4. **It photographs well.** Screenshots shared in public look cinematic in a
   single dark theme. Mixed-theme screenshots always feel inconsistent.

## Do / don't

**Do**
- Use the tokens above, never hard-code a different gold.
- Add new tokens to `src/styles/fonts.css` or a `theme.css` as CSS variables
  when you need a new semantic slot.
- Respect `prefers-reduced-motion` in every animation.
- Put subtle motion through `src/lib/animations.ts` so we don't drift.

**Don't**
- Don't add a `data-theme="light"` attribute path, a `useTheme` hook, or a
  toggle in settings. If a user asks for light mode, close the request with
  a link to this file.
- Don't introduce raster logos. The favicon is SVG; keep it that way.
- Don't use pure white (`#ffffff`) for foreground text — use `--fg` so letters
  don't vibrate on the near-black background.

## Print

We do support a sensible paper render for the prompt viewer via
`src/styles/print.css`. Print is the one context where we flip to ink-on-paper
because the alternative is unreadable. Everywhere else: dark.

## Related files

- `src/lib/obsidian-gold.json` — Shiki theme for code blocks
- `src/lib/animations.ts` — motion primitives
- `src/lib/a11y.ts` — focus ring CSS uses `--gold`
- `public/favicon.svg` — JC monogram
