# Jellyclaw Engine — Prompt Dependency Graph

Visual reference showing which prompts block which. Read top-to-bottom; arrows indicate "must complete before". Phases on the same horizontal band can be executed in parallel worktrees/sessions.

```
┌─────────────────────────────────────────────────────────────────┐
│                          FOUNDATION                              │
└─────────────────────────────────────────────────────────────────┘

Phase 00 — Repo scaffolding (1 prompt)
    │
    │  01-scaffold.md
    ▼
Phase 01 — OpenCode pinning + patching (2 prompts, sequential)
    │
    │  01-research-opencode.md
    │  02-pin-and-patch.md
    ▼
Phase 02 — Config + provider layer (3 prompts, sequential)
    │
    │  01-config-schema.md
    │  02-provider-anthropic.md
    │  03-provider-openrouter.md
    ▼
Phase 03 — Event stream adapter (2 prompts, sequential — needs 02)
    │
    │  01-stream-types.md
    │  02-adapter-impl.md
    ▼
┌───────────────────────┬─────────────────────────────────────────┐
│                       │                                         │
▼                       ▼                                         │
Phase 04 — Tool parity  Phase 05 — Skills system                  │
(5 prompts, PARALLEL)   (2 prompts, parallel w/ 04)               │
                                                                  │
  01-read.md              01-skill-loader.md                      │
  02-edit.md              02-skill-runtime.md                     │
  03-bash.md                                                      │
  04-grep-glob.md                                                 │
  05-web.md                                                       │
│                       │                                         │
└──────────┬────────────┘                                         │
           ▼                                                      │
Phase 06 — Subagent system + hook patch (3 prompts, sequential)   │
    │                                                             │
    │  01-subagent-spawn.md                                       │
    │  02-hook-points.md                                          │
    │  03-patch-opencode-hooks.md                                 │
    ▼                                                             │
┌─────────────────────────────────────────────────────────────────┘
│                          CORE ENGINE
└─────────────────────────────────────────────────────────────────┐
    │                                                             │
    ├──────────────────────┬──────────────────────────────────────┤
    ▼                      ▼                                      │
Phase 07 — MCP client      Phase 08 — Permission engine           │
(3 prompts, parallel w/08) (3 prompts, parallel w/07)             │
                                                                  │
  01-mcp-stdio.md            01-permission-schema.md              │
  02-mcp-http.md             02-permission-evaluator.md           │
  03-mcp-tool-bridge.md      03-permission-ui-prompt.md           │
    │                      │                                      │
    └──────────┬───────────┘                                      │
               ▼                                                  │
Phase 09 — Session persistence + resume (2 prompts — after 08)    │
    │                                                             │
    │  01-session-store.md                                        │
    │  02-resume-flow.md                                          │
    ▼                                                             │
Phase 10 — CLI + HTTP server + library (3 prompts — after 06-09)  │
    │                                                             │
    │  01-library-api.md                                          │
    │  02-cli-commands.md                                         │
    │  03-http-server.md                                          │
    ▼                                                             │
Phase 11 — Testing harness (5 prompts, ongoing from phase 04+)    │
    │                                                             │
    │  01-fixture-recorder.md                                     │
    │  02-unit-harness.md                                         │
    │  03-integration-harness.md                                  │
    │  04-e2e-harness.md                                          │
    │  05-ci-wiring.md                                            │
    ▼                                                             │
┌─────────────────────────────────────────────────────────────────┘
│                      GENIE INTEGRATION
└─────────────────────────────────────────────────────────────────┐
    │                                                             │
Phase 12 — Genie integration behind flag (4 prompts — after 10+11)│
    │                                                             │
    │  01-genie-adapter.md                                        │
    │  02-feature-flag.md                                         │
    │  03-workflow-smoke.md                                       │
    │  04-parity-diff.md                                          │
    ▼                                                             │
    ├─────────────────────────────┐                               │
    ▼                             ▼                               │
Phase 13 — Make default           Phase 14 — Observability        │
(2 prompts + 72h burn-in)         (3 prompts, parallel w/13)      │
  01-flip-default.md                01-otel-wiring.md             │
  02-burn-in-monitor.md             02-trace-schema.md            │
                                    03-dashboard.md               │
    │                             │                               │
    └──────────────┬──────────────┘                               │
                   ▼                                              │
┌─────────────────────────────────────────────────────────────────┘
│                    DESKTOP + ECOSYSTEM
└─────────────────────────────────────────────────────────────────┐

Phase 15 — Desktop MVP (5 prompts — after 10)
    │
    │  01-tauri-scaffold.md
    │  02-engine-bridge.md
    │  03-chat-ui.md
    │  04-session-picker.md
    │  05-settings.md
    ▼
Phase 16 — Desktop polish (5 prompts — after 15)
    │
    │  01-notifications.md
    │  02-tray-icon.md
    │  03-keybindings.md
    │  04-themes.md
    │  05-auto-update.md
    ▼
Phase 17 — jelly-claw video integration (4 prompts — after 16)
    │
    │  01-call-hook.md
    │  02-agent-avatar.md
    │  03-transcript-bridge.md
    │  04-multiparty.md
    ▼
Phase 18 — Open-source release (3 prompts — after 13+16)
    │
    │  01-license-audit.md
    │  02-public-docs.md
    │  03-launch.md
    ▼
Phase 19 — Post-launch stabilization (ongoing)
```

## Critical path

The critical path (longest chain of must-be-sequential work) is:

```
00 → 01 → 02 → 03 → 04/05 → 06 → 07/08 → 09 → 10 → 11 → 12 → 13
```

That is 12 phases of sequential work before jellyclaw becomes Genie's default. Desktop (15-17) and OSS (18) hang off the core engine (10) and Genie default (13) respectively, so they can proceed in parallel once their gates lift.

## Parallelization opportunities

- **Phase 04 + 05** — run concurrently, 5 + 2 = 7 prompts in 7 worktrees if you want maximum throughput.
- **Phase 07 + 08** — run concurrently, 3 + 3 = 6 prompts in parallel.
- **Phase 13 + 14** — flip-default and observability are independent; run in parallel while 13's 72-hour burn-in clock ticks.
- **Phase 15 onward** — desktop track and OSS track can proceed independently once gated phases are ✅.

## Gates that cannot be skipped

- Phase 11 (testing harness) must reach "CI green" before Phase 12 begins — you cannot validate Genie integration without the harness.
- Phase 13's 72-hour burn-in is a wall-clock gate, not a code gate. Do not flip it shorter without opening a blocker row and getting George's explicit sign-off.
- Phase 18 (OSS release) requires Phase 13 ✅ (proven in production) and Phase 16 ✅ (desktop polish shipped) — releasing an alpha to the public with an unproven core is off-limits.
