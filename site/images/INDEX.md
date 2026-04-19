# site/images/ — source library

Raw source imagery for the landing page. **Never link to these directly from
HTML.** Run them through `scripts/` (or `sips`/`cwebp`) and emit the optimized
output into `site/assets/` instead — that directory is what the page references.

## Inventory

| File | Dim (px) | Bytes  | Notes |
|------|----------|--------|-------|
| `ai-brain.jpg`        | —        | 234 KB | Stock; not used in T6-04. |
| `code-screen.jpg`     | —        |  54 KB | Stock; less distinctive — skipped per brief. |
| `dark-tech.jpg`       | —        | 268 KB | Stock; not used. |
| `deep-ocean.jpg`      | —        | 133 KB | Mobile fallback candidate (tiles well at narrow widths). |
| `hero-bg.jpg`         | —        | 523 KB | Legacy hero from claurst era; **deprecated**. |
| `jellyfish-1.jpg`     | 800×533  |  86 KB | **PRIMARY HERO SOURCE** for T6-04 → optimized to `site/assets/hero.jpg`. |
| `jellyfish-2.jpg`     | —        | 184 KB | Secondary-page candidate (alt angle). |
| `matrix.jpg`          | —        |  93 KB | Tech aesthetic; rejected (feels dated). |
| `purple-gradient.jpg` | —        |  17 KB | Background-blend candidate; matches Medusa Violet token region. |
| `servers.jpg`         | —        |  89 KB | Stock; not used. |
| `team.jpg`            | —        |  78 KB | Stock; not used. |
| `tech-office.jpg`     | —        |  93 KB | Stock; not used. |

## Hero selection (T6-04)

Per `T6-04-DESIGN-BRIEF.md` § "Landing hero asset choice": **`jellyfish-1.jpg`**
is the chosen hero source. The optimizer output lives at:

```
site/assets/hero.jpg   (1280px wide, JPEG q=45, ≈100 KB)
```

Reproduce with:

```bash
sips -s format jpeg -s formatOptions 45 -Z 1280 \
  site/images/jellyfish-1.jpg --out site/assets/hero.jpg
```

## Brand-palette reference

The jellyfish/ocean photography pairs with the cyan→violet→amber palette
(see `engine/src/tui/theme/brand.ts`). Apply a 70 % Abyss (`#0A1020`) overlay
in CSS to maintain WCAG AA text contrast for hero copy.
