# Phase 10 — CLI + HTTP + library — Prompt 03: Library API (`@jellyclaw/engine` exports)

**When to run:** After Phase 10 prompts 01 + 02 are both ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 3–4 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if 10.01 or 10.02 not ✅. -->
<!-- END paste -->

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-10-cli-http.md` — Library API section.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` — the "library-mode entrypoint for jelly-claw integration" note (§2 goal #5, §21 integration plan).
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/integration/GENIE-INTEGRATION.md` — Genie imports `@jellyclaw/engine` in Phase 12; the API shape here must survive that migration unchanged.
4. Re-read prompt 10.01 (`cli/main.ts`) and 10.02 (`server/app.ts`) — both entry points consume the same `Engine` class. The library exports THAT class + a handful of loaders. Don't duplicate.
5. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/CLAUDE.md` §"Coding conventions" item 9 — "One public export per module where practical. Barrel re-exports live in `engine/src/index.ts`."
6. Skim prior phases' barrel files (`engine/src/skills/index.ts`, `engine/src/agents/index.ts`, `engine/src/mcp/index.ts`, `engine/src/session/index.ts`, `engine/src/permissions/index.ts`, `engine/src/hooks/index.ts`) — the public API is composed from these.

## Implementation task

Publish a stable library API at `engine/src/index.ts` exported as `@jellyclaw/engine`. The API is thin — all three entry points (CLI, HTTP, library) share one `Engine` class; this prompt wraps + documents it, adds a `createEngine()` factory, and finalizes TypeScript declaration emission so consumers get type safety out of the box. Mark Phase 10 ✅.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/engine.ts` — if not already the canonical `Engine` class, promote it here. Expose: `constructor(options)`, `run(input): AsyncIterable<EngineEvent>`, `runStream(input): ReadableStream<EngineEvent>` (web-streams adapter), `steer(text)`, `cancel()`, `resume(sessionId)`, `dispose()`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/index.ts` — barrel: `createEngine`, `Engine`, `loadConfig`, `EngineEvent`, `EngineOptions`, `Skill`, `Agent`, `McpTool`, `PermissionMode`, `HookEvent`, `SessionSummary`. Type-only exports use `export type`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/create-engine.ts` — `createEngine(options: Partial<EngineOptions>): Promise<Engine>` that resolves config defaults, boots OpenCode server, wires all subsystems (providers, skills, agents, MCP, permissions, hooks, session store), and returns a ready-to-use `Engine`. Symmetric `dispose()` tears everything down.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/public-types.ts` — re-export aliases for every type a library consumer should see; prevents internal type leakage (e.g., don't force consumers to import from `engine/src/events/types.ts` — that's internal).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/package.json` — set `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, `"exports"` map for ESM + CJS if both are built, `"sideEffects": false`, `"files": ["dist", "bin", "patches"]`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/tsconfig.build.json` — ensure `declaration: true`, `declarationMap: true`, `composite: false`, `emitDeclarationOnly: false`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/tsup.config.ts` — (if using tsup per CLAUDE.md) emit both ESM and `.d.ts`. Bundle externals: do NOT bundle `opencode-ai`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `better-sqlite3` — they stay external.
- `/Users/gtrush/Downloads/jellyclaw-engine/test/library/{basic,stream,cancel,resume,dispose}.test.ts` — spin up the library from a test-isolated consumer workspace to prove it actually works as an external import.
- `/Users/gtrush/Downloads/jellyclaw-engine/test/library/consumer/package.json` + `test/library/consumer/main.ts` — minimal workspace that depends on `@jellyclaw/engine` via workspace protocol, imports `createEngine`, runs one turn.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/library.md` — consumer-facing quickstart.
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — mark Phase 10 ✅.
- `/Users/gtrush/Downloads/jellyclaw-engine/STATUS.md` — note Phase 10 complete; next is Phase 11 (testing harness).

### Public API surface (exact)

```ts
// @jellyclaw/engine

export { createEngine } from "./create-engine.js";
export { Engine } from "./engine.js";
export { loadConfig } from "./config/loader.js";

// Types (consumer-facing only)
export type {
  EngineOptions,
  EngineEvent,        // discriminated union: message_start, text_delta, tool_use, tool_result, message_stop, session_update, permission_ask, etc.
  RunInput,           // { prompt?, sessionId?, wishId?, ... }
  RunHandle,          // the object returned by engine.run() — has iterator + cancel() + id
  PermissionMode,
  HookEvent,
  SessionSummary,
  Skill,
  Agent,
  McpTool,
} from "./public-types.js";

// Nothing else. Internal modules stay internal.
```

Consumers must be able to do:

```ts
import { createEngine } from "@jellyclaw/engine";
const engine = await createEngine({ config: { provider: "anthropic", model: "claude-sonnet-4-6" } });
for await (const ev of engine.run({ prompt: "hello" })) {
  console.log(ev);
}
await engine.dispose();
```

### `createEngine()` contract

1. Merge `options` over defaults over `loadConfig()` over env.
2. Validate with Zod. On failure → throw typed `ConfigInvalidError`.
3. Boot an OpenCode server bound to `127.0.0.1:<random port>` with a fresh `OPENCODE_SERVER_PASSWORD`.
4. Load skills, agents, MCP servers, permission rules, hook configs.
5. Open the SQLite session store (Phase 09.01).
6. Return a constructed `Engine` instance with `dispose()` that shuts everything down in reverse order.

Failures at any step must: (a) not leak zombie children (kill spawned server), (b) not leave the SQLite WAL mid-checkpoint, (c) throw a typed error the caller can pattern-match on.

### `Engine` methods

- `run(input: RunInput): RunHandle` — starts a run; returns handle that is `AsyncIterable<EngineEvent>` AND has `cancel(): void`, `id: string`, `sessionId: string`, `resume(prompt): RunHandle` (convenience).
- `runStream(input: RunInput): ReadableStream<EngineEvent>` — web-streams variant; for environments that prefer streams over async iterators (Tauri's IPC prefers streams).
- `steer(runId: string, text: string): Promise<void>` — mid-turn user injection (10.02 already consumes this).
- `cancel(runId: string): Promise<void>` — signals abort.
- `resume(sessionId: string): RunHandle` — rehydrate + start a new turn.
- `continueLatest(): RunHandle` — per-project newest session.
- `dispose(): Promise<void>` — idempotent.

### Consumer workspace test

Prove the package works from the outside. At `test/library/consumer/`:

```json
// package.json
{
  "name": "jellyclaw-consumer-smoke",
  "type": "module",
  "private": true,
  "dependencies": { "@jellyclaw/engine": "workspace:*" }
}
```

```ts
// main.ts
import { createEngine } from "@jellyclaw/engine";
const engine = await createEngine({ config: { provider: "anthropic", model: "claude-haiku-4-6" } });
let ticks = 0;
for await (const ev of engine.run({ prompt: "say 'ok'" })) {
  ticks++;
  if (ticks > 200) throw new Error("runaway");
}
await engine.dispose();
console.log("consumer OK");
```

The library test spawns this workspace, runs `bun run main.ts` against a mocked provider, asserts exit 0.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run build
# Verify the declaration output
ls engine/dist/*.d.ts
# Run library-consumer test
bun run test test/library
bun run lint
```

### Expected output

- `engine/dist/index.js` + `engine/dist/index.d.ts` exist.
- A consumer workspace can `import { createEngine } from "@jellyclaw/engine"` and the TS types resolve without `any`.
- All library tests pass (basic run, streaming, cancel mid-turn, resume, dispose).
- `docs/library.md` has a complete copy-paste quickstart + API reference.

### Tests to add

- `test/library/basic.test.ts`:
  - `createEngine()` with minimal options succeeds.
  - `engine.run({ prompt: "x" })` produces at least a `message_start` + `message_stop`.
  - `engine.dispose()` is idempotent (calling twice is a no-op).
- `test/library/stream.test.ts`:
  - `runStream()` returns a `ReadableStream`; reader receives events; close works.
- `test/library/cancel.test.ts`:
  - Mid-run `cancel()` terminates the iterator; final event is a `message_stop` with `reason: "cancelled"`.
- `test/library/resume.test.ts`:
  - Run 2 turns, dispose, re-createEngine, `resume(sessionId)` + 3rd turn; messages preserved.
- `test/library/dispose.test.ts`:
  - After dispose, `run()` throws `EngineDisposedError`.
  - Child processes (OpenCode server, MCP children) are all killed.
  - SQLite WAL checkpointed (no leftover `-wal` bytes beyond a sane threshold).
- `test/library/consumer.test.ts`:
  - Spawn the `test/library/consumer/` workspace with `bun run main.ts`; assert exit 0 and `"consumer OK"` in stdout.
- `test/library/types.test.ts`:
  - TypeScript compile-only test (`tsc --noEmit`) against a fixture consumer that imports every public type; asserts no `any` escapes.

### Verification

```bash
bun run build
ls engine/dist/ | grep -E "(index\.js|index\.d\.ts)$"        # expect: both present
bun run test test/library                                    # expect: green
bun run typecheck                                            # expect: clean
bun run lint                                                 # expect: clean

# External consumer sanity
cd test/library/consumer
bun install                                                  # resolves workspace protocol
bun run main.ts                                              # expect: "consumer OK"

# Ensure no internal modules are accidentally exported
grep -E "^export " engine/src/index.ts | wc -l               # expect: small, ~15
```

### Common pitfalls

- **Exporting internal types.** If a consumer needs to import from `engine/src/events/types.ts`, the barrel is wrong. Add the type to `public-types.ts` and re-export from `index.ts`.
- **`@jellyclaw/engine` bundling OpenCode.** `opencode-ai` must stay external. Check `engine/dist/index.js` does NOT contain `"opencode-ai"` source — only a `require`/`import` reference.
- **`better-sqlite3` bundling.** Native module; MUST stay external. Otherwise consumers get `dlopen` errors.
- **Missing `.d.ts`.** Consumers see `any` everywhere. `declaration: true` + `tsup`'s `dts: true` (if used) are load-bearing.
- **`dispose()` not idempotent.** The second call should no-op, not throw. Test this.
- **Forgetting `sideEffects: false`.** Breaks tree-shaking for consumers bundling for web.
- **Web-streams API availability.** `ReadableStream` is global in Node ≥18. Don't import from `stream/web` in the public surface — use the global to keep consumer code portable.
- **Leaking the `OPENCODE_SERVER_PASSWORD` via `EngineOptions`.** If a consumer reads `engine.options`, the password should NOT be there. Store it in a private field.
- **Consumer test hitting the real provider.** Use the mock provider that every other phase uses. Document in `docs/library.md` how to inject a custom provider for tests.
- **`RunHandle` returning `null` on `sessionId` before the first event.** Resolve the sessionId synchronously at `run()` call time (the session is created BEFORE the first model call). Consumers need the id immediately to subscribe elsewhere.
- **Phase marked ✅ before the consumer smoke test lands.** That test is the load-bearing proof that the library works outside the repo. Do not skip.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: Phase 10 fully ✅ in COMPLETION-LOG.md; update STATUS.md; next prompt = prompts/phase-11/01-<name>.md. Bump the "X/20 phases complete" counter. -->
<!-- END paste -->

**Note:** This is the FINAL prompt in Phase 10 — flip the phase to ✅ in COMPLETION-LOG.md and bump the progress counter.
