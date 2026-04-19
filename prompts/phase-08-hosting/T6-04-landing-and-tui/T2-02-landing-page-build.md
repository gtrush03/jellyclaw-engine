---
id: T2-02-landing-page-build
tier: 2
title: "Build production landing page — hero, features, demo, CTA, footer"
scope:
  - site/index.html
  - site/css/style.css
  - site/js/demo-loader.js
  - site/serve.config.js
depends_on_fix:
  - T2-01-landing-brand-assets-demo-record
tests:
  - name: html-valid
    kind: shell
    description: "site/index.html parses as valid HTML5"
    command: "bunx --bun html-validate site/index.html || npx -y html-validate site/index.html"
    expect_exit: 0
    timeout_sec: 60
  - name: size-budget
    kind: shell
    description: "total page weight (HTML+CSS+JS) under 60KB"
    command: |
      set -e
      total=$(( $(wc -c < site/index.html) + $(find site/css -name '*.css' -exec wc -c {} \; | awk '{s+=$1} END {print s+0}') + $(find site/js -name '*.js' -exec wc -c {} \; | awk '{s+=$1} END {print s+0}') ))
      echo "total=$total bytes"
      test "$total" -lt 61440
    expect_exit: 0
    timeout_sec: 5
  - name: no-google-fonts
    kind: shell
    description: "no external font loads (CSP + speed)"
    command: "! grep -qE 'fonts\\.googleapis|fonts\\.gstatic|cdn\\.jsdelivr|unpkg\\.com|cdnjs\\.cloudflare' site/index.html site/css/*.css site/js/*.js 2>/dev/null"
    expect_exit: 0
    timeout_sec: 5
  - name: required-sections
    kind: shell
    description: "hero, features, demo, cta, footer all present"
    command: |
      set -e
      for id in hero features demo cta footer; do
        grep -q "id=\"$id\"" site/index.html || { echo "missing section: $id"; exit 1; }
      done
    expect_exit: 0
    timeout_sec: 5
human_gate: false
max_turns: 45
max_cost_usd: 15
max_retries: 3
estimated_duration_min: 40
---

# T2-02 — Landing page build

## Context
Design brief § 3 has the exact copy. § 4 has the demo embed decision.
Assets are in `site/assets/` from T2-01. This prompt builds the actual page.

## Design constraints
- Single `index.html` file. No framework. No bundler.
- External CSS file (`site/css/style.css`) linked; external JS only for the
  demo loader (`site/js/demo-loader.js`) — kept tiny.
- System font stack only: `system-ui, -apple-system, "Segoe UI", Roboto,
  Ubuntu, Cantarell, "Helvetica Neue", sans-serif` + mono: `ui-monospace,
  SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`.
- Total page weight (HTML+CSS+JS, excluding images & asciinema cast) < 60KB.
- CSS vars match the T1-01 brand palette exactly (hex values).
- `prefers-reduced-motion` → kill auto-playing demo animation.
- `prefers-color-scheme: light` → we stay dark (explicit), not auto-swap.

## Sections (use exact copy from design brief § 3)

### `<section id="hero">`
- `<h1>` wordmark (SVG inline or `<img src="/assets/wordmark.svg">`)
- `<p class="pitch">` one-line pitch
- `<a class="cta primary" href="/tui">Try it in your browser →</a>`
- `<a class="cta secondary" href="https://github.com/gtrush03/jellyclaw">GitHub</a>`
- Below-fold: demo loader (see § demo)
- Subtle hero background: `site/assets/hero.jpg` with a radial-gradient overlay

### `<section id="features">`
- 3 cards: Bash · Browser · Web-search
- Each card = icon (inline SVG, 10 lines max), h3, 2-sentence blurb

### `<section id="demo">`
- Placeholder div with data-demo-src pointing at `/assets/demo.cast`.
- `site/js/demo-loader.js` is a ~40-line script that: dynamically imports
  asciinema-player from a vendored path (`/assets/vendor/asciinema-player.js`)
  ONLY if the user scrolls into view (IntersectionObserver). Gracefully falls
  back to a static PNG first-frame `<img>` if player fails to load.
- If `prefers-reduced-motion`, render the static frame and skip the player.

### `<section id="cta">`
- Repeat the primary CTA with a fuller pitch.
- BYOK disclaimer (from brief): "alpha — bring your own Anthropic key (BYOK)"

### `<footer id="footer">`
- Left: "© 2026 jellyclaw · MIT"
- Right: tiny nav (GitHub, docs, status)

## Meta tags
```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="<brief §3 description>">
<title>jellyclaw — embeddable Claude Code replacement</title>
<meta property="og:title" content="jellyclaw">
<meta property="og:description" content="<brief §3 description>">
<meta property="og:image" content="/assets/og-image.png">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'">
```

## `site/serve.config.js` + `bun run serve:site`
Add a tiny local dev server — Bun's built-in file server is enough:
```js
// site/serve.config.js
import { serve } from "bun";
serve({
  port: 4311,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    return new Response(Bun.file(`site${path}`));
  },
});
console.log("landing: http://127.0.0.1:4311");
```
Wire `"serve:site": "bun site/serve.config.js"` in root `package.json`.

## asciinema-player vendoring
Download `asciinema-player@3.7.x` UMD + CSS → `site/assets/vendor/`. Keep
under 80KB combined (the player is ~70KB minified, hand-fetched from their
GitHub release — NOT a CDN link at runtime; vendored for CSP + offline).
Record the license file next to it.

## Acceptance criteria
- All 4 tests pass.
- `bun run serve:site` serves the page; manual `curl http://127.0.0.1:4311/`
  returns HTML starting with `<!doctype html>`.
- Page renders in a terminal browser (`links site/index.html`) — i.e. works
  without JS (progressive enhancement).

## Out of scope
- Lighthouse + a11y deep pass — T2-03.
- Wiring to production `/tui` backend — T3.

## Verification the worker should self-run before finishing
```bash
bun run serve:site &
SRV_PID=$!
sleep 2
curl -s http://127.0.0.1:4311/ | head -30
kill $SRV_PID
echo "DONE: T2-02-landing-page-build"
```
