# Phase 99 — Unfucking — Prompt 01: Provider→AgentEvent adapter

**When to run:** First prompt of Phase 99. Run before any other Unfucking prompt.
**Estimated duration:** ~90 minutes
**New session?** Yes — fresh Claude Code session
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
<!-- Use /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- Phase doc: /Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-99-unfucking.md -->
<!-- Working API key for live tests: <REDACTED_API_KEY> -->
<!-- END SESSION STARTUP -->

---

## Pre-flight verification (DO THIS FIRST)

Before writing any adapter code, run a throwaway script against the live API to confirm the chunk shapes match what this prompt specifies. The provider's internal cache breakpoint planner (`engine/src/providers/cache-breakpoints.ts`) may mangle your system prompt for tool-bearing requests — so run **two** tests:

### Test A — text-only via AnthropicProvider

```ts
// _preflight_a.ts
import { AnthropicProvider } from "./engine/src/providers/anthropic.ts";
import pino from "pino";
const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  logger: pino({ level: "silent" }) as any,
});
for await (const chunk of provider.stream({
  model: "claude-haiku-4-5-20251001",
  maxOutputTokens: 50,
  system: [{ type: "text", text: "Reply tersely." }],
  messages: [{ role: "user", content: "Say hi in 3 words." }],
})) {
  console.log(JSON.stringify(chunk));
}
```

Run: `ANTHROPIC_API_KEY=... bun run _preflight_a.ts`. You should see exactly these chunk types in order: `message_start`, `content_block_start`, `content_block_delta` (×N), `content_block_stop`, `message_delta`, `message_stop`. Delete the script when done.

### Test B — tool_use directly via SDK (bypasses cache planner)

The cache-breakpoint planner errors out on tools+system combos with `system.0.cache_control.ttl: a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block`. This is a known bug to file separately — for preflight, call the raw SDK:

```ts
// _preflight_b.ts
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 0 });
const stream = client.messages.stream({
  model: "claude-haiku-4-5-20251001",
  max_tokens: 200,
  system: "You MUST call get_weather when asked about weather.",
  messages: [{ role: "user", content: "What's the weather in Paris?" }],
  tools: [{
    name: "get_weather",
    description: "Get current weather.",
    input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  }],
});
for await (const chunk of stream) console.log(JSON.stringify(chunk));
```

Expected chunk sequence: `message_start`, `content_block_start` (type=tool_use), `content_block_delta` (input_json_delta, ×N), `content_block_stop`, `message_delta`, `message_stop`.

## Why this exists

`engine/src/providers/anthropic.ts:135` `stream()` works — it returns an async iterator of `ProviderChunk` (raw Anthropic SDK stream events). Nothing in the engine consumes them. `engine/src/legacy-run.ts` is a Phase-0 stub emitting fake `[phase-0 stub]` text. We need a pure, sync, table-tested function that translates `ProviderChunk` → `AgentEvent[]` so subsequent prompts can wire the agent loop.

## Files to read first

1. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/anthropic.ts` — see what `stream()` yields. Note retry/abort behavior at line 135, and the passthrough at line 186 (`yield event as unknown as ProviderChunk`).
2. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/providers/types.ts` — `ProviderChunk` is `{ readonly type: string; readonly [k: string]: unknown }` (line 46). The underlying shapes match `Anthropic.Messages.RawMessageStreamEvent`.
3. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/events.ts` — the canonical `AgentEvent` union (**15** variants — not 13; see below).
4. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/legacy-run.ts` — what the stub emits; note the seq counter pattern (lines 111-163) and `exactOptionalPropertyTypes` spread pattern (lines 107-108).
5. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/server/run-manager.ts` — read `RunManager.create()` and `BufferedEvent` (defined at `:52`, entry id at `:241`) to understand the seq vs id distinction.

### AgentEvent variants — EXACT names (from `events.ts`)

Use these literal strings — they are zod-validated. Typos will blow up at runtime:

- lifecycle: `session.started`, `session.completed`, `session.error`
- planning: `agent.thinking`, `agent.message`
- tools: `tool.called`, `tool.result`, `tool.error`
- permission: `permission.requested`, `permission.granted`, `permission.denied`
- subagent: `subagent.spawned`, `subagent.returned`
- runtime: `usage.updated`, `stream.ping`

Every event envelope requires `session_id`, `ts` (unix ms), `seq` (monotonic per session, int ≥ 0).

## Build

Create `engine/src/providers/adapter.ts` exporting:

```ts
export interface AdapterState {
  seq: number;            // monotonic, owned by adapter, starts at 0
  sessionId: string;
  model: string;
  textBuffer: string;     // accumulates text deltas for current content block
  pendingTools: Map<number, { id: string; name: string; inputJson: string }>; // KEY BY BLOCK INDEX, not id
  emittedSessionStarted: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stopReason?: string;
}

export function createAdapterState(opts: { sessionId: string; model: string }): AdapterState;

