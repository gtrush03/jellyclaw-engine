# Library API reference

`@jellyclaw/engine` is the npm package you reach for when you want to embed
the jellyclaw engine directly in your own Node or Bun process — no CLI
subprocess, no HTTP server, no SSE parser. You `import { createEngine }`,
construct one engine, and drive it through a small typed surface.

This document is the stable reference for the library entry point: every
export from `engine/src/index.ts`, the errors they throw, the config
resolution order, and the semantic guarantees that Genie (Phase 12) and the
jelly-claw macOS bridge depend on. Engineering details live in
[`phases/PHASE-10-cli-http.md`](../phases/PHASE-10-cli-http.md); the event
envelope lives in [`docs/event-stream.md`](event-stream.md).

> **Status.** Phase 10.03 — this is pre-alpha. The library surface is
> deliberately small but the engine loop behind it is the Phase-0 echo stub
> (see [Known limitations](#known-limitations)). Every type on this page
> ships from the frozen contract in
> [`engine/src/public-types.ts`](../engine/src/public-types.ts); breaking
> changes require a major version bump.

## Overview

Three ways to use jellyclaw, one engine behind all of them:

| Surface    | When to reach for it                                                   |
|------------|------------------------------------------------------------------------|
| CLI        | Shell scripts, ad-hoc wishes, CI pipelines. See [`docs/cli.md`](cli.md). |
| HTTP       | Multi-process setups, long-lived daemons, Genie via LaunchAgent. See [`docs/http-api.md`](http-api.md). |
| **Library**| Embedded use — Electron/Tauri apps, test harnesses, one-shot programs that want typed events and no shell-out. |

The library API is intentionally a **superset** of the CLI surface: every
flag you can pass to `jellyclaw run` maps to a field on `RunInput`, and the
events you see streamed from the CLI are the same `EngineEvent` values you
iterate over here. Genie's Phase 12 migration is a straightforward
subprocess-to-library swap — see
[§ Genie Phase-12 migration path](#genie-phase-12-migration-path).

## Install

```bash
bun add @jellyclaw/engine
```

```bash
npm install @jellyclaw/engine
```

The package is published as pure ESM with bundled `.d.ts` files. `package.json`
declares `"type": "module"`, `"exports"`, and `"types"`; consumers in
TypeScript get full type inference without a `tsconfig.paths` entry.

> **Pre-alpha:** pin an exact version. Minor bumps may break until 1.0. See
> [Version compatibility](#version-compatibility).

## Quickstart

```ts
import { createEngine } from "@jellyclaw/engine";

const engine = await createEngine({
  config: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
  },
});

for await (const ev of engine.run({ prompt: "Say hi." })) {
  if (ev.type === "agent.message") process.stdout.write(ev.delta);
  if (ev.type === "session.completed") break;
}

await engine.dispose();
```

That's the whole life cycle: construct, iterate events, dispose.

- `ANTHROPIC_API_KEY` comes from the environment.
- The `Engine` owns the OpenCode handle, the provider, the run manager,
  and the session store. Call `dispose()` before your process exits.
- The `for await` loop yields `EngineEvent` values (see
  [`docs/event-stream.md`](event-stream.md) for the 15-variant union).

## API reference

Every export below comes from `@jellyclaw/engine`'s root (re-exported in
`engine/src/index.ts`). Deep imports into `engine/src/**` are not covered by
the semver contract and will break silently.

### `createEngine(options)`

```ts
function createEngine(options?: EngineOptions): Promise<Engine>;
```

Constructs an `Engine`. Async because config may be loaded from disk, the
OpenCode server must be started, and MCP children must connect. Typical
startup is ~60ms when MCP is empty.

**Options:**

| Field              | Type                               | Default          | Notes |
|--------------------|------------------------------------|------------------|-------|
| `config`           | `Partial<EngineOptionsConfig>`     | _(none)_         | Inline config. Highest priority in the resolution order. |
| `configPath`       | `string`                           | _(none)_         | Path to a `jellyclaw.json`. Overridden by `config`. |
| `cwd`              | `string`                           | `process.cwd()`  | Working directory; affects session project hash, skill discovery, and tool sandboxing. |
| `logger`           | pino-compatible `Logger`           | internal pino    | Duck-typed on `.info` / `.warn` / `.error`. See [Logger](#createloggeropts). |
| `providerOverride` | provider object                    | _(none)_         | Test hook — skips real provider construction. See [Provider override for testing](#provider-override-for-testing). |

**Returns:** `Promise<Engine>`.

**Throws:**

- `ConfigInvalidError` — config failed zod validation at the loader boundary.
- Any error thrown by the OpenCode bootstrap (`OpenCodeStartTimeoutError`,
  `OpenCodeVersionError`, `BindViolationError`) if the embedded server
  refuses to start.

### `Engine`

The object returned by `createEngine()`. All methods are instance methods;
state lives on the object. Multi-engine in one process is supported —
engines do not share state.

| Method                           | Signature                                                | Notes |
|----------------------------------|----------------------------------------------------------|-------|
| `run(input)`                     | `(input: RunInput) => RunHandle`                         | **Synchronous.** `.id` and `.sessionId` are available immediately. |
| `runStream(input)`               | `(input: RunInput) => ReadableStream<EngineEvent>`       | Web-standard surface. See [Streams vs async iterators](#streams-vs-async-iterators). |
| `steer(runId, text)`             | `(runId: string, text: string) => void`                  | Inject a mid-run user turn. Queued; Phase 10.03 wires the producer — the consumer lands in Phase 11+. |
| `cancel(runId)`                  | `(runId: string) => void`                                | Cancel a run by id. Throws `RunNotFoundError` if unknown. |
| `resume(sessionId)`              | `(sessionId: string) => RunHandle`                       | Resume an existing session. Same project hash required. |
| `continueLatest()`               | `() => RunHandle`                                        | Resume the newest session for the current `cwd`. Throws `NoSessionsForProjectError` when none exist. |
| `dispose()`                      | `() => Promise<void>`                                    | Idempotent shutdown. See [Disposal semantics](#disposal-semantics). |

**Synchronous sessionId contract.** `run()` and `resume()` return a
`RunHandle` whose `.id` and `.sessionId` resolve at call time. You can log
them, wire them to telemetry, or subscribe to SSE for the same session
through a parallel channel before the first `await`:

```ts
const handle = engine.run({ prompt: "hi" });
console.log({ runId: handle.id, sessionId: handle.sessionId });
// ...then iterate:
for await (const ev of handle) { /* ... */ }
```

The run does not start until the iterator is pulled or `runStream()` is
attached. This is deliberate: it lets consumers capture identifiers
cheaply, attach side-channel subscribers, and only then commit to the
run.

### `loadConfig(path?)`

```ts
function loadConfig(path?: string): Promise<EngineConfig>;
```

Reads and validates a `jellyclaw.json`. Passes through zod, returns the
fully-typed `EngineConfig`. When `path` is omitted, searches in order:

1. `./jellyclaw.json` in `process.cwd()`.
2. `~/.jellyclaw/config.json`.

Returns the built-in `defaultConfig()` when neither exists. Throws
`ConfigInvalidError` on a zod failure with the issue list attached.

### `createLogger(opts)`

```ts
function createLogger(opts?: { level?: string; pretty?: boolean }): Logger;
```

Constructs the engine's internal pino logger with the standard redaction
list (see [`engine/src/logger.ts`](../engine/src/logger.ts)). Consumers
that want a unified logger across their app should create one here and
pass it into `createEngine({ logger })`.

The returned object is a pino `Logger` — use the `.info(obj, msg)` /
`.warn(obj, msg)` / `.error(obj, msg)` methods. Library consumers embedding
a different logger (bunyan, winston) should construct a minimal adapter
that exposes the same three methods; the engine only calls those three.

### Types

All types are re-exported from the package root. Import them type-only.

```ts
import type {
  EngineEvent,        // AgentEvent — the 15-variant discriminated union
  EngineEventKind,    // "session.started" | "agent.message" | ... (string union)
  EngineOptions,      // options for createEngine
  EngineOptionsConfig,// the subset of EngineConfig that inlines in options.config
  RunInput,           // the argument to engine.run()
  RunHandle,          // the return value of engine.run() / engine.resume()
  EngineConfig,       // full, validated config shape
  ProviderConfig,
  ProviderName,
  AnthropicProviderConfig,
  OpenRouterProviderConfig,
  LoggerConfig,
  McpServerConfig,
  PermissionPolicy,
  PermissionMode,
  PermissionRule,
  PermissionDecision,
  HookEvent,          // HookEventKind from hooks/types.ts
  HookConfig,
  HookOutcome,
  HookRunResult,
  Skill,
  SkillSource,
  Agent,
  McpTool,
  SessionSummary,     // SessionMeta — what sessions list / continueLatest use
  CumulativeUsage,
  EngineState,
  ReplayedMessage,
  ReplayedToolCall,
  Usage,
} from "@jellyclaw/engine";
```

`EngineEvent` is the big one. See [`docs/event-stream.md`](event-stream.md)
for the full 15-variant union, field-by-field. The short version:

- **Lifecycle:** `session.started`, `session.completed`, `session.error`
- **Planning:** `agent.thinking`, `agent.message`
- **Tools:** `tool.called`, `tool.result`, `tool.error`
- **Permission:** `permission.requested`, `permission.granted`, `permission.denied`
- **Subagent:** `subagent.spawned`, `subagent.returned`
- **Runtime:** `usage.updated`, `stream.ping`

Narrow on `.type`:

```ts
for await (const ev of engine.run({ prompt })) {
  switch (ev.type) {
    case "agent.message":   process.stdout.write(ev.delta); break;
    case "tool.called":     logger.info({ tool: ev.tool_name }, "tool"); break;
    case "usage.updated":   costTracker.add(ev); break;
    case "session.completed": return;
  }
}
```

### Event naming: library types vs. wire protocol

The library's `EngineEvent.type` discriminants use a **dotted lowercase**
scheme (`session.started`, `agent.message`, `tool.called`, `usage.updated`,
…). That's the scheme `engine/src/events.ts` emits today, and it's what
every in-process library consumer sees.

A separate **snake_case wire protocol** (`system_init`, `text_delta`,
`tool_use_start`, `result`, …) is defined in
[`engine/SPEC.md` § 3 Invocation contract](../engine/SPEC.md#3-invocation-contract)
and [`integration/GENIE-INTEGRATION.md` § 2.6](../integration/GENIE-INTEGRATION.md)
for the NDJSON stream that the `jellyclaw` CLI writes to stdout and that
Genie's dispatcher parses. That protocol is the **bridge format** — it's
the shape a subprocess consumer sees over a pipe, not a library consumer
importing `EngineEvent`.

The two are not in conflict. The mapping from in-process `EngineEvent`
to on-the-wire frames is handled at the **CLI/bridge layer** (Phase 10.01
for the CLI, Phase 12 for Genie's library swap — at which point the wire
protocol becomes a Genie-bridge concern and falls away entirely for
direct library consumers). The library surface documented on this page
will not change shape when that happens; `EngineEvent.type` values stay
dotted and the 15-variant union stays intact. If you're embedding
`@jellyclaw/engine` directly, pattern-match on the dotted strings above
and ignore the wire protocol.

## Error classes

All errors inherit from `Error`; each carries a stable `.name` discriminant
for `instanceof` pattern matching.

| Class                           | Thrown when                                                        |
|---------------------------------|--------------------------------------------------------------------|
| `EngineDisposedError`           | Any method is called after `dispose()` has resolved.               |
| `RunNotFoundError`              | `engine.cancel(id)` / `engine.steer(id, …)` given an unknown runId. |
| `NoSessionsForProjectError`     | `engine.continueLatest()` called in a cwd that has no sessions.    |
| `ConfigInvalidError`            | The zod validator on `loadConfig()` / inline `config` fails.       |

Pattern-match defensively:

```ts
import {
  createEngine,
  EngineDisposedError,
  NoSessionsForProjectError,
  RunNotFoundError,
} from "@jellyclaw/engine";

try {
  const handle = engine.continueLatest();
  for await (const ev of handle) { /* ... */ }
} catch (err) {
  if (err instanceof NoSessionsForProjectError) {
    // First run in this project — kick off a fresh one instead.
    return engine.run({ prompt: initialPrompt });
  }
  if (err instanceof EngineDisposedError) {
    throw new Error("caller bug: engine used after dispose");
  }
  throw err; // unknown — re-throw
}
```

Both `.name` and `instanceof` are stable. Prefer `instanceof`.

## Config resolution order

`createEngine()` resolves an effective `EngineConfig` in this order (first
non-empty source wins; zod validates the merged result at the end):

1. **`options.config`** — inline object passed at construction time. Highest
   priority. Partial shapes are allowed; missing fields fall through to the
   next source.
2. **`options.configPath`** — an explicit `jellyclaw.json` path.
3. **`loadConfig()`** — auto-discovery: `./jellyclaw.json` in `cwd`, then
   `~/.jellyclaw/config.json`.
4. **Env vars** — `JELLYCLAW_PROVIDER`, `JELLYCLAW_MODEL`, `JELLYCLAW_HOME`,
   `JELLYCLAW_LOG_LEVEL`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`. See
   [`docs/cli.md` § Environment variables](cli.md#environment-variables).
5. **`defaultConfig()`** — the built-in fallback. Anthropic provider,
   `claude-sonnet-4-6`, permissions `default`, no MCP, info-level logs.

Zod runs as the **final step** over the merged object. `ConfigInvalidError`
surfaces any violation with an `.issues` array suitable for pretty-printing.

## Streams vs async iterators

Two ways to consume events — pick based on your runtime:

| Surface                | Use when                                                  |
|------------------------|-----------------------------------------------------------|
| `engine.run()`         | Plain Node/Bun. `for await (const ev of handle)` is the canonical path. |
| `engine.runStream()`   | Web-standard contexts: Tauri IPC, service workers, Deno, browser-side testing. |

They are two views of the same underlying producer; choose one per run,
don't mix. The `RunHandle` returned by `run()` exposes `id` / `sessionId` /
`cancel()` / `resume()`; the `ReadableStream` returned by `runStream()` is
pure data. If you need both — e.g. you want the stream for Tauri IPC but
also want to call `cancel()` — grab the id via `run()` first and call
`engine.cancel(id)` from your control surface:

```ts
const handle = engine.run({ prompt });
const stream = engine.runStream({ prompt }); // wrong — starts a second run
```

Don't do that. Instead:

```ts
const handle = engine.run({ prompt });
const { id, sessionId } = handle;
// Forward the async-iterable through your own ReadableStream adapter, or
// use engine.cancel(id) from a side channel.
```

### Cancel propagation

Calling `reader.cancel()` on a stream obtained via `runStream()` cancels
the underlying run. The engine routes this through `engine.cancel(runId)`,
which in turn signals the run manager's `AbortController`. For the plain
`run()` / `for await` path, call `handle.cancel()` or break out of the loop
and let `AsyncIterator.return()` do the cleanup.

## Provider override for testing

`EngineOptions.providerOverride` skips real provider construction, which
means your tests don't need `ANTHROPIC_API_KEY`, don't hit the network,
and don't burn tokens. Pass a shape compatible with the engine's provider
interface:

```ts
import { createEngine } from "@jellyclaw/engine";
import type { EngineEvent } from "@jellyclaw/engine";

const mockProvider = {
  name: "mock",
  async *stream(): AsyncGenerator<EngineEvent, void, void> {
    yield {
      type: "agent.message",
      session_id: "test",
      seq: 0,
      ts: Date.now(),
      delta: "hello from the mock provider",
      final: true,
    };
  },
};

const engine = await createEngine({ providerOverride: mockProvider });

for await (const ev of engine.run({ prompt: "anything" })) {
  if (ev.type === "session.completed") break;
}

await engine.dispose();
```

The `providerOverride` field is typed `unknown` in the frozen contract so
the engine can accept a duck-typed shape without forcing consumers to
depend on the provider class surface. In Phase 11+ the engine-loop wires
through `.stream()`; until then the override is accepted but not exercised.

## Disposal semantics

`engine.dispose()` is **idempotent** — calling it twice is safe. The
effective shutdown sequence:

1. **Stop accepting new runs.** `run()` / `resume()` / `continueLatest()`
   reject with `EngineDisposedError`.
2. **Graceful run-manager shutdown.** Active runs get a 30s window to
   complete on their own. Anything still running after the deadline is
   aborted via the run-manager's `AbortController`.
3. **SQLite WAL checkpoint.** The session DB runs a `PRAGMA wal_checkpoint`
   so the on-disk file is consistent — readers attaching after dispose
   see the final state without replaying the WAL.
4. **MCP child kill.** Every MCP stdio/HTTP transport is closed. Stdio
   children get `SIGTERM`, then `SIGKILL` after 5s.
5. **OpenCode handle stop.** The embedded OpenCode server is shut down via
   its native `stop()` path.

Double-calling is safe because each step is guarded by a "already ran"
flag. The second `dispose()` returns the same resolved promise the first
call produced — no side effects, no errors.

For long-lived processes (a Tauri app, a server), wire `dispose()` to your
own shutdown handler:

```ts
process.once("SIGINT", async () => {
  await engine.dispose();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await engine.dispose();
  process.exit(0);
});
```

## Session persistence & resume

Every run appends an NDJSON event log to the session store — see
[`docs/sessions.md`](sessions.md) for the on-disk layout. To resume a prior
session across engine lifetimes:

```ts
// Turn 1.
const engine1 = await createEngine({ cwd: "/path/to/project" });
const h1 = engine1.run({ prompt: "start a refactor" });
const sessionId = h1.sessionId;
for await (const _ev of h1) { /* drain */ }
await engine1.dispose();

// …later, in a fresh process…

const engine2 = await createEngine({ cwd: "/path/to/project" });
const h2 = engine2.resume(sessionId);
for await (const ev of h2) {
  if (ev.type === "agent.message") process.stdout.write(ev.delta);
  if (ev.type === "session.completed") break;
}
await engine2.dispose();
```

Notes:

- `resume(sessionId)` does not require a prompt — the engine picks up where
  the previous turn ended. Pass `{ prompt }` via the returned handle's
  `.resume(prompt)` method to inject a new user turn.
- The resumed handle's `.sessionId` equals the passed sessionId; `.id` is
  a fresh run id (one run per turn).
- `continueLatest()` is the shorthand for "resume the newest session in
  this cwd" — most interactive tooling wants this.

## Permissions & hooks

Permissions and hooks are configured via `EngineOptions.config` and flow
through to the same engine the CLI uses. See
[`docs/permissions.md`](permissions.md) for the mode/rule grammar and
[`docs/hooks.md`](hooks.md) for the hook protocol.

```ts
const engine = await createEngine({
  config: {
    permissions: {
      mode: "acceptEdits",
      allow_tools: ["Bash(git status)", "Read(**)", "Edit(**)"],
      ask_tools: ["Bash(**)"],
      deny_tools: ["Bash(rm -rf *)"],
    },
    hooks: {
      PreToolUse: [{ matcher: "Bash", command: "~/.jellyclaw/hooks/pre-bash.sh" }],
      PostToolUse: [{ matcher: "Bash", command: "~/.jellyclaw/hooks/post-bash.sh" }],
    },
  },
});
```

Per-run overrides (e.g. a different permission mode for one wish) land on
`RunInput`:

```ts
engine.run({
  prompt: "deploy to staging",
  permissionMode: "bypassPermissions",
  allowedTools: ["Bash"],
  maxTurns: 8,
});
```

## Genie Phase-12 migration path

Genie's dispatcher currently spawns `claurst -p` (Phase 11) or `jellyclaw
run --print` (Phase 10.02, over HTTP). Phase 12 swaps the subprocess for
`import { createEngine } from "@jellyclaw/engine"` and calls `engine.run()`
directly.

The library surface is designed to make that swap mechanical:

- `RunInput` mirrors the `jellyclaw run` flag set one-to-one —
  `appendSystemPrompt`, `permissionMode`, `maxTurns`, `wishId`,
  `allowedTools` / `disallowedTools`, `addDirs`, `cwd` are all there.
- `EngineEvent` is the same 15-variant stream the dispatcher's event
  parser already consumes; the only change is replacing
  `JSON.parse(line)` with direct iteration over the `RunHandle`.
- `RunHandle.sessionId` is synchronous, so Genie can keep threading
  `sessionId` through its Telegram reports without waiting for the first
  event.
- `engine.resume(sessionId)` replaces Genie's current
  `--session-id <uuid>` argv wiring.

See [`integration/GENIE-INTEGRATION.md`](../integration/GENIE-INTEGRATION.md)
for the full per-line diff plan. The library-migration section of that
document (Phase 12 W1-W4) references this page as the API source of
truth.

## Version compatibility

Semver policy for `@jellyclaw/engine`:

- **Pre-1.0 (current).** Any minor bump may break the public API. Pin an
  exact version — `"@jellyclaw/engine": "0.1.3"`, not `"^0.1.0"`.
- **1.0 onward.** Breaking changes require a major bump. Every type on
  this page is part of the `public-types.ts` frozen contract, which
  means:
  - **Adding a field to `EngineOptions`** is non-breaking (consumers
    who don't know about the field keep working).
  - **Removing a field from `EngineOptions`** or **changing an existing
    field's type** is breaking.
  - **Adding an event variant to `EngineEvent`** is considered
    non-breaking at the type level (the discriminated union widens), but
    consumers that exhaustively switch on `.type` will get a TS error —
    treat as a minor bump with a migration note.
  - **Removing an event variant** is breaking.

The `@jellyclaw/engine` package does not pin consumers to an OpenCode
version — that's the engine's internal dependency.

## Known limitations

Phase 10.03 lands the library surface; the engine loop behind it is still
the Phase-0 echo stub. The surface documented on this page is stable,
but behavioural gaps remain:

- **Echo-style events.** `run()` emits the three-event canonical sequence
  (`session.started → agent.message → session.completed`) with a stub
  assistant delta of the form `[phase-0 stub] received wish: <prompt>`.
  Real tool calls, thinking blocks, subagent events, and provider-backed
  assistant text arrive with the engine-loop wiring in Phase 11+.
- **`steer()` is queued, not consumed.** You can call
  `engine.steer(runId, text)` and it will be accepted, but the echo loop
  never reads the queue. When the real loop lands in Phase 11+ the
  queued text will be injected as a mid-run user turn at the next
  opportunity, consistent with OpenCode's existing `UserPromptSubmit`
  hook semantics.
- **`providerOverride` is accepted but not exercised.** The type slot and
  DI plumbing are in place so library consumers can write tests today;
  the actual `.stream()` path through the override is wired in Phase
  11+. Tests that rely only on the echo loop work now.
- **`resume()` does not rehydrate provider context.** Phase 09.02 landed
  the JSONL replay and the reducer; the library resume path uses that
  machinery. What's missing is passing the replayed context back into
  the provider's `stream()` call — Phase 11+.
- **`runStream()` backpressure.** The `ReadableStream` adapter wraps the
  RunManager's ring buffer; slow consumers will eventually drop the
  oldest events in-flight rather than block the producer. Consumers
  that need lossless delivery should prefer the `for await` path on
  `run()` — its async-iterable applies natural backpressure via the
  pull queue.
- **Multi-engine in one process is supported, but not optimised.**
  Every engine opens its own SQLite file and its own MCP child set.
  Pooling lands later.

None of these limitations affect the type surface on this page — when
they're lifted, existing consumer code keeps compiling and running. The
types document the shape Genie's Phase-12 dispatcher will depend on;
the runtime catches up beneath them.
