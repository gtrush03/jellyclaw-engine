---
id: T2-03-landing-a11y-lighthouse-csp
tier: 2
title: "Landing a11y + Lighthouse pass + CSP hardening"
scope:
  - site/index.html
  - site/css/style.css
  - scripts/lighthouse-check.sh
  - site/lighthouse-report.json
depends_on_fix:
  - T2-02-landing-page-build
tests:
  - name: lighthouse-all-90
    kind: shell
    description: "Lighthouse scores perf/a11y/best-practices/seo ≥ 90"
    command: "bash scripts/lighthouse-check.sh"
    expect_exit: 0
    timeout_sec: 180
  - name: axe-clean
    kind: shell
    description: "axe-core reports no critical violations"
    command: "bunx --bun @axe-core/cli http://127.0.0.1:4311 --exit 2>/dev/null || npx -y @axe-core/cli http://127.0.0.1:4311 --exit"
    expect_exit: 0
    timeout_sec: 120
  - name: csp-headers-valid
    kind: shell
    description: "CSP meta tag is present and has no 'unsafe-eval'"
    command: |
      set -e
      grep -q "Content-Security-Policy" site/index.html
      ! grep -q "unsafe-eval" site/index.html
    expect_exit: 0
    timeout_sec: 5
human_gate: false
max_turns: 35
max_cost_usd: 10
max_retries: 3
estimated_duration_min: 25
---

# T2-03 — A11y + Lighthouse + CSP

## Context
The landing is built (T2-02). This prompt hardens it:
- WCAG AA color contrast (use the design-brief palette; verify against `foam`
  text on `abyss` background)
- Lighthouse ≥ 90 across perf, a11y, best-practices, seo
- CSP that actually works (no `unsafe-eval`; asciinema-player must work
  under this CSP — test it)

## Work

### 1. `scripts/lighthouse-check.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Boot site, run lighthouse, fail if any category < 90
bun run serve:site > /tmp/jc-landing.log 2>&1 &
SRV=$!
trap "kill $SRV 2>/dev/null || true" EXIT
for i in $(seq 1 20); do
  sleep 1
  curl -fsS http://127.0.0.1:4311/ >/dev/null && break
done
# Use lighthouse CLI; prefer local if installed, else npx
npx -y lighthouse http://127.0.0.1:4311 \
  --output=json --output-path=site/lighthouse-report.json \
  --only-categories=performance,accessibility,best-practices,seo \
  --chrome-flags="--headless=new --no-sandbox" \
  --quiet
jq -r '.categories | to_entries[] | "\(.key) \(.value.score)"' site/lighthouse-report.json
# Require each score ≥ 0.90
jq -e '.categories | to_entries | all(.value.score >= 0.90)' site/lighthouse-report.json > /dev/null \
  || { echo "Lighthouse category below 0.90"; exit 1; }
```

### 2. Fix whatever Lighthouse / axe flags
Typical misses:
- `<img alt="">` missing — add them.
- Heading hierarchy skips — no h2 → h4 jumps.
- Color contrast — if a pill background/text pair fails, adjust.
- Meta description too long — trim to ≤160 chars.
- `lang="en"` missing on `<html>` — add it.
- Buttons need accessible names — `<a role="button">` + text.
- JS blocks paint — defer script tags or move to end of body.

### 3. CSP hardening
Current meta from T2-02:
```
default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'
```
- Attempt to drop `'unsafe-inline'` on `style-src` by moving inline styles to
  `site/css/style.css`. If asciinema-player needs inline styles, add a nonce
  approach only if easy; else document why `'unsafe-inline'` stays.
- Add `form-action 'self'`.
- Add `Permissions-Policy` + `Referrer-Policy` via meta (some UAs honor
  these).
- Verify: open the page in headless Chrome, check DevTools console — no CSP
  violations.

### 4. `prefers-reduced-motion`
CSS:
```css
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
  #demo .asciinema-player { display: none; }
  #demo .static-fallback { display: block; }
}
```
Confirm the demo section has a static fallback `<img>`.

### 5. SEO
- `robots.txt` at `site/robots.txt` (allow all, link sitemap).
- `sitemap.xml` at `site/sitemap.xml` with just the home URL (hostname
  placeholder `https://jellyclaw.dev/`).

## Acceptance criteria
- `scripts/lighthouse-check.sh` exits 0 (all 4 categories ≥ 0.90).
- `@axe-core/cli` reports 0 critical violations.
- `site/lighthouse-report.json` committed (diff-friendly).
- No `unsafe-eval` anywhere; `unsafe-inline` only if documented.

## Out of scope
- Web-TUI wiring — T3.
- Anything outside `site/` + `scripts/lighthouse-check.sh`.

## Verification the worker should self-run before finishing
```bash
bash scripts/lighthouse-check.sh
jq -r '.categories | to_entries[] | "\(.key): \(.value.score * 100 | floor)"' site/lighthouse-report.json
echo "DONE: T2-03-landing-a11y-lighthouse-csp"
```
