# T6-04 — Landing + beautiful TUI (autobuild sub-phase)

This directory holds the 14 tiered prompt specs for T6-04. The orchestrator
(`scripts/autobuild-simple/run.sh`) feeds them into a tmux Claude session one
at a time, sorted by id.

Read `T6-04-PLAN.md` at the repo root for the rationale and tier map, and
`T6-04-STARTUP.md` for the launch commands.

## Tier index

| ID | Goal | Est. min |
|---|---|---|
| T0-01 | CLI smoke — real Anthropic key | 15 |
| T0-02 | Ultrathink design brief (4 parallel agents) | 35 |
| T1-01 | Theme + typography tokens | 25 |
| T1-02 | Splash + boot animation polish | 30 |
| T1-03 | Transcript + tool-call + diff polish | 35 |
| T1-04 | Status bar + input box polish | 25 |
| T2-01 | Brand assets + asciinema demo cast | 30 |
| T2-02 | Landing page build (HTML + inline CSS) | 40 |
| T2-03 | A11y + Lighthouse + CSP | 25 |
| T3-01 | ttyd Dockerfile + Caddyfile | 35 |
| T3-02 | Container entrypoint supervisor | 25 |
| T3-03 | Web-TUI Playwright smoke | 30 |
| T4-01 | Full Anthropic smoke (CLI + TUI + serve + web) | 30 |
| T4-02 | Golden-prompt regression baselines (5) | 25 |

## Frontmatter contract

Every spec has a YAML frontmatter with acceptance tests the worker must run
before printing `DONE: <id>`. See any `T0-*.md` file in this dir for the
shape.

## Depends-on rules

- T0-02 depends on T0-01 (design brief assumes the CLI works)
- All T1-* depend on T0-02 (use the brief's tokens/targets)
- T2-02 depends on T2-01 (uses the demo cast + assets)
- T3-* depend on T1-04 (web TUI wraps the polished local TUI)
- T4-* depend on everything — they're the final verify
