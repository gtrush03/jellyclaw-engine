# 🪼 jellyclaw — Architecture

This document describes how jellyclaw is put together: the layers, the components inside each
layer, how data flows through the system, where consumers hook in, and where extension authors
plug new behavior. Read this alongside [`engine/SPEC.md`](../engine/SPEC.md), which is the
authoritative description of _what_ the engine does; this document describes _how_.

**For contributors.** New to the repo? Read in this order:

1. [`../README.md`](../README.md) — what jellyclaw is.
2. [`../STATUS.md`](../STATUS.md) — what actually works right now.
3. This file, top to bottom — how the pieces fit together.
4. [`../engine/SPEC.md`](../engine/SPEC.md) — the authoritative contract.
5. [`../phases/README.md`](../phases/README.md) — the phase graph; pick the right phase before writing code.

```
   consumers                                            ┐
        │  spawn / stdio / import                       │
        ▼                                               │
   public API ─── run(), createEngine(), AgentEvent     │
        │                                               │  one process
        ▼                                               │  (unless serve)
   engine core ── bus, tools, perms, hooks, MCP, skills │
        │                                               │
        ▼                                               │
   provider router ── Anthropic direct / OpenRouter     │
        │                                               │
        ▼                                               │
   runtime core                     ┘
```

## 1. Layered view

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Consumers                                      │
│  ┌────────────┐   ┌────────────────┐   ┌─────────────────────────────┐ │
│  │  Genie     │   │  jelly-claw    │   │  jellyclaw CLI              │ │
│  │  (Node)    │   │  (Swift/Xcode) │   │  (this repo, dist/cli.js)   │ │
│  └─────┬──────┘   └───────┬────────┘   └─────────────┬───────────────┘ │
│        │                  │                          │                 │
└────────┼──────────────────┼──────────────────────────┼─────────────────┘
         │ spawn            │ JSON-RPC / stdio         │ direct import
         ▼                  ▼                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        Public API                                       │