export function adaptChunk(state: AdapterState, chunk: ProviderChunk, now: number): AgentEvent[];

/** Emit a session.completed after stream naturally ends. Caller passes duration_ms + turn count. */
export function adaptDone(state: AdapterState, opts: { turns: number; duration_ms: number; summary?: string; now: number }): AgentEvent;
```

**Important:** take `now: number` as an argument — **do not call `Date.now()`**. Tests inject a clock (CLAUDE.md convention 6).

### Mapping rules — based on ACTUAL captured chunks

> **Provider quirk — MUST READ:** The Anthropic SDK's `client.messages.stream()` helper (which the provider uses) does not emit the *raw* wire protocol. Its `message_start` event carries the **fully pre-accumulated** final `message.content` array, and `content_block_start` carries the **pre-accumulated** `content_block` (e.g. with full `tool_use.input` already populated as a JS object). The incremental `content_block_delta` chunks still stream normally. The adapter MUST ignore the pre-accumulated content and rebuild strictly from deltas — otherwise it would double-emit, and OpenRouter (lands in a later prompt) won't have the pre-accumulation to mimic.

| ProviderChunk (from live capture) | AgentEvent[] |
|---|---|
| `message_start` with `message.usage.input_tokens` | If `!emittedSessionStarted`: emit `session.started{session_id, ts, seq, wish:"" or from caller, agent, model, provider:"anthropic", cwd}`, set flag. Update `state.inputTokens = message.usage.input_tokens`, also capture `cache_read_input_tokens` → `cacheReadTokens` and `cache_creation_input_tokens` → `cacheWriteTokens`. **Ignore `message.content`** — it's a pre-accumulated preview. |
| `content_block_start` (content_block.type=`text`) | Clear `textBuffer`. No emission. **Ignore any pre-filled `content_block.text`.** |
| `content_block_start` (content_block.type=`tool_use`) | Store `pendingTools.set(index, { id: content_block.id, name: content_block.name, inputJson: "" })`. No emission. **Ignore any pre-filled `content_block.input`.** |
| `content_block_delta` (delta.type=`text_delta`) | Append `delta.text` to `textBuffer`. Emit `agent.message{delta: delta.text, final:false}`. |
| `content_block_delta` (delta.type=`input_json_delta`) | Append `delta.partial_json` to `pendingTools.get(index).inputJson`. **No emission.** Note the first delta is often the empty string `""` — that's normal. |
| `content_block_delta` (delta.type=`thinking_delta` / `signature_delta`) | Append to `state.thinkingBuffer`; emit `agent.thinking{delta, signature?}`. (Only fires when `thinking.type="enabled"` is in request.) |
| `content_block_stop` (text block) | If `textBuffer.length > 0`: emit `agent.message{delta:"", final:true}`. (The `AgentMessageEvent` schema has no `text` field — `final:true` is the flush signal; consumer re-assembles from prior deltas.) Clear `textBuffer`. |
| `content_block_stop` (tool_use block) | `JSON.parse(pendingTools.get(index).inputJson)`. If parse fails: emit `tool.error{tool_id, tool_name, code:"invalid_input", message:...}`. Else: emit `tool.called{tool_id, tool_name, input}`. Delete from `pendingTools`. |
| `message_delta` with `usage.output_tokens` | `state.outputTokens = usage.output_tokens`; `state.stopReason = delta.stop_reason`. Emit `usage.updated{input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd?}`. |
| `message_stop` | No emission. The agent loop decides whether this closes the session (stop_reason === "end_turn") or kicks off another turn (stop_reason === "tool_use"). |
| Unknown type | Silently drop (forward-compat). |

### Critical invariants

- Adapter is **pure** — same state + chunk always returns same events. No I/O, no logger, no `Date.now()`.
- `seq` is monotonic per run, owned by the adapter, written into every emitted event. Do **not** let RunManager reassign it (RunManager owns ring-buffer `id`, a separate counter — see `engine/src/server/run-manager.ts:241`).
- `session.started` MUST be emitted exactly once, before any other event.
- Track `pendingTools` by **content block index** (the `index` field on content_block_start/delta/stop), NOT by tool id. The id is available on the start event but not on deltas.
- Drop unknown chunk types silently (forward-compat).
- Never emit `undefined` properties (codebase uses `exactOptionalPropertyTypes`); use the `...(x !== undefined ? {x} : {})` pattern from `legacy-run.ts:107-108`.

## Test fixtures — real captured JSON

Paste these verbatim into `engine/src/providers/adapter.test.ts` as fixtures:

### Fixture A — text-only (Haiku 4.5, "Say hi in 3 words")

```json
{"type":"message_start","message":{"model":"claude-haiku-4-5-20251001","id":"msg_01HrziDgGpXFoDjPxLM75NXg","type":"message","role":"assistant","content":[{"type":"text","text":"Hello, how are you?"}],"stop_reason":"end_turn","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":19,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":9,"service_tier":"standard","inference_geo":"not_available"}}}
{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Hello, how are you?"}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":", how are you?"}}
{"type":"content_block_stop","index":0}
{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null,"stop_details":null},"usage":{"input_tokens":19,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":9}}
{"type":"message_stop"}
```

### Fixture B — tool_use (Haiku 4.5, get_weather("Paris"))

```json
{"type":"message_start","message":{"model":"claude-haiku-4-5-20251001","id":"msg_011htp2VEb7PkNefpGxrEdkk","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01UM7JnP2c5aLqzuUfomaRQv","name":"get_weather","input":{"city":"Paris"},"caller":{"type":"direct"}}],"stop_reason":"tool_use","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":612,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":54,"service_tier":"standard","inference_geo":"not_available"}}}
{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_01UM7JnP2c5aLqzuUfomaRQv","name":"get_weather","input":{"city":"Paris"},"caller":{"type":"direct"}}}
{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":""}}
{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"ci"}}
{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ty\": \"Paris\"}"}}
{"type":"content_block_stop","index":0}
{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null,"stop_details":null},"usage":{"input_tokens":612,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":54}}
{"type":"message_stop"}
```

Note the first `input_json_delta.partial_json` is `""` (empty string) — your JSON-concat accumulator must handle that without breaking.

## Tests

Create `engine/src/providers/adapter.test.ts` with table tests. Use vitest. Required scenarios:

1. **Trivial text (Fixture A):** produces `[session.started, agent.message(delta="Hello",final=false), agent.message(delta=", how are you?",final=false), agent.message(delta="",final=true), usage.updated(output=9,input=19)]` — `message_stop` itself yields nothing; `session.completed` is emitted later by `adaptDone()`. Seq strictly increasing from 0.
2. **Tool use (Fixture B):** produces `[session.started, tool.called(tool_id="toolu_01UM...",tool_name="get_weather",input={city:"Paris"}), usage.updated]`. No intermediate emissions for `input_json_delta`. Assert `input` is a parsed object, not a string.
3. **Invalid tool JSON:** synthetic chunks with `input_json_delta: "{not-json"` → assert `tool.error{code:"invalid_input"}`, no `tool.called`.
4. **Mixed text + tool (two blocks):** block index 0 = text, block index 1 = tool_use. Assert text flushes `(agent.message final=true)` before `tool.called`.
5. **Usage with cache hits:** `message_delta.usage` with `cache_read_input_tokens=100` → `usage.updated.cache_read_tokens=100`.
6. **Unknown chunk:** `{type:"mystery_event"}` → silently dropped, `seq` unchanged.
7. **Forward seq:** 100 chunks → 100+ events with no seq gaps or duplicates (every emitted event has `state.seq++`).
8. **`session.started` once:** feeding two `message_start` chunks in a row emits `session.started` exactly once.

Run: `bun test engine/src/providers/adapter.test.ts` — must pass.

## Provider quirks discovered during preflight

1. **SDK pre-accumulation:** as noted above, the SDK's `.stream()` helper pre-fills `message.content` in `message_start` and `content_block.input`/`content_block.text` in `content_block_start`. Do not consume these — they are cosmetic for callers using `stream.finalMessage()`.
2. **Cache-breakpoint bug:** `AnthropicProvider.stream()` with both `system` AND `tools` returns HTTP 400 `system.0.cache_control.ttl: a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block`. This is an ordering bug in `planBreakpoints()` — file an issue before Prompt 02 tries to use tools through the provider. Workaround for tests: stub the provider or call the SDK directly.
3. **Retry behavior:** provider retries on 429/500/502/503/504 and network errors (`anthropic.ts:64-77`) with jittered backoff up to `budgetMs` (default 30s). Retry events are logged at `info` level — tests should silence the logger.
4. **Error shape:** non-retryable errors surface as `Anthropic.APIError` with `.status`, `.headers`, `.error.error.message`. Retryable errors that exhaust retries throw the last `APIError`. The adapter does NOT see these — they throw from `provider.stream()` before the first yield. The agent loop (Prompt 02) is the one that must catch and emit `session.error`.

## Out of scope

- Don't touch `RunManager`, `engine.ts`, `cli/run.ts`, or HTTP routes — that's prompts 02–03.
- Don't translate to Claude Code's stream-json shape — that's prompt 04.
- Don't delete `legacy-run.ts` yet — keep it for one more prompt for diff sanity.
- Don't fix the cache_control bug here — file an issue, work around it in tests.

## Done when

- `bun test engine/src/providers/adapter.test.ts` — green (≥8 tests)
- `bunx tsc --noEmit` — clean (respects `exactOptionalPropertyTypes`)
- `bunx biome check engine/src/providers/adapter.ts` — clean

<!-- BEGIN SESSION CLOSEOUT -->
<!-- Update COMPLETION-LOG.md: Phase 99 prompt 01 ✅ with timestamp, file paths created, test count -->
<!-- File cache_control ordering bug as a separate issue before Prompt 02 starts. -->
<!-- END SESSION CLOSEOUT -->
