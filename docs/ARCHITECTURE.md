# jellyclaw — Architecture

This document describes how jellyclaw is put together: the layers, the components inside each
layer, how data flows through the system, where consumers hook in, and where extension authors
plug new behavior. Read this alongside [`engine/SPEC.md`](../engine/SPEC.md), which is the
authoritative description of _what_ the engine does; this document describes _how_.

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
│                   OpenCode (pinned, patched)                            │
│     HTTP server · @opencode-ai/sdk · @opencode-ai/plugin                │
└─────────────────────────────────────────────────────────────────────────┘
```

The engine core is a single process. OpenCode can run embedded (same process) or out-of-process
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
3. **Plugin tools** registered through `@opencode-ai/plugin` at engine boot.

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

**Plugins** (`@opencode-ai/plugin`). Can register tools, intercept tool calls, transform messages,
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

- No sandbox. Tool execution runs with the parent process's privileges. Until Phase 4, the
  consumer's own sandboxing (Genie's docker exec, jelly-claw's App Sandbox) is what keeps things
  safe.
- No authn/authz on the OpenCode HTTP server beyond `OPENCODE_SERVER_PASSWORD`. Phase 2 tightens
  this.
- No streaming cancellation protocol for tools already in flight. Phase 3.
- No persistent session resume across process restarts. Phase 5.

These are known gaps, tracked in the phase docs. Don't fill them silently — follow the phase
sequence.
