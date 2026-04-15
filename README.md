# jellyclaw

> An open-source, embeddable replacement for Claude Code — wrapping [OpenCode](https://github.com/sst/opencode) `>=1.4.4` behind a small, stable, event-driven API.

`jellyclaw` is the engine Genie runs on, and the agent that will eventually live inside the
[jelly-claw](https://github.com/gtrush03/jelly-claw) video-calling app. Instead of shelling out
to the proprietary `claude` CLI, jellyclaw exposes a typed, streaming, programmable surface over a
hardened OpenCode core — with first-class support for MCP servers, skills, subagents, permission
gating, hook execution, and provider routing between Anthropic direct and OpenRouter.

## Status

**Pre-alpha.** Currently building Phase 0 (scaffolding) and Phase 1 (OpenCode pinning).
See [`phases/README.md`](phases/README.md) for the full roadmap.

Nothing here is stable. Nothing here is secure-by-default yet (CVE-22812 mitigation lands in Phase 2).
Do not ship this into a product before Phase 5.

## Why

Genie currently dispatches work to `claude -p` via a child process. That works, but:

1. The `claude` binary is closed source, so we can't audit tool calls or patch subagent bugs
   (e.g. [#5894 subagent hook skip](https://github.com/anthropics/claude-code/issues/5894)).
2. Embedding a proprietary binary into a shipped macOS app (jelly-claw) is a licensing and
   distribution risk.
3. We lose access to the structured internal event stream — we see stdout, not state transitions.

OpenCode solves 1 and 2. jellyclaw solves 3 by putting a **stable typed event API** on top of
OpenCode so Genie, the jelly-claw desktop app, and future consumers can all speak the same
protocol regardless of what's happening inside the engine.

## Architecture at a glance

```
                        ┌─────────────────────────────────────────┐
  wish / prompt ──►     │           jellyclaw public API          │
                        │   run() · createEngine() · AgentEvent   │
                        └───────────────┬─────────────────────────┘
                                        │
                        ┌───────────────▼─────────────────────────┐
                        │          jellyclaw engine core          │
                        │  event bus · session mgr · permission   │
                        │  tool registry · hook runner · MCP      │
                        └───────┬──────────────────────┬──────────┘
                                │                      │
                    ┌───────────▼─────────┐  ┌─────────▼─────────┐
                    │   OpenCode >=1.4.4  │  │  provider router  │
                    │   (pinned, patched) │  │ Anthropic / OR    │
                    └─────────────────────┘  └───────────────────┘
                                │
                        ┌───────▼──────────┐
                        │  consumers:      │
                        │  Genie · CLI ·   │
                        │  jelly-claw app  │
                        └──────────────────┘
```

## Quick start

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun install
bun run build

export ANTHROPIC_API_KEY=sk-ant-...
node engine/dist/cli/main.js run "hello world"
```

> For the HTTP server use `jellyclaw-serve` (node) — `jellyclaw serve` under
> bun hits a known SSE chunked-encoding bug in `@hono/node-server`.

For the full Day 1 walkthrough see [`scripts/day-1.md`](scripts/day-1.md).

## Interactive TUI

`jellyclaw tui` opens a Claude-Code-shaped interactive terminal UI backed
by the same engine the CLI and HTTP server use — streaming tokens,
tool-call cards, permission prompts, session sidebar, slash-command
palette, and diff viewer, rebranded with a purple-primary `jellyclaw`
theme and jellyfish spinner. It boots the engine HTTP server in-process
on a random loopback port, mints a Bearer token, and tears everything
down cleanly on `Ctrl-C`. Use `jellyclaw attach <url>` to point the TUI
at an already-running server instead. See [`docs/tui.md`](docs/tui.md)
for flags, env vars, exit codes, and the vendor upgrade procedure.

## Repo layout

```
engine/          TypeScript source — the engine itself
  src/           Library + CLI entry points
  SPEC.md        Engine spec (authoritative)
  SECURITY.md    Threat model + CVE mitigation (Phase 2+)
agents/          Built-in agent definitions (YAML)
skills/          Built-in skills shipped with the engine
patches/         patch-package patches against pinned OpenCode
phases/          Phase-by-phase build plan (read in order)
integration/     Consumer-side integration guides
  GENIE-INTEGRATION.md   How Genie swaps from `claude -p` to jellyclaw
desktop/         jelly-claw (Xcode/Swift) bridge
docs/            Architecture + internals documentation
scripts/         Dev setup, Day 1 guide, release helpers
test/            Vitest test suite
```

## Key documents

- [`engine/SPEC.md`](engine/SPEC.md) — what the engine does and how
- [`engine/CVE-MITIGATION.md`](engine/CVE-MITIGATION.md) — CVE-22812 defense plan
- [`phases/README.md`](phases/README.md) — phase plan (do them in order)
- [`integration/GENIE-INTEGRATION.md`](integration/GENIE-INTEGRATION.md) — Genie swap plan
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — internals

## Development

```bash
bun run dev     # watch-mode rebuild
bun run test    # vitest
bun run lint    # biome check
bun run format  # biome format --write
```

Conventions:

- **Strict TypeScript.** No `any`. No `@ts-ignore` without a linked issue.
- **No `console.log`.** Use the structured logger.
- **Biome** for lint + format (pre-commit hook, Phase 0).
- **Vitest** for tests. Coverage gate is 70 % starting Phase 3.
- **Conventional commits** (`feat:`, `fix:`, `chore:`, `docs:`).

## Contributing

Work through [`phases/`](phases) **in order**. Each phase has:

- An objective
- A definition of done
- A test plan
- A rollback plan

Do not start Phase N+1 until Phase N's DoD passes. If a phase reveals a flaw in the previous
one, update the previous phase doc rather than papering over it.

## License

[MIT](LICENSE).

## Acknowledgments

- [**OpenCode**](https://github.com/sst/opencode) (SST / @anomalyco) — the engine we wrap. Without
  OpenCode's open-source lift, jellyclaw would be a fork of a binary we can't read.
- **Anthropic** — the Claude Code UX is the thing we're trying to preserve. Many of the abstractions
  here (agents, skills, hooks, tool-use streaming, permission gates) are direct tributes to the
  shape that Claude Code proved out.
- The [**Genie**](https://github.com/gtrush03/genie-2.0) project — our first consumer, and the
  reason this engine exists. Every design decision here is downstream of "what does Genie need
  to keep working tomorrow."
