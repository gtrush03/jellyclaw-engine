---
phase: 03
name: "Event stream adapter"
duration: "2 days"
depends_on: [01, 02]
blocks: [09, 10, 11, 12]
---

# Phase 03 — Event stream adapter

## Dream outcome

`jellyclaw run "hello" --output-format stream-json` emits newline-delimited JSON events that a Genie dispatcher written for Claurst parses without modification, and that additionally carries richer data (tool inputs, cache tokens, subagent hierarchy) in well-typed fields. A single TypeScript discriminated union describes all 15 events, shared between engine and desktop via the `@jellyclaw/shared` package.

## Deliverables

- `shared/src/events.ts` — 15-variant discriminated union + Zod schemas
- `engine/src/stream/adapter.ts` — translator from OpenCode SSE → jellyclaw events
- `engine/src/stream/emit.ts` — stream-json writer (Claude Code superset + Claurst minimal)
- `engine/src/stream/adapter.test.ts` — golden tests
- `test/golden/*.jsonl` — recorded streams
- `docs/event-stream.md` — spec + event table

## Step-by-step

### Step 1 — Enumerate events
Define 15 events:
1. `system.init` — session id, cwd, model, tools list
2. `system.config` — effective config snapshot (redacted keys)
3. `user` — user message
4. `assistant.delta` — streaming text chunk
5. `assistant.message` — final assistant message (with usage)
6. `tool.call.start` — tool name, input, id, subagent path
7. `tool.call.delta` — streaming tool progress (optional)
8. `tool.call.end` — result, error, duration
9. `subagent.start` — agent name, parent id, allowed tools
10. `subagent.end` — summary, usage
11. `hook.fire` — event, decision, stdout, stderr
12. `permission.request` — tool, rule matched, action
13. `session.update` — todos/memory changes
14. `cost.tick` — rolling token + $ ledger
15. `result` — final status (success|error|cancelled|max_turns), stats

### Step 2 — Shared types
`shared/src/events.ts`:
```ts
import { z } from "zod";
export const Usage = z.object({
  input_tokens: z.number(), output_tokens: z.number(),
  cache_creation_input_tokens: z.number().default(0),
  cache_read_input_tokens: z.number().default(0),
  cost_usd: z.number().default(0)
});
export const Event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("system.init"), session_id: z.string(), cwd: z.string(), model: z.string(), tools: z.array(z.string()), ts: z.number() }),
  // ... 14 more
]);
export type Event = z.infer<typeof Event>;
```
Export from `shared/src/index.ts`.

### Step 3 — OpenCode → jellyclaw mapping table
Document in `docs/event-stream.md`:
| OpenCode event | jellyclaw event | notes |
|---|---|---|
| `message.part.updated` (text) | `assistant.delta` | passthrough content |
| `message.part.updated` (tool-use) | `tool.call.start` or `tool.call.delta` | dedupe by id |
| `tool.call.start` | `tool.call.start` | |
| `tool.call.end` | `tool.call.end` | |
| `session.updated` | `session.update` | |
| `hook.fire` (from patch) | `hook.fire` | |

### Step 4 — Adapter
`engine/src/stream/adapter.ts` subscribes to OpenCode SDK event stream, buffers partial tool-use blocks, emits jellyclaw events. Handle ordering: `tool.call.end` must never arrive before `tool.call.start` even if OpenCode reorders.

### Step 5 — stream-json emitter
`engine/src/stream/emit.ts`:
- `writeLine(event)` — `process.stdout.write(JSON.stringify(event) + "\n")`
- When output format is `claude-code-compat`, map the superset down to Claude Code's 4-event model (`system.init`, `user`, `assistant`, `result`).
- When output format is `claurst-min`, map down further (text-only deltas).

### Step 6 — Golden tests
Record a real session against a live OpenCode server (Phase 01 bootstrap), save as `test/golden/hello.jsonl`. Replay through adapter, assert byte-equality of output (after redacting timestamps + ids via normalizer).

### Step 7 — Backpressure
Use Node streams; emitter respects `stdout.write` returning `false` → awaits `drain`. Add test that writes 10k events with a slow consumer.

## Acceptance criteria

- [ ] All 15 events defined + Zod-validated
- [ ] Adapter never emits `tool.call.end` before matching `start`
- [ ] Golden tests pass byte-for-byte after normalization
- [ ] `--output-format claude-code-compat` produces a stream Claurst dispatcher consumes unchanged
- [ ] Backpressure test: no dropped events, no memory blow-up

## Risks + mitigations

- **OpenCode event schema shifts** → pin SDK version; Zod-parse at the boundary; fail loud on unknown fields in dev, tolerate in prod.
- **Event reordering from parallel tools** → adapter buffers by `tool_use_id` until both `start` + `end` are safe to emit.

## Dependencies to install

```
zod@^3.23
eventsource-parser@^3
```

## Files touched

- `shared/src/events.ts`, `shared/src/index.ts`
- `engine/src/stream/{adapter,emit,adapter.test}.ts`
- `test/golden/*.jsonl`
- `docs/event-stream.md`
