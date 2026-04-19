# T6-04 — Landing page + beautiful TUI (local & web) — autobuild plan

**Parent phase:** Phase 08 — Hosting
**Parent prompt:** `prompts/phase-08-hosting/T6-04-landing-and-web-tui-skeleton.md` (skeleton-only, superseded by this plan)
**Sub-phase dir:** `prompts/phase-08-hosting/T6-04-landing-and-tui/`
**Autobuild kit:** `scripts/autobuild-simple/` (copied from `~/Downloads/autobuild-simple-kit/`)
**Target duration:** 5–8 hours autobuild (14 prompts across 5 tiers)
**Model:** Claude Opus 4.7 (1M) — `claude --dangerously-skip-permissions` inside tmux

---

## Why a replan

The original T6-04 spec scoped a **skeleton** landing + minimal ttyd wrap. George wants production:

1. **Landing page must be useful, connected, beautiful** — real copy, signed-in-try flow, embedded demo.
2. **Local TUI must be beautiful** — current Ink app works but the polish is uneven (boot, transcript, tool-call, status bar all need a pass).
3. **Web TUI must match** — ttyd wrap of the polished local TUI, not a vanilla xterm.
4. **Anthropic credits were refreshed** — real CLI end-to-end tests are possible again; tier T0 verifies the baseline before we touch anything.
5. **Ultrathink with parallel agents** for the design brief (brand / TUI target / landing / demo) so we don't redesign in the middle of a tier.

---

## Tier map

| Tier | Goal | Prompts | Runs |
|---|---|---|---|
| **T0** | Baseline verify + design brief | 2 | sequential in fresh tmux |
| **T1** | Local TUI beautification | 4 | fresh tmux |
| **T2** | Landing page (production) | 3 | fresh tmux |
| **T3** | Web TUI deploy stack | 3 | fresh tmux |
| **T4** | End-to-end verification | 2 | fresh tmux |

Between tiers: `run-phases.sh` kills the tmux and spawns a fresh `claude`. Prevents context exhaustion.

---

## Prompts

### T0 — Foundation (verify nothing's broken, then research)

- **T0-01** `cli-smoke-anthropic.md` — run `jellyclaw run "hello"`, `jellyclaw tui` (spawn, capture, teardown), `jellyclaw-serve` against a real Anthropic key. If any are broken, FAIL early — no point polishing a broken engine.
- **T0-02** `ultrathink-design-research.md` — 4 parallel subagents: (a) brand palette refresh for landing+TUI consistency, (b) TUI component target mockups (ASCII), (c) landing-page copy + structure, (d) demo embed strategy (asciinema vs video vs static). Writes `T6-04-DESIGN-BRIEF.md` to repo root.

### T1 — Local TUI polish

- **T1-01** `tui-theme-typography.md` — refine `engine/src/tui/theme/brand.ts`: tighten palette, add typography tokens (heading/body/mono sizes, border glyphs, density scales). Regression: existing 67 TUI tests green.
- **T1-02** `tui-splash-boot-polish.md` — `splash.tsx`, `boot-animation.tsx`, `jellyfish.tsx`, `jellyfish-spinner.ts`: redesign boot sequence to feel alive (staggered reveal, heartbeat spinner, brand wordmark). Respect `NO_COLOR` / `JELLYCLAW_NO_ANIM` env guards.
- **T1-03** `tui-transcript-toolcall-polish.md` — `transcript.tsx`, `tool-call.tsx`, `diff-view.tsx`, `thinking.tsx`, `markdown.tsx`: better spacing, collapsible long outputs, inline tool-status banners, color-coded per accent trio.
- **T1-04** `tui-statusbar-input-polish.md` — `status-bar.tsx`, `input-box.tsx`, commands/: model pill, cost pill, slash-command hints, multi-line paste, placeholder text.

### T2 — Landing page

- **T2-01** `landing-brand-assets-and-demo-record.md` — generate/choose assets in `site/images/`, record a 30s asciinema cast of a polished `jellyclaw run` session, commit as `site/assets/demo.cast`.
- **T2-02** `landing-page-build.md` — hand-written `site/index.html` with inline `<style>` (target <40KB total, no Google Fonts, no framework). Hero + features + "Try it" CTA (link to `/tui`) + footer. Uses T0-02 copy + T2-01 assets. Validates HTML, no broken images.
- **T2-03** `landing-a11y-lighthouse-csp.md` — Lighthouse ≥90 on perf/a11y/best-practices/SEO (via `npx lighthouse` against `bun run serve:site`), CSP meta tag, `prefers-reduced-motion` fallback.

