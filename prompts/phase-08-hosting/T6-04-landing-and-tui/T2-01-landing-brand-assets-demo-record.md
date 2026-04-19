---
id: T2-01-landing-brand-assets-demo-record
tier: 2
title: "Brand assets + asciinema demo recording for landing page"
scope:
  - site/assets/
  - site/images/
  - scripts/record-demo.sh
depends_on_fix:
  - T1-04-tui-statusbar-input-polish
tests:
  - name: wordmark-svg-exists
    kind: shell
    description: "wordmark SVG exists and is non-empty"
    command: "test -s site/assets/wordmark.svg && test $(wc -c < site/assets/wordmark.svg) -gt 500"
    expect_exit: 0
    timeout_sec: 5
  - name: og-image-exists
    kind: shell
    description: "og:image PNG/JPG exists (1200x630 ideal)"
    command: "test -s site/assets/og-image.png || test -s site/assets/og-image.jpg"
    expect_exit: 0
    timeout_sec: 5
  - name: demo-cast-valid
    kind: shell
    description: "asciinema .cast file exists, valid JSONL"
    command: |
      set -e
      test -s site/assets/demo.cast
      head -1 site/assets/demo.cast | python3 -c "import json,sys; j=json.loads(sys.stdin.read()); assert j.get('version') == 2"
    expect_exit: 0
    timeout_sec: 10
  - name: hero-image-chosen
    kind: shell
    description: "hero image selected and symlinked/copied into site/assets/"
    command: "test -s site/assets/hero.jpg || test -s site/assets/hero.png || test -s site/assets/hero.webp"
    expect_exit: 0
    timeout_sec: 5
human_gate: false
max_turns: 35
max_cost_usd: 12
max_retries: 2
estimated_duration_min: 30
---

# T2-01 — Brand assets + asciinema demo recording

## Context
Before building the landing page (T2-02), we need the actual media: wordmark
SVG, og:image, hero photo selection from `site/images/`, and a recorded
asciinema cast of a polished `jellyclaw tui` session.

## Work

### 1. Wordmark SVG → `site/assets/wordmark.svg`
Hand-authored SVG of "jellyclaw" with the cyan→violet gradient from the
design brief. Vector only; no raster fallback needed (SVG is universal).
Max 2KB. Include `<title>jellyclaw</title>` for a11y.

### 2. og:image → `site/assets/og-image.png` (1200×630)
Either:
- Generate via headless browser from the landing page (later — circular dep),
  OR
- Handcraft a static composition: wordmark + tagline on abyss background,
  export at 1200×630, ≤100KB. Use any tool at hand — if agent picks ImageMagick
  or librsvg, use that. Do NOT depend on external gen APIs.

### 3. Hero image → `site/assets/hero.jpg` (or `.webp`)
Pick from `site/images/` (deep-ocean.jpg, jellyfish-1.jpg, jellyfish-2.jpg,
purple-gradient.jpg are the best bets — design brief will have decided).
Copy to `site/assets/hero.jpg`. Optimize: `<=120KB`, max dimension 1920.
Use `sips -s format jpeg -s formatOptions 75` (macOS) or `cwebp` if available.

### 4. Record the demo cast → `site/assets/demo.cast`
Create `scripts/record-demo.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
# Record a 25-30s asciinema cast of jellyclaw tui. Requires asciinema installed.
test -x "$(command -v asciinema)" || { echo "install asciinema: brew install asciinema"; exit 2; }
out=site/assets/demo.cast
mkdir -p site/assets
# -q quiet, -t title, --overwrite to replace, --max-wait 1 to trim idle gaps
asciinema rec "$out" \
  --overwrite \
  --max-wait 1 \
  -t "jellyclaw demo" \
  -c "node engine/bin/jellyclaw tui --demo-script $PWD/scripts/demo-script.txt"
echo "wrote: $out ($(wc -c < "$out") bytes)"
```
chmod +x.

Create `scripts/demo-script.txt` — a short canned script the TUI replays if
`--demo-script` is passed. Add `--demo-script <path>` flag to
`engine/src/cli/tui.ts` if not already present; it reads lines from the file
and injects them as if typed, with 300ms pacing, then sends the input.

If adding the flag is too invasive for this prompt, **fall back**: run
`asciinema rec` interactively (agent automates the keypresses via expect or
pty); the script captures:
1. Splash → Enter
2. `write a haiku about submarines`
3. Wait for assistant response
4. `/help` → dismiss
5. Ctrl+D to exit

### 5. Validate
- `asciinema play site/assets/demo.cast` plays back cleanly (just confirm
  the JSON parses, don't actually spawn a player).
- `wc -c` on each asset matches budget.

## Acceptance criteria
- All 4 asset files exist under `site/assets/`.
- demo.cast version 2 JSONL, first line parses.
- Total `site/assets/` weight < 350KB.
- Hero + og + wordmark visually match brand palette (cyan/violet/amber).

## Out of scope
- Wiring assets into landing HTML — T2-02.
- Compressing to AVIF or other modern formats — skip; WebP is fine.

## Verification the worker should self-run before finishing
```bash
ls -lh site/assets/
du -sh site/assets/
head -c 200 site/assets/demo.cast
echo "DONE: T2-01-landing-brand-assets-demo-record"
```
