# 🪼 jellyclaw

<div align="center">

**Open-source Claude Code runtime.**
Swap the closed proprietary agent loop for a transparent TypeScript one.
Same tools, same schema, your infra.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-%3E%3D20.6-informational)](package.json)
[![Bun](https://img.shields.io/badge/bun-%3E%3D1.1-black)](package.json)
[![Status](https://img.shields.io/badge/status-active-brightgreen)](STATUS.md)
[![TypeScript](https://img.shields.io/badge/typed-strict-blue)](tsconfig.json)

</div>

---

**jellyclaw** is an embeddable, auditable agent runtime — an open-source alternative to the proprietary `claude` binary. It exposes a stable typed event API so agents and apps can dispatch work without shelling out to a closed-source CLI. You bring the API key; jellyclaw handles the agent loop, tool calls, permissions, hooks, MCP, sessions, and streaming — all in strict TypeScript you can read.

## ✨ Features

- 🪼 **Claude-Code parity** — 11 built-in tools (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `TodoWrite`, `Task`, `NotebookEdit`, `WebSearch`) at schema parity. ✅ DONE
- 🌊 **Stream-first** — line-delimited `AgentEvent` protocol over stdout or SSE. Byte-parity target with Claude Code `stream-json`. ✅ DONE (parity on 3 golden prompts; 5-prompt target in M1)
- 🔌 **MCP client** — stdio + Streamable HTTP + deprecated SSE transports; OAuth with PKCE; Playwright MCP blessed at `0.0.41`. ✅ DONE
- 🛡️ **Permission engine + hooks** — deny-wins rule matcher, 10 hook event kinds, audit log at `~/.jellyclaw/logs/`. ✅ DONE
- 🔀 **Provider router** — Anthropic direct (primary, with prompt caching) + OpenRouter (opt-in, warn-on-startup). ✅ DONE
- 🪝 **Skills + subagents** — loads `.claude/skills/` unmodified; full subagent hook propagation. ✅ DONE
- 🖥️ **Interactive TUI** — Ink-based, jellyfish spinner, slash-command palette, in-place API key capture. ✅ DONE (Phase 10.5)
- 📡 **HTTP server** — `POST /v1/runs` + SSE with bearer auth, loopback-by-default, `Last-Event-Id` replay. ✅ DONE (Phase 10.02)
- 🖱️ **Tauri desktop app** — signed, notarized, auto-updating. 📋 PLANNED (Phase 15–16)
- 🎙️ **Voice triggers in-call** — `"Jelly, …"` inside a WebRTC call. 📋 PLANNED (Phase 17)

> See [`STATUS.md`](STATUS.md) for current progress and [`phases/README.md`](phases/README.md) for the roadmap graph.

## 🏗️ Architecture

```
     ┌──────────────────────────────────────────────────────────┐
     │   Consumers:  Genie  ·  jelly-claw  ·  jellyclaw CLI     │
     └────────┬────────────────┬───────────────────┬────────────┘
              │ spawn          │ JSON-RPC          │ direct import
     ┌────────▼────────────────▼───────────────────▼────────────┐
     │           Public API:  run() · AgentEvent · Engine       │
     ╰────────┬─────────────────────────────────────────────────╯
              │
     ╭────────▼─────────────────────────────────────────────────╮
     │                    jellyclaw core                        │
     │                                                          │
     │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌────────┐ │
     │  │ event bus │  │ sessions  │  │   tools   │  │  perms │ │
     │  └───────────┘  └───────────┘  └───────────┘  └────────┘ │
     │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌────────┐ │
     │  │    MCP    │  │   hooks   │  │  skills   │  │ agents │ │
     │  └───────────┘  └───────────┘  └───────────┘  └────────┘ │
     │                                                          │
     │  ╔═════════════════════════════════════════════════════╗ │
     │  ║              provider router                        ║ │
     │  ║     Anthropic direct  │   OpenRouter (opt-in)       ║ │
     │  ╚═════════════════════════════════════════════════════╝ │
     ╰──────────────────────────┬───────────────────────────────╯
                                │
                       ┌────────▼────────┐
                       │  Anthropic API  │
                       │  (opus · sonnet)│
                       └─────────────────┘
```

Three entry points drive the same core: the **TUI** (Ink), the **CLI** (`jellyclaw run`), and the **HTTP server** (`jellyclaw serve`). All speak the same `AgentEvent` event protocol. More detail in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## ⚡ Quick Start

```bash
git clone https://github.com/gtrush03/jellyclaw-engine.git
cd jellyclaw-engine
bun install
bun run build

# Add your Anthropic key (get one at https://console.anthropic.com)
export ANTHROPIC_API_KEY=sk-ant-...

# Launch the interactive TUI (uses bun — the TUI imports TSX dynamically)
./engine/bin/jellyclaw tui
```

You should see:

```
🪼  jellyclaw           open-source agent runtime · 1M context
    ──────────────────────────────────────────────────────────
    claude-sonnet-4-5  ·  ~/your-project

    Type a prompt or / for commands.
```

Prefer a one-shot run without the TUI? Pipe a prompt in:

```bash
./engine/bin/jellyclaw run "list the files in this repo"
```

A 60-second walkthrough lives at [`docs/GETTING-STARTED.md`](docs/GETTING-STARTED.md).

## 🎮 TUI slash commands

| Command           | What it does                                         |
|-------------------|------------------------------------------------------|
| `/help`           | List available commands                              |
| `/model [name]`   | Switch model for the next run (no arg = show current)|
| `/clear`          | Clear the transcript (keeps session)                 |
| `/new`            | Start a fresh session                                |
| `/sessions`       | List prior sessions (most recent first)              |
| `/resume <id>`    | Resume a prior session by id                         |
| `/cwd`            | Print the current working directory                  |
| `/cost`           | Show session usage + cost                            |
| `/cancel`         | Cancel the active run                                |
| `/key`            | Rotate the API key (exits TUI — run `jellyclaw key`) |
| `/end`            | Exit the TUI (aliases: `/exit`, `/quit`)             |

Full TUI reference: [`docs/tui.md`](docs/tui.md).

## 📡 HTTP API

```
 client ──POST /v1/runs──▶  jellyclaw serve
   │                           │
   │                           ├── spawn session
   │                           │
   └◀── SSE /v1/runs/:id/events ──┐
                                  │
    event: message.delta          │
    data: {"text":"Hello"}        │ engine events:
                                  │   session.start
    event: tool.call              │   message.delta
    data: {"tool":"Bash",...}     │   tool.call / tool.result
                                  │   permission.requested
    event: done                   │   usage.update
    data: {"exit":0,"usage":...}  │   done
```

Working `curl` example:

```bash
# Generate a token, export it, start the server.
export JELLYCLAW_TOKEN=$(openssl rand -hex 32)
./engine/bin/jellyclaw-serve --port 8765 &

# Health probe.
curl -s http://127.0.0.1:8765/v1/health \
  -H "Authorization: Bearer $JELLYCLAW_TOKEN"
# => {"ok":true,"version":"0.1.0","uptime_ms":1234,"active_runs":0}

# Dispatch a run.
RUN_ID=$(curl -s http://127.0.0.1:8765/v1/runs \
  -H "Authorization: Bearer $JELLYCLAW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"say hi"}' | jq -r .runId)

# Stream its events (Ctrl-C to stop).
curl -N http://127.0.0.1:8765/v1/runs/"$RUN_ID"/events \
  -H "Authorization: Bearer $JELLYCLAW_TOKEN"
```

Sample SSE output:

```
event: session.start
data: {"sessionId":"sess_01hxy...","ts":"2026-04-15T20:00:00Z"}

event: message.delta
data: {"text":"Hi!"}

event: usage.update
data: {"inputTokens":842,"outputTokens":2,"costUsd":0.0025}

event: done
data: {"exit":0}
```

Full reference: [`docs/http-api.md`](docs/http-api.md).

## 🧪 Current Status

Source of truth: [`STATUS.md`](STATUS.md).

| Phase   | Name                                 | Status |
|---------|--------------------------------------|--------|
| 00      | Repo scaffolding                     | ✅ done |
| 01      | Runtime bootstrap                    | ✅ done |
| 02      | Config + provider layer              | ✅ done |
| 03      | Event stream adapter                 | ✅ done |
| 04      | Tool parity (11 tools)               | ✅ done |
| 05      | Skills system                        | ✅ done |
| 06      | Subagents + hook propagation         | ✅ done |
| 07      | MCP client (stdio + HTTP + SSE)      | ✅ done |
| 08      | Permission engine + hooks            | ✅ done |
| 09      | Session persistence + resume        | ✅ done |
| 10      | CLI + HTTP server + library          | ✅ done |
| 10.5    | Interactive TUI                      | ✅ done |
| 99      | Unfucking sprint                     | 🚧 5.5/8 |
| 11      | Testing harness (5 golden prompts)   | 📋 planned |
| 12–13   | Genie integration + cutover          | 📋 planned |
| 14      | Observability (OTLP traces)          | 📋 planned |
| 15–16   | Desktop app (Tauri 2)                | 📋 planned |
| 17      | jelly-claw in-call integration       | 📋 planned |
| 18      | Public OSS release                   | 📋 planned |

## 🗺️ Roadmap

Q2 2026 → v1.0 engine ships. Q3 → jelly-claw voice triggers. Q4 → public GitHub + community skills registry. Details in [`ROADMAP.md`](ROADMAP.md).

```
  2026                                                2027
  ├─ Q2 ─────────────┼─ Q3 ──────────┼─ Q4 ──────────┼─ Q1+ ────
  │                  │               │               │
  │  M1  M2   M3     │     M4        │     M5        │  ACP · mobile
  │  │   │    │      │     │         │     │         │
  │  ▼   ▼    ▼      │     ▼         │     ▼         │
  │ engine Genie  desktop  jelly-claw    PUBLIC      │  enterprise
  │ works  on it  ships    voice AI      jellyclaw   │  self-host
  │                                                  │
```

## 🛠️ Development

```bash
bun install
bun run dev         # tsup --watch
bun run test        # vitest run
bun run test:watch  # vitest
bun run lint        # biome check
bun run format      # biome format --write
bun run typecheck   # tsc --noEmit
bun run build       # tsup → engine/dist/
```

**Required env** (copy [`.env.example`](.env.example) to `.env.local`):

| Var                       | Required? | Notes                                          |
|---------------------------|-----------|------------------------------------------------|
| `ANTHROPIC_API_KEY`       | yes (default) | Get one at https://console.anthropic.com   |
| `OPENROUTER_API_KEY`      | opt-in    | Warn-on-startup; caching is lossy              |
| `JELLYCLAW_TOKEN`         | server    | Bearer for `jellyclaw serve`                   |
| `JELLYCLAW_LOG_LEVEL`     | no        | `trace \| debug \| info \| warn \| error \| silent` |
| `JELLYCLAW_TELEMETRY_DISABLED` | no   | Telemetry is already off; flag exists for assertions |

**Point at OpenRouter** instead of Anthropic direct by setting
`OPENROUTER_API_KEY` and passing a `openrouter/…` model string
(e.g. `--model openrouter/anthropic/claude-sonnet-4`). jellyclaw will
WARN on startup — [`docs/providers.md`](docs/providers.md) explains why.

Repo conventions (strict TS, no `console.log`, Biome, Vitest, conventional commits) live in [`CLAUDE.md`](CLAUDE.md).

## 📐 Design: one request, end to end

```
  ┌─────────┐
  │ prompt  │  user types or POSTs it
  └────┬────┘
       ▼
  ┌─────────────┐
  │   session   │  allocate id, load skills/agents, build tool registry
  │   manager   │
  └────┬────────┘
       ▼
  ┌─────────────┐    ┌──────────────┐
  │  provider   │───▶│ Anthropic or │  SSE stream of deltas
  │   router    │    │  OpenRouter  │
  └────┬────────┘    └──────────────┘
       ▼
  ┌─────────────┐
  │   adapter   │  translate provider chunks → AgentEvent
  └────┬────────┘
       ▼
  ┌─────────────┐    ┌────────────┐    ┌────────────┐
  │  event bus  │───▶│   hooks    │───▶│   perms    │
  └────┬────────┘    └──────┬─────┘    └──────┬─────┘
       ▼                    ▼                 ▼
  ┌─────────────┐    ┌────────────┐    allow / deny / ask
  │  tools ·    │◀───│ tool.call  │
  │  MCP · bash │    └────────────┘
  └────┬────────┘
       ▼
  tool.result ──▶ back into the turn loop until the model emits `done`.
```

## 🎨 Theme

The jellyjelly palette lives at [`engine/src/tui/theme/brand.ts`](engine/src/tui/theme/brand.ts). Five semantic colors over a deep-sea base:

| Swatch | Hex        | Name            | Used for                             |
|--------|------------|-----------------|--------------------------------------|
| 🟦     | `#3BA7FF`  | Jelly Cyan      | bell / primary focus / user accent   |
| 🟪     | `#9E7BFF`  | Medusa Violet   | tentacle glow / assistant accent     |
| 🟧     | `#FFB547`  | Amber Eye       | heartbeat / warning / tool emphasis  |
| 🟥     | `#FF6FB5`  | Blush Pink      | "candid" highlight / rim accent      |
| ⬛     | `#0A1020`  | Abyss           | background                           |

Per-session variance hashes the session id to pick one of five accent rotations, so each session looks distinct without straying from the palette.

## 🤝 Contributing

PRs are welcome — please **open an issue first**. Work happens phase-by-phase in [`phases/`](phases/), and random code before the phase it belongs to tends to get thrown away. Repo conventions are in [`CLAUDE.md`](CLAUDE.md).

Work through phases **in order**. Each phase has an objective, a definition of done, a test plan, and a rollback plan. Do not start Phase N+1 until Phase N's DoD passes.

## 📜 License

[MIT](LICENSE) — use it, fork it, embed it, ship it. No warranty.

## 👤 Author

**George Trushevskiy** — [@gtrush03](https://github.com/gtrush03)

## 🙏 Acknowledgments

- **Anthropic** — the Claude Code UX jellyclaw is built to preserve.
- [**Genie**](https://github.com/gtrush03/genie-2.0) — first consumer and north-star.

---

<div align="center">
<sub>🪼 jellyclaw is infrastructure, not a product. Users see <b>Genie</b> or <b>jelly-claw</b>; jellyclaw is the engine underneath.</sub>
</div>
