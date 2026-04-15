# Phase 03 — Event stream adapter — Prompt 02: Implement adapter

**When to run:** After Phase 03 Prompt 01 (`01-research-and-types.md`) is committed.
**Estimated duration:** 5-7 hours
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `03`
- `<phase-name>` → `Event stream adapter`
- `<sub-prompt>` → `02-implement-adapter`
<!-- END SESSION STARTUP -->

## Task

Implement `engine/src/adapters/opencode-events.ts` — the translator that consumes OpenCode's `GET /event` SSE stream and yields jellyclaw's 15 typed events. Implement the stream-json emitter (`engine/src/stream/emit.ts`) supporting the three output formats. Record golden streams and pass byte-equality tests under normalization. Close Phase 03 in `COMPLETION-LOG.md`.

### Context

Phase 03 Prompt 01 shipped `shared/src/events.ts` with the 15-variant discriminated union, the OpenCode→jellyclaw mapping table in `docs/event-stream.md`, and output-format downgrade rules. Phase 01 shipped `engine/src/bootstrap/opencode-server.ts` which gives us a live server for golden capture.

### Steps

1. Re-read `docs/event-stream.md` §3 (mapping) and §5 (ordering invariants) before writing code.
2. Author `engine/src/adapters/opencode-events.ts`:
   - Signature: `createAdapter({ sessionId, url, token, clock }): AsyncIterable<Event>` yielding typed jellyclaw events.
   - Use `eventsource-parser` to parse the SSE stream from `GET ${url}/event` with `Authorization: Bearer ${token}`.
   - Maintain per-`tool_use_id` buffers. Only emit `tool.call.start` once all required fields (name, input schema validated) are present. Queue `tool.call.end` until its matching `start` has been emitted — if `end` arrives first, hold it; if `start` never arrives (upstream bug), emit both within a timeout (2s default, configurable) with a `stream.ordering_violation` log.
   - Coalesce streaming tool-input JSON into `tool.call.delta` events with `partial_json` payloads.
   - Propagate subagent context: maintain a stack; every event inside a subagent gets `subagent_path: string[]` populated from the stack.
   - Inject synthetic events where OpenCode emits nothing:
     - `system.init` at the start, from `GET /config` + the active session metadata.
     - `cost.tick` every N tool-call-ends (default 5) summarizing usage.
     - `result` at the end when the upstream `session.completed` (or equivalent) fires.
   - All timestamps come from the injected `clock()`, never `Date.now()` directly.
   - On upstream parse error: log and skip the offending line, do not crash the stream. Emit `hook.fire` with `decision: "adapter.drop"` for visibility.
3. Author `engine/src/stream/emit.ts`:
   - `writeEvent(stream: NodeJS.WritableStream, event: Event): Promise<void>` — `JSON.stringify + "\n"`, awaits `drain` if `write` returns false.
   - `downgrade(event: Event, format: "jellyclaw-full" | "claude-code-compat" | "claurst-min"): Event | null` — returns null to drop, or a translated event per the matrix in `docs/event-stream.md` §4.
   - `claude-code-compat` specifically: `assistant.delta` events are accumulated in a coalescer that emits a single `assistant.message` at the matching `message_stop`. Tool events dropped. Cost ticks dropped. Hook events dropped.
   - `claurst-min`: pass through `assistant.delta` and `result` only, rewriting `assistant.delta` into Claurst's minimal shape (`{ type: "text", value }`).
4. Author `engine/src/adapters/opencode-events.test.ts`:
   - Feed a synthetic SSE stream (hand-written JSONL of OpenCode-shaped events) through the adapter, assert the output is exactly the expected jellyclaw-shaped events (after ts normalization).
   - Ordering: inject `tool.call.end` before `tool.call.start` — adapter delays the `end` until after `start`. Assert output order.
   - Backpressure: emit 10,000 events through a slow consumer that awaits 1ms between writes. No memory blow-up (≤50MB RSS), no dropped events.
   - Parse-error tolerance: inject a malformed JSON line. Adapter skips it, stream continues, `hook.fire` emitted.
   - Subagent nesting: a 3-level nested Task dispatch correctly populates `subagent_path: ["root", "grep-helper", "diff-helper"]` on the innermost tool call.
5. Capture golden streams. Launch OpenCode via `engine/src/bootstrap/opencode-server.ts`, dispatch a real prompt ("list files in cwd"), collect both the raw OpenCode `/event` output AND the adapter's output. Save to `test/golden/hello.opencode.jsonl` and `test/golden/hello.jellyclaw.jsonl`. Add a golden test that replays the OpenCode side through the adapter and asserts byte equality with the jellyclaw side (after redacting `ts`, `session_id`, `tool_use_id` via a normalizer).
6. Author `engine/src/stream/emit.test.ts`:
   - Each of the 3 formats: given a canned input stream, assert the output exactly matches a fixture.
   - `claude-code-compat` coalescing: 5 deltas followed by a `message_stop` → one `assistant.message` with concatenated text.
   - Backpressure: slow consumer, 1000 events, no drops.
7. Run `bun run --filter @jellyclaw/engine test`. All green.
8. Smoke CLI call: add a temporary `engine/scratch/emit-hello.ts` that boots OpenCode, wires adapter + emit, dispatches "hello", prints NDJSON to stdout. Manually verify the output shape. Delete the scratch file or gitignore it.
9. Update `COMPLETION-LOG.md`. Mark Phase 03 ✅.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/adapters/opencode-events.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/adapters/opencode-events.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/stream/emit.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/stream/emit.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/golden/hello.opencode.jsonl`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/golden/hello.jellyclaw.jsonl`
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — Phase 03 ✅.

### Verification

- `bun run --filter @jellyclaw/engine test` exits 0.
- Golden replay test passes byte-for-byte after normalization.
- Ordering invariant test proves `tool.call.end` is held behind a late `start`.
- Backpressure test reports no drops and RSS growth under 50MB.
- The 3 output formats each produce distinct, correct outputs on the same canned input.
- Adapter is resilient to one malformed SSE line without crashing the whole stream.
- `grep -n "new Date" engine/src/adapters engine/src/stream` returns no matches (clock injection used everywhere).

### Common pitfalls

- **Emitting `tool.call.end` before `start` under concurrency.** The per-`tool_use_id` buffer must hold ends until the matching start has flushed. Do not assume upstream order.
- **Starving the event loop on high throughput.** Use `async`/`await` on the writable stream's `drain`, and yield via `await setImmediate()` every N events if you do any synchronous batching.
- **Sync `writeEvent`.** `stdout.write()` can return false; you must await `drain`. A synchronous loop corrupts under backpressure.
- **Leaking event-source connections.** On abort / stream end, close the `fetch` reader and the parser explicitly. Test with `AbortController`.
- **Normalizing too aggressively.** The golden normalizer must only redact timestamp + session_id + tool_use_id; it must not smooth over real content differences. Assert this by mutating the golden and watching the test fail.
- **`claude-code-compat` dropping `result`.** Claude Code DOES emit `result`. Keep it.
- **`claurst-min` emitting tool events.** Claurst's minimal mode only deals with text. Drop everything else.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `03`
- `<phase-name>` → `Event stream adapter`
- `<sub-prompt>` → `02-implement-adapter`
- Mark Phase 03 as ✅ Complete in `COMPLETION-LOG.md`.
<!-- END SESSION CLOSEOUT -->
