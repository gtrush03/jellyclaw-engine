---
phase: 99
name: unfucking
duration_estimate: 2 days
depends_on: [10]
blocks: []
status: in-progress
---

# Phase 99 — UNFUCKING — Make the engine real

## Why this phase exists

Phase 10.5 was marked complete but **the engine does not actually power anything**. Audit findings (April 15, 2026):

- `engine/src/cli/tui.ts:443-470` deliberately suppresses the embedded-server path with `void spawnServer; void waitHealth; void launchTui;` and falls through to spawning **stock vendored OpenCode**, which has no `node_modules` installed anyway. The TUI does NOT talk to jellyclaw's engine.
- `engine/src/server/app.ts:54` — `/v1/runs/*` routes are stubbed but **never mounted** ("reserved for Agent B").
- `engine/src/legacy-run.ts` is a Phase-0 stub emitting fake `[phase-0 stub]` text. `RunManager.defaultRunFactory` still points at it. `engine.run()` therefore returns fake events.
- No adapter exists from `ProviderChunk` (real Anthropic SDK stream events) → `AgentEvent` (the wire schema). The provider works, but nothing consumes it.
- Jelly-Claw genie-server still spawns `claude -p` because there is nothing to swap to.

This phase rips out the fake completion, wires the real path end-to-end, ships a working TUI on the same SSE stream the desktop will use, and cuts Genie over to jellyclaw with shadow-mode safety. Goal: a working `jellyclaw run "hello"` and `jellyclaw tui` that actually call Anthropic, plus Genie running on jellyclaw within 2 weeks.

## Dream outcome

```bash
# This works end-to-end against real Anthropic API, with tool use:
ANTHROPIC_API_KEY=sk-... jellyclaw run "list files in cwd then summarize" --output-format claude-stream-json

# This boots an Ink TUI that talks to embedded jellyclaw engine, paste API key inside:
jellyclaw tui

# Jelly-Claw dispatches voice wishes through jellyclaw, falls back to claude on failure:
GENIE_ENGINE=jellyclaw GENIE_ENGINE_FALLBACK=1 launchctl kickstart -k gui/$UID/com.jellygenie.server
```

## Non-goals

- NOT rewriting the engine's provider/hook/MCP/skills layers (those work).
- NOT touching desktop Tauri shell (that's Phase 15).
- NOT shipping Windows TUI (cli exits 2 on win32, keep that).
- NOT building from scratch what already works — provider streaming, RunManager ring buffer, hooks runner, SessionWriter all stay.

## Prompt list

8 prompts, ~2hr each. Run sequentially; each is a single commit and a fresh Claude Code session.

| # | Prompt | Output |
|---|---|---|
| 01 | Adapter: ProviderChunk → AgentEvent | `engine/src/providers/adapter.ts` + tests |
| 02 | Real agent loop generator | `engine/src/agents/loop.ts` |
| 03 | Wire loop into RunManager + mount /v1/runs/* + CLI uses real engine | end-to-end `jellyclaw run` works against real Anthropic |
| 04 | Stream-json Claude-compat writer | `--output-format claude-stream-json` |
| 05 | Demolish vendored OpenCode + slim TUI client | dead code gone, `client.ts` is the only HTTP surface |
| 06 | Ink TUI shell with paste-in API key + session continuation | `jellyclaw tui` boots and renders real responses |
| 07 | Genie `selectEngine()` flag + dispatcher swap behind `GENIE_ENGINE` | shadow/canary/cutover gated by env var |
| 08 | Shadow mode + smoke-test harness + Genie cutover verification | 7-day shadow, then default flip |