### T3 — Web TUI deploy stack

- **T3-01** `ttyd-dockerfile-caddyfile.md` — new `web-tui/Dockerfile.ttyd` stage, root-level `Caddyfile`, modify T6-01 `Dockerfile` to copy ttyd + Caddy + `site/` tree. Single image.
- **T3-02** `container-entrypoint-supervisor.md` — `scripts/container-entrypoint.sh` using `tini` to supervise jellyclaw-serve (8080), ttyd (7681), Caddy (80). Graceful shutdown on SIGTERM.
- **T3-03** `web-tui-playwright-smoke.md` — ephemeral `docker build` + `docker run` then Playwright script hits `/` (landing HTML visible), hits `/tui` (xterm canvas renders), captures screenshot. Runs under `JELLYCLAW_WEB_TUI_E2E=1` flag.

### T4 — Verify

- **T4-01** `full-anthropic-smoke.md` — with real `ANTHROPIC_API_KEY`, exercise: `jellyclaw run`, `jellyclaw tui` (Ink mount + key-press via `node-pty` fixture), `jellyclaw serve` + HTTP `/v1/run`, web-TUI container `/tui`. Capture transcripts; compare against T0-01 baseline for regression.
- **T4-02** `golden-prompt-baselines.md` — record 5 golden prompts (listed in prompt spec) as fixtures in `engine/test/golden/`. Each has expected-substring assertions only (non-deterministic LLM output). Adds `bun run test:golden` script.

---

## How to run

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

# Pre-flight
claude --version                                   # must be on PATH
tmux -V
jq 'keys' ~/.jellyclaw/credentials.json || echo "no creds — run 'jellyclaw key' first"
ls prompts/phase-08-hosting/T6-04-landing-and-tui/T*.md | wc -l    # should be 14

# Single tier (test the pipeline first):
nohup ./scripts/autobuild-simple/run.sh T0 \
  > .autobuild-simple/T0.log 2>&1 &

# All tiers chained with fresh tmux between:
nohup ./scripts/autobuild-simple/run-phases.sh T0 T1 T2 T3 T4 \
  > .autobuild-simple/chain.log 2>&1 &

# Watch live:
tmux attach -t jc-autobuild    # Ctrl+B then d to detach
tail -f .autobuild-simple/state.log
```

## Per-prompt contract

Every prompt spec in `T6-04-landing-and-tui/` follows the autobuild-simple format:

```yaml
---
id: T<tier>-<num>-<slug>
tier: <0|1|2|3|4>
title: <one-liner>
scope:
  - <file or dir the prompt is allowed to touch>
depends_on_fix:
  - <other T-id that must land first; empty if none>
tests:
  - name: <slug>
    kind: shell | jellyclaw-run | jellyclaw-tui | http
    command: <one-line shell invocation>
    expect_exit: 0           # OR wait_for_stderr: "<substring>"
    timeout_sec: 60
human_gate: false
max_turns: 40
max_cost_usd: 15
max_retries: 3
estimated_duration_min: 25
---

# <Title>

## Context
## Root cause (or baseline to preserve)
## Fix — exact change needed
## Acceptance criteria
## Out of scope
## Verification the worker should self-run before finishing
```

The autobuild orchestrator only reads the body; the frontmatter is for the worker to self-test. The marker to advance is `DONE: <id>` (or `FAIL: <id> <reason>`) printed as its own line — see `scripts/autobuild-simple/README.md`.

---

## Out of scope for this plan

- Tauri desktop shell — killed for v1 per Agent 3.
- Phase 11 testing harness — queued after Phase 99 Unfucking completes.
- npm publish + brew formula — Phase 18.
- Embedded Anthropic OAuth flow — BYOK credential prompt already works; proper OAuth is post-v1.

## Rollback

All changes are uncommitted; `git checkout -- .` reverses any tier. Tier T3 adds new files only (new Dockerfile stage, new Caddyfile, new entrypoint script) — easy to `rm` cleanly.

## Success signal

At the end of T4:
- `jellyclaw run "hello"` works end-to-end with real Anthropic key.
- `jellyclaw tui` renders a TUI George is proud of.
- `docker build -t jellyclaw-web . && docker run -p 8080:80 jellyclaw-web` and visiting `http://localhost:8080/` shows the landing page; `/tui` lands in the web TUI.
- Lighthouse score ≥90 on the landing.
- 5 golden prompts recorded as regression fixtures.
