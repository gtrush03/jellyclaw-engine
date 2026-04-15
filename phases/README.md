# Jellyclaw Engine — Master Phased Development Plan

Open-source Claude Code replacement for Genie, eventually embedded in the `jelly-claw` macOS video-calling app as its AI layer.

## Design pillars

1. **Thin wrapper on OpenCode `>=1.4.4`** — inherit provider abstraction, tools, MCP client, session server. Do not fork. Pin + patch.
2. **Anthropic direct first, OpenRouter second** — OpenRouter prompt-cache has known bugs (silent misses, incorrect `cache_read_input_tokens`). Anthropic native caching is the default.
3. **Match Claude Code UX** — same tools, skills, subagents, session resume, stream-json output, hook contract. A Genie wish that runs on Claurst must run identically on jellyclaw.
4. **Genie backward-compat** — read `.claude/skills/` and `.claude/agents/` as fallback so existing Genie installs keep working.
5. **Browser via config only** — jellyclaw knows nothing about Chrome. Genie wires `playwright-mcp@0.0.41` pointing at CDP `127.0.0.1:9222` through `jellyclaw.json`.
6. **Swap-and-go for Genie** — one env var (`GENIE_ENGINE=jellyclaw`) flips Genie's dispatcher. Claurst stays as the safety net.

## Phase table

| # | Name | Duration | Depends on | Blocks |
|---|------|----------|------------|--------|
| 00 | Repo scaffolding | 0.5 d | — | 01-19 |
| 01 | OpenCode pinning and patching | 1 d | 00 | 02-07 |
| 02 | Config + provider layer | 2 d | 01 | 03, 04, 08, 10 |
| 03 | Event stream adapter | 2 d | 01, 02 | 10, 11, 12 |
| 04 | Tool parity | 3 d | 01, 02 | 11, 12 |
| 05 | Skills system | 1.5 d | 01 | 11, 12 |
| 06 | Subagent system + hook patch | 2 d | 01, 04, 05 | 08, 11, 12 |
| 07 | MCP client integration | 1.5 d | 01, 02 | 11, 12 |
| 08 | Permission engine + hooks | 2 d | 02, 04, 06 | 10, 11 |
| 09 | Session persistence + resume | 2 d | 03 | 10, 11 |
| 10 | CLI + HTTP server + library | 2 d | 02, 03, 08, 09 | 11, 12, 15 |
| 11 | Testing harness | 3 d | 02-10 | 12, 13, 18 |
| 12 | Genie integration behind flag | 3 d | 10, 11 | 13 |
| 13 | Make jellyclaw default in Genie | 2 d + 72 h burn-in | 12 | 14, 17 |
| 14 | Observability + tracing | 2 d | 10 | 18 |
| 15 | Desktop app MVP (Tauri 2) | 5 d | 10 | 16 |
| 16 | Desktop app polish | 5 d | 15 | 18 |
| 17 | Integration into jelly-claw | 5 d | 13, 14 | 18 |
| 18 | Open-source release | 2 d | 11, 14, 16, 17 | 19 |
| 19 | Post-launch stabilization | ongoing | 18 | — |

**Total before 19:** ~46 engineering days + 72 h burn-in. Plan for ~9-10 calendar weeks solo, ~5-6 weeks with a second engineer pair.

## Dependency graph (ASCII)

```
00 ── 01 ─┬─ 02 ─┬─ 03 ─┐
          │      ├─ 04 ─┤
          ├─ 05 ─┤      ├─ 09 ─┐
          │      ├─ 06 ─┤      │
          └─ 07 ─┘      └─ 08 ─┼─ 10 ─ 11 ─ 12 ─ 13 ─┬─ 14 ── 18 ── 19
                               │                     └─ 17 ─┘
                               └── 15 ── 16 ──────────────┘
```

## Milestone gates

- **M1 — "Engine works"** after Phase 11. `jellyclaw run "hello world"` produces identical output to `claurst run "hello world"` on 5 golden prompts.
- **M2 — "Genie on jellyclaw"** after Phase 13. Genie's production wishes run on jellyclaw with no regressions after 72 h burn-in.
- **M3 — "Desktop ships"** after Phase 16. Signed `.dmg` auto-updates in the field.
- **M4 — "jelly-claw AI"** after Phase 17. Voice-triggered agent fires inside a live video call.
- **M5 — "Public"** after Phase 18. npm + brew + GitHub public.

## How to use these files

Each `PHASE-NN-<name>.md` is a self-contained runbook. Open it and work top to bottom. Every step has (a) what to do, (b) the exact command, (c) expected output, (d) verification, (e) failure recovery. No questions should need to be asked.

Frontmatter on each file records phase number, duration, dependencies, and what it blocks. Respect the `depends_on` field — do not start a phase with unmet deps.