│   run()  ·  createEngine()  ·  AgentEvent stream  ·  Engine handle      │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────────────────┐
│                        Engine core                                      │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  event bus   │  │ session mgr  │  │ tool registry│  │ permission   │ │
│  │              │  │              │  │              │  │   engine     │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘ │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐ │
│  │  MCP client  │  │ hook runner  │  │ skill loader │  │ agent loader │ │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘ │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │                       provider router                            │  │
│  │      AnthropicProvider        │        OpenRouterProvider        │  │
│  └──────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────┬───────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────────────────┐
│                   runtime core                            │
│     HTTP server · internal SDK · plugin API                │
└─────────────────────────────────────────────────────────────────────────┘
```

The engine core is a single process. The runtime can run embedded (same process) or out-of-process
(HTTP server mode); jellyclaw supports both. Phase 1 lands the SDK wiring for in-process; Phase 4
adds the out-of-process variant for the jelly-claw macOS app sandbox.

## 2. Engine internals

### Event bus

A typed pub/sub fan-out. All other components emit `AgentEvent` values into the bus; the public
API subscribers (CLI, Genie, macOS bridge) read from the bus. Implemented as an async generator
pipeline; backpressure is cooperative (slow consumers see events pile up in memory until they
drain). Events are also optionally persisted to a per-session NDJSON trace file under
`$JELLYCLAW_TRACE_DIR` for post-mortem debugging.

### Session manager

Owns the lifecycle of each dispatched wish. Allocates a session ID, tracks sequence numbers,
manages the turn counter, enforces max-turn and max-duration policy from config, and coordinates
shutdown (cancel a session cleanly on `SIGINT`, propagate to tools-in-flight, flush the trace).

### Tool registry

The authoritative list of callable tools for a session. Populated from three sources, in order:

1. **Built-in tools** baked into the engine (read, write, bash, edit, etc.).
2. **MCP tools** from configured MCP servers — each server's `tools/list` response is merged in
   under a `mcp__<server>__<name>` namespace.
3. **Plugin tools** registered through `plugin API` at engine boot.

The registry computes a stable hash of the tools array; that hash becomes the Anthropic
`cache_control` breakpoint key (so tools-unchanged sessions get cache hits).

### Provider router

Picks which `Provider` implementation handles the current request, based on config and (future)
per-agent overrides. Translates the engine's `StreamRequest` into the provider's native format
and translates the provider's streamed deltas back into `AgentEvent`s. This is the only layer
that knows vendor-specific wire formats.

### MCP client

Speaks the Model Context Protocol over stdio. Spawns configured MCP servers as child processes
at engine boot, calls `tools/list` + `resources/list` + `prompts/list`, subscribes to
`notifications/*`, proxies `tools/call` through to the right server. CVE-22812 mitigation lives
here: every MCP response is run through the path-traversal filter, shell-arg sanitizer, and
prompt-injection heuristic before being handed to the model.

### Permission engine

Evaluates `PermissionPolicy`. Three modes: `strict` (deny-by-default allow-list), `ask` (emit
`permission.requested`, wait for granted/denied reply), `allow` (pass through — dev only).
Decisions are cached per-session for `scope: "session"` grants and persisted to
`~/.config/jellyclaw/grants.json` for `scope: "forever"`.

### Hook runner

Runs pre-tool / post-tool / on-error / on-session-end hooks declared by agents, skills, or the
user's config. Hooks are sandboxed — they run in a worker thread with no direct access to the
engine core except through a narrow `HookContext` surface.

Related upstream issue: [#5894 subagent hook skip](https://github.com/anthropics/claude-code/issues/5894).
Our fix lives in `patches/` (applied via patch-package at postinstall) and is tracked in
Phase 2.

### Skill loader + Agent loader

Skills are YAML+Markdown bundles loaded from `config.skillsDir`. Agents are either config-level
references or YAML files; both are compiled into a normalized `CompiledAgent` shape that the
session manager hands to the provider router.

## 3. Data flow

The end-to-end path for a single wish:

```
1. Consumer calls  run({wish, engine})
2. Session manager allocates session_id, emits session.started
3. Wish parser (Phase 3) tags the wish: plain text? slash-command? includes @mentions?
4. Classifier (Phase 3) picks the agent — falls back to "default"
5. Skill loader materializes matching skills into the prompt
6. Tool registry assembles the tool list for this session
7. Provider router translates → native API → streams tokens back
8. Stream mapper converts provider deltas → AgentEvent
9. On tool_use: permission engine runs first → tool.called emitted →
   tool registry dispatches to MCP / builtin / plugin →
   post-tool hooks run → tool.result emitted
10. Loop until the model stops producing tool_use or max-turns hit
11. Session manager emits session.completed, closes the bus
```

Every arrow in that flow is an `AgentEvent` emitted into the bus. Consumers see the whole
cinematic story, not just stdout.

## 4. Integration points

**Genie dispatcher.** Genie swaps its existing `claude -p` child-process spawn for a
`spawn('./dist/cli.js', ['run', wish])` call and parses NDJSON events from stdout. See
[`integration/GENIE-INTEGRATION.md`](../integration/GENIE-INTEGRATION.md). In Phase 5 Genie can
switch to in-process: `import { run } from "@jellyclaw/engine"` and consume the async iterable
directly.

**jelly-claw desktop (Xcode/Swift).** A native sidecar: jellyclaw runs as a spawned Node process
inside the app bundle; the Swift side talks to it over a length-prefixed JSON-RPC stream on stdio.
The JSON shapes are `AgentEvent` exactly — Swift just decodes them into a matching `enum
AgentEvent: Codable`. See [`desktop/README.md`](../desktop/README.md) (Phase 4).

**Standalone CLI.** `./dist/cli.js run "…"` streams NDJSON to stdout. Useful for scripting,
piping, and CI usage where you want agent-backed actions without writing a Node host.

## 5. Extension points

**Plugins** (`plugin API`). Can register tools, intercept tool calls, transform messages,
add new slash commands. Loaded at engine boot from `config.plugins[]` (Phase 3).

**MCP servers.** External processes speaking MCP over stdio. Declared in `config.mcp[]`. The
canonical way to extend the tool catalog without modifying jellyclaw.

**Custom agents.** YAML files describing a system prompt, model, tool allow-list, and optional
hooks. Loaded from `config.agents[]` and chosen either by explicit `--agent` or by the classifier.

**Skills.** YAML+Markdown packages that inject focused guidance + example traces into the prompt
on demand. Loaded from `config.skillsDir` and selected by the skill loader based on wish content.

**Custom providers.** Implementing a new `Provider` is a matter of adhering to the narrow
interface in `engine/src/providers/*.ts`. Phase 6 lands a pluggable provider registry so
non-first-party providers can be registered without editing engine core.

## 6. What is _not_ here (yet)

Tracked honestly in [`../STATUS.md`](../STATUS.md). As of April 2026:

- **No process sandbox.** Tool execution runs with the parent process's privileges. Consumers
  (Genie's docker exec, jelly-claw's App Sandbox) provide outer isolation; jellyclaw enforces
  per-tool permissions + hook deny-wins inside that boundary.
- **No golden-prompt regression harness in CI yet.** Phase 11 lands 5 frozen prompts asserting
  byte-parity with Claude Code's `stream-json`.
- **No observability export.** OTLP tracing + per-tool latency ships in Phase 14.
- **No desktop app.** Tauri 2 MVP is Phase 15–16.
- **No voice triggers.** jelly-claw in-call integration is Phase 17.

What _is_ here and done: phases 00–10.5 (scaffolding, the runtime pin, providers, event stream,
11 tools at parity, skills, subagents + hook patch, MCP with 3 transports, permissions + 10
hook event kinds, session resume, CLI + HTTP + library, Ink TUI). Fill gaps by following the
phase sequence — don't drag Phase 14 work into Phase 11.

## 7. Where code lives

```
engine/src/
  adapters/      the runtime event-bus → AgentEvent translator
  cli/           Commander shell (run, serve, tui, sessions, doctor, ...)
  server/        Hono HTTP app + SSE routes + bind safety + bearer auth
  tui/           Ink TUI (splash, transcript, input, slash commands, theme)
  providers/     Anthropic, OpenRouter, router, cache_control policy
  tools/         11 built-in tools + registry + parity fixtures
  mcp/           stdio, HTTP, SSE, OAuth, token store, namespacing
  permissions/   rule matcher, engine, prompt, audit sink
  hooks/         10-event runner, registry, audit log, config schema
  skills/        loader for .claude/skills/*.md
  subagents/     stub (Phase 06 — hook-inheritance patch lives in patches/)
  session/       better-sqlite3 persistence, resume, NDJSON trace
  stream/        emit, downgrade matrix, claude-stream-json writer
  config/        zod schema + loader + env merging
  logger.ts      pino with secret-redact list
  index.ts       public barrel
  cli.ts         argv entrypoint → dist/cli/main.js via engine/bin/jellyclaw
shared/src/
  events.ts      15-variant AgentEvent discriminated union (zod)
patches/         patch-package patches applied at postinstall
phases/          per-phase runbooks — authoritative for the build order
```

The engine is a single process. `jellyclaw serve` exposes the same core over HTTP.
`jellyclaw tui` spawns the server in-process on a random loopback port and points
the TUI at it — same event protocol, different transport.
