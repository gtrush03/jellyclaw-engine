# AGENTS-USED-IN-BUILD.md — Which rigs built what

> **Last refreshed:** 2026-04-19
> **Purpose:** Leave a paper trail of which autobuild rig dispatched which
> phase. Each rig has a different protocol, concurrency model, and
> escalation story — knowing which one produced a given commit matters
> when reproducing a failure or debugging a regression.
> **Detail:** See `COMPLETION-LOG.md` for prompt-by-prompt timing + verdicts.

---

## Rigs in this repo

| Directory               | Kind              | Status   | Used for                                                          |
| ----------------------- | ----------------- | -------- | ----------------------------------------------------------------- |
| `.autobuild/`           | Full rig          | live     | Phases 00 – 08, 10, 10.5, 11, 99. Dispatcher + budget + escalate. |
| `.autobuild-simple/`    | tmux-only kit     | live     | T6-04 landing + TUI redesign (42 prompts T0-T4, Apr 17-19).       |
| `.orchestrator/`        | Control-plane     | live     | Mediates dashboard ↔ `.autobuild/` queue + context mutations.     |
| `scripts/autobuild/`    | Rig source        | tracked  | The dispatcher + driver code for `.autobuild/`.                   |
| `scripts/autobuild-simple/` | Kit source    | tracked  | The `run.sh` tmux loop for `.autobuild-simple/`.                  |
| `scripts/orchestrator/` | Orchestrator src  | tracked  | The control-plane daemon + `grid.mjs`.                            |

All three runtime directories (`.autobuild/`, `.autobuild-simple/`, `.orchestrator/`) are gitignored — only their `README.md` + `config.yaml` are tracked. The runtime state lives in the developer's checkout and is not shared across machines.

---

## Timeline — which rig produced which phase

| Date                | Rig                       | Phase / sub-phase                                               | Prompts | Outcome                                                              |
| ------------------- | ------------------------- | --------------------------------------------------------------- | ------- | -------------------------------------------------------------------- |
| Apr 14 (Day 1)      | `.autobuild/` + `.orchestrator/` | Phase 00 scaffolding                                     | ~15     | Repo skeleton + docs + phase runbooks landed                         |
| Apr 15              | `.autobuild/`             | Phase 01 OpenCode pinning                                       | ~8      | Vendored subtree + SDK adapter                                       |
| Apr 15 – 16         | `.autobuild/`             | Phase 02-06 config + providers + CLI + agent loop + daemon      | ~40     | Closed per COMPLETION-LOG                                             |
| Apr 16              | `.autobuild/`             | Phase 10.5 TUI vendor + theme + API-key capture                 | 4       | TUI vendored, jellyfish theme, credentials store                     |
| Apr 16 – 17         | `.autobuild/`             | Phase 07.5 chrome-mcp                                           | ~10     | Chrome MCP integration + playwright 0.0.70 pin + docs                |
| Apr 17              | `.autobuild/`             | Phase 08 + phase 08-hosting T5 (HTTP/SSE, Exa, auth seam, SQLite, anim freeze) | 5   | Tool surface for v1 landed                                           |
| Apr 17              | `.autobuild/`             | Phase 08-hosting T6-01..T6-03 (Fly dockerfile/toml, Browserbase, gh actions) | 3 | Deploy plumbing landed                                               |
| Apr 17 – 19         | `.autobuild-simple/`      | Phase 08-hosting T6-04 landing + TUI redesign                   | 14      | Landing page + theme + 4-surface smoke PASS (2115 tests); crashed mid-run on input-box/status-bar, resumed by hand |
| Apr 17 – 19         | `.autobuild/`             | Phase 99 unfucking                                              | 5 / 8   | In-flight — 3 prompts remaining (session-restoration, multi-tenant isolation tests, final audit) |
| Apr 19 (this clean-up) | manual (this session)   | Repo hygiene: commit 292 paths, archive MASTER-PLAN, write DEPLOY.md / OPENHANDS-PORT.md / this doc | — | Working tree clean                                                   |

---

## Rig details

### `.autobuild/` — the full rig

Dispatcher-driven. One `state.json` rewritten on every tick; queue + context files under `.autobuild/`. Concurrency configurable (default 1). Daily budget cap in USD. Escalates to a human via `.autobuild/escalated/*` on 3 consecutive failures. Dispatcher source at `scripts/autobuild/dispatcher.mjs`.

- **When to use:** multi-prompt phases where cost tracking + escalation + retry-on-fail matter.
- **State:** per-session working dirs under `.autobuild/sessions/`, archived on completion.
- **Produced:** phases 00 – 10.5, phase 07.5, phase 08, phase 08-hosting T5-T6 (excl. T6-04), phase 99 (in flight).

### `.autobuild-simple/` — the tmux-only kit

`scripts/autobuild-simple/run.sh` — a bash loop that runs prompts sequentially in a named tmux session, logs to `chain.log` + `state.log` + `tmux.log`. No budget cap, no dispatcher, no escalation — it just chains `claude --dangerously-skip-permissions` invocations with fresh tmux sessions between tiers to dodge context exhaustion.

- **When to use:** a discrete, high-stakes sub-phase where George wants to watch each prompt land live and kill the chain if anything goes sideways. Meant to be short-lived.
- **Produced:** phase 08-hosting T6-04 (Apr 17 – 19, 14 prompts, crashed mid-run and was manually resumed).

### `.orchestrator/` — control plane

A separate daemon that arbitrates between dashboard commands (drop sentinel files into `.orchestrator/inbox/`) and the `.autobuild/` queue. UNIX-socket RPC on `control.sock`. The dashboard and the `jc` CLI never mutate `.autobuild/queue.json` directly — the orchestrator does it. Source at `scripts/orchestrator/`.

- **When to use:** always-on when the dashboard is up or `jc` commands are being used.
- **Produced:** no code directly; it's the gatekeeper that routed the commands that ran the prompts above.

---

## Not-rigs that people might confuse with rigs

- **`scripts/autobuild-simple/run.sh`** is the kit source; `.autobuild-simple/` is the runtime dir. They are _not_ the same thing.
- **`engine/src/daemon/`** is the engine's resumable-run daemon (the thing that powers `jellyclaw daemon` for long-running user sessions). It has nothing to do with the autobuild rig. Different code, different purpose, different state.
- **`desktop/src-tauri/`** is the Tauri wrapper around the engine for the macOS app; it does not participate in the autobuild story.

---

## Resume

```
claude --resume e6b2db12-f6fc-4a55-a38c-4fa620e8a609
```
