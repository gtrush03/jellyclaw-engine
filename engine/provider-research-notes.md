# Provider research notes — Anthropic direct + OpenRouter

> Phase 02, Prompt 01 deliverable.
> Authored: 2026-04-15.
> Scope: everything the Phase 02 implementer needs in order to write
> `engine/src/providers/anthropic.ts` and `engine/src/providers/openrouter.ts`
> without having to re-read Anthropic or OpenRouter documentation from scratch.
> Downstream prompts **MUST** treat this file as authoritative; if this file
> is wrong, fix it first, then the code.

## Table of contents

1. [Anthropic streaming](#1-anthropic-streaming)
2. [Anthropic tool use](#2-anthropic-tool-use)
3. [Anthropic caching — breakpoint rules, beta headers, TTLs, size gates](#3-anthropic-caching)
4. [Anthropic retry & errors](#4-anthropic-retry--errors)
5. [OpenRouter endpoint contract](#5-openrouter-endpoint-contract)
6. [OpenRouter tool use mapping](#6-openrouter-tool-use-mapping)
7. [OpenRouter caching regressions (#1245, #17910)](#7-openrouter-caching-regressions)
8. [OpenRouter retry differences](#8-openrouter-retry-differences)
9. [Credential pooling](#9-credential-pooling)
10. [Decision: `acknowledgeCachingLimits` gate](#10-decision-acknowledgecachinglimits-gate)

---

## 1. Anthropic streaming

**Endpoint.** `POST https://api.anthropic.com/v1/messages` with
`{ "stream": true, ... }` in the body. Authentication header
`x-api-key: <key>`; versioning header `anthropic-version: 2023-06-01`
(current GA pin). Response is `text/event-stream`, each SSE frame carries a
named event (`event: <name>`) plus a JSON data payload (`data: {...}`) whose
`type` field always matches the event name.

Source: <https://platform.claude.com/docs/en/api/messages-streaming>.

**SDK helper.** `@anthropic-ai/sdk@^0.40.0` exposes
`client.messages.stream({...})` which returns a `MessageStream` that is
simultaneously an async iterator over raw events AND an `EventEmitter` for
accumulated semantic callbacks. The two consumption styles are:

```ts
// 1) Raw async iteration — this is what jellyclaw's provider wrapper uses.
import Anthropic from "@anthropic-ai/sdk";
const client = new Anthropic();

const stream = client.messages.stream({
  model: "claude-opus-4-6",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],
});

for await (const event of stream) {
  // event.type is the discriminator; all payloads below are reachable from here.
}
```

```ts
// 2) EventEmitter style — convenient for apps, NOT what jellyclaw uses.
await client.messages
  .stream({ /* ... */ })
  .on("text", (text) => process.stdout.write(text))
  .on("message", (message) => { /* final accumulated Message */ })
  .finalMessage();
```

Source: `/anthropics/anthropic-sdk-typescript` (context7).

**Jellyclaw picks option (1)** because the upstream Engine event bus needs to
observe every state transition, not just accumulated text. The raw iterator
gives us all nine SSE event types unchanged; option (2) loses
`content_block_start`/`content_block_stop` semantics inside the SDK helper
and also swallows the `ping` frames that are useful for keepalive debugging.

### 1.1 Event flow

From the Anthropic docs:

> Each stream uses the following event flow:
> 1. `message_start`: contains a `Message` object with empty `content`.
> 2. A series of content blocks, each of which have a `content_block_start`, one or more `content_block_delta` events, and a `content_block_stop` event. Each content block has an `index` that corresponds to its index in the final Message `content` array.
> 3. One or more `message_delta` events, indicating top-level changes to the final `Message` object.
> 4. A final `message_stop` event.

Source: <https://platform.claude.com/docs/en/api/messages-streaming#event-types>.

Canonical sequence for a single-turn text response:

```
message_start
  content_block_start (index=0, type=text)
    content_block_delta (text_delta) * N
  content_block_stop   (index=0)
message_delta (stop_reason, cumulative usage)
message_stop
```

Canonical sequence for a response that ends with a tool call:

```
message_start
  content_block_start (index=0, type=text)         -- optional preamble
    content_block_delta (text_delta) * N
  content_block_stop   (index=0)
  content_block_start (index=1, type=tool_use, input={})
    content_block_delta (input_json_delta) * N     -- partial JSON string
  content_block_stop   (index=1)
message_delta (stop_reason="tool_use")
message_stop
```

Canonical sequence with extended thinking enabled:

```
message_start
  content_block_start (index=0, type=thinking, thinking="", signature="")
    content_block_delta (thinking_delta) * N
    content_block_delta (signature_delta)          -- exactly one, just before stop
  content_block_stop   (index=0)
  content_block_start (index=1, type=text)
    content_block_delta (text_delta) * N
  content_block_stop   (index=1)
message_delta
message_stop
```

`ping` events can appear anywhere between `message_start` and `message_stop`
— they carry no payload beyond `{"type": "ping"}` and exist only to keep
proxies from killing an idle TCP connection. Treat them as no-ops.

`error` events can appear at any point and imply the stream is done. Shape:

```sse
event: error
data: {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}
```

Source: <https://platform.claude.com/docs/en/api/messages-streaming#error-events>.

The Anthropic streaming doc explicitly says: *"new event types may be added,
and your code should handle unknown event types gracefully."* jellyclaw's
adapter in Phase 03 MUST treat an unknown `type` as a passthrough event with
a warning logged at `debug` level, not an error — the versioning policy
promises additive evolution.

### 1.2 Every event shape in one place

#### `message_start`

```json
{
  "type": "message_start",
  "message": {
    "id": "msg_1nZdL29xx5MUA1yADyHTEsnR8uuvGzszyY",
    "type": "message",
    "role": "assistant",
    "content": [],
    "model": "claude-opus-4-6",
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 25,
      "output_tokens": 1,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0
    }
  }
}
```

Carries the **initial** token counts. jellyclaw's cost ledger reads
`cache_creation_input_tokens` and `cache_read_input_tokens` **from this
event**, not from the final `message_delta`. The delta event's `usage` is
cumulative-output-only; it does not refresh the cache accounting fields.

#### `content_block_start`

One frame per content block. `index` starts at 0 and monotonically
increases within a single response. `content_block` is the block object
with empty payload fields:

```json
{ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }
{ "type": "content_block_start", "index": 1, "content_block": { "type": "tool_use", "id": "toolu_01T1x1fJ34qAmk2tNTrN7Up6", "name": "get_weather", "input": {} } }
{ "type": "content_block_start", "index": 0, "content_block": { "type": "thinking", "thinking": "", "signature": "" } }
```

#### `content_block_delta`

One frame per incremental update to the current block. Discriminated by
`delta.type`:

| `delta.type`       | Carries                                         | Block types that emit it     |
|--------------------|-------------------------------------------------|------------------------------|
| `text_delta`       | `text: string` (UTF-8 fragment, may be partial) | `text`                       |
| `input_json_delta` | `partial_json: string` (unparsed JSON fragment) | `tool_use`                   |
| `thinking_delta`   | `thinking: string`                              | `thinking`                   |
| `signature_delta`  | `signature: string` (base64 HMAC, exactly once) | `thinking` (only)            |
| `citations_delta`  | `citation: { ... }` (one Citation object)       | `text` (with citations tool) |

Source: <https://platform.claude.com/docs/en/api/messages-streaming#content-block-delta-types>.

**`text_delta` example:**
```sse
event: content_block_delta
data: {"type": "content_block_delta","index": 0,"delta": {"type": "text_delta", "text": "ello frien"}}
```

**`input_json_delta` — the important subtlety.** From Anthropic:
> The deltas for `tool_use` content blocks correspond to updates for the `input` field of the block. To support maximum granularity, the deltas are _partial JSON strings_, whereas the final `tool_use.input` is always an _object_.

Partial JSON means you cannot `JSON.parse` each delta in isolation. You either
(a) accumulate all `partial_json` fragments for that block index and parse
once on `content_block_stop`, or (b) use a streaming partial JSON parser
(`@anthropic-ai/sdk` ships a helper; there's also `partial-json` on npm).

Observed note from Anthropic: *"Current models only support emitting one
complete key and value property from `input` at a time."* So the shape of
each chunk is roughly one KV pair or a JSON fragment, not arbitrary bytes.
jellyclaw still accumulates and parses once; do not depend on key-boundary
framing.

**`thinking_delta` example:**
```sse
event: content_block_delta
data: {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "I need to find the GCD of 1071 and 462 using the Euclidean algorithm."}}
```

**`signature_delta`**: sent *exactly once per thinking block*, immediately
before `content_block_stop`. Carries a base64 HMAC (by Anthropic) over the
thinking content. jellyclaw **MUST** preserve this signature verbatim if
it ever replays a message with this thinking block; stripping or mutating
the signature will cause the next turn to be rejected by the API. See
Anthropic's "Extended thinking" page for the integrity rules.

**`citations_delta`**: produced when Anthropic-native citations are enabled
(web_search tool, document citations). Each frame contributes one Citation
object. Not emitted for the generic `tool_use` path — it's specific to
citation-producing tools. Phase 02 does not consume this; Phase 04 (tool
parity) and Phase 07 (MCP) will.

#### `content_block_stop`

```json
{ "type": "content_block_stop", "index": 1 }
```

This is the correct point to parse accumulated `input_json_delta` fragments.

#### `message_delta`

Carries top-level mutations to the `Message` object: `stop_reason`,
`stop_sequence`, and cumulative `usage.output_tokens`.

```json
{ "type": "message_delta", "delta": { "stop_reason": "tool_use", "stop_sequence": null }, "usage": { "output_tokens": 89 } }
```

> The token counts shown in the `usage` field of the `message_delta` event are *cumulative*.
> — <https://platform.claude.com/docs/en/api/messages-streaming#event-types>

Possible `stop_reason` values (as of Claude 4.6): `end_turn`, `max_tokens`,
`stop_sequence`, `tool_use`, `pause_turn` (used with long-running tool
orchestration), `refusal`.

#### `message_stop`

```json
{ "type": "message_stop" }
```

Terminal; no payload. After this, the SSE connection closes.

#### `ping`

```json
{ "type": "ping" }
```

Keepalive. Ignore.

#### `error`

Previously shown. Terminal.

### 1.3 Worked example — end-to-end tool_use turn

This is the exact SSE payload from Anthropic's doc for a single tool-use
turn (`"What is the weather like in San Francisco?"` → model emits a text
preamble then a `get_weather` tool call):

```sse
event: message_start
data: {"type":"message_start","message":{"id":"msg_014p7gG3wDgGV9EUtLvnow3U","type":"message","role":"assistant","model":"claude-opus-4-6","stop_sequence":null,"usage":{"input_tokens":472,"output_tokens":2},"content":[],"stop_reason":null}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type": "ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Okay"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":","}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" let's check the weather for San Francisco, CA:"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_01T1x1fJ34qAmk2tNTrN7Up6","name":"get_weather","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"location\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \"San Francisco, CA\""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":", \"unit\": \"fahrenheit\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":89}}

event: message_stop
data: {"type":"message_stop"}
```

Source: <https://platform.claude.com/docs/en/api/messages-streaming#streaming-request-with-tool-use>.

Consumption pattern jellyclaw will implement:

```ts
interface ActiveBlock {
  index: number;
  kind: "text" | "tool_use" | "thinking";
  toolUseId?: string;
  toolUseName?: string;
  textBuffer: string;
  inputJsonBuffer: string;
  thinkingBuffer: string;
  signature?: string;
}

async function* consume(
  stream: AsyncIterable<Anthropic.MessageStreamEvent>,
): AsyncGenerator<EngineEvent> {
  const blocks = new Map<number, ActiveBlock>();

  for await (const ev of stream) {
    switch (ev.type) {
      case "message_start": {
        yield { kind: "turn.start", usage: ev.message.usage };
        break;
      }
      case "content_block_start": {
        const b = ev.content_block;
        blocks.set(ev.index, {
          index: ev.index,
          kind: b.type,
          toolUseId: b.type === "tool_use" ? b.id : undefined,
          toolUseName: b.type === "tool_use" ? b.name : undefined,
          textBuffer: "",
          inputJsonBuffer: "",
          thinkingBuffer: "",
        });
        yield { kind: "block.start", index: ev.index, blockType: b.type };
        break;
      }
      case "content_block_delta": {
        const blk = blocks.get(ev.index)!;
        switch (ev.delta.type) {
          case "text_delta":
            blk.textBuffer += ev.delta.text;
            yield { kind: "text.delta", index: ev.index, text: ev.delta.text };
            break;
          case "input_json_delta":
            blk.inputJsonBuffer += ev.delta.partial_json;
            // DO NOT parse yet — fragment may be incomplete.
            break;
          case "thinking_delta":
            blk.thinkingBuffer += ev.delta.thinking;
            yield { kind: "thinking.delta", index: ev.index, text: ev.delta.thinking };
            break;
          case "signature_delta":
            blk.signature = ev.delta.signature;
            break;
          // citations_delta handled in Phase 04.
        }
        break;
      }
      case "content_block_stop": {
        const blk = blocks.get(ev.index)!;
        if (blk.kind === "tool_use") {
          const input = JSON.parse(blk.inputJsonBuffer || "{}");
          yield {
            kind: "tool_use",
            id: blk.toolUseId!,
            name: blk.toolUseName!,
            input,
          };
        } else if (blk.kind === "thinking") {
          yield {
            kind: "thinking.complete",
            text: blk.thinkingBuffer,
            signature: blk.signature!,
          };
        } else {
          yield { kind: "text.complete", index: ev.index, text: blk.textBuffer };
        }
        yield { kind: "block.stop", index: ev.index };
        break;
      }
      case "message_delta": {
        yield {
          kind: "turn.delta",
          stopReason: ev.delta.stop_reason,
          stopSequence: ev.delta.stop_sequence,
          cumulativeOutputTokens: ev.usage.output_tokens,
        };
        break;
      }
      case "message_stop": {
        yield { kind: "turn.stop" };
        return;
      }
      case "ping":
        continue;
      default:
        // Anthropic versioning policy: tolerate unknown event types.
        continue;
    }
  }
}
```

This is pseudo-code for the Phase 03 event adapter, included here so Phase
02 can design the provider interface with the right boundary: the provider
yields **raw SDK events**, and the event adapter in Phase 03 translates to
the typed `AgentEvent` surface. Phase 02 stops at the raw yield.

---

## 2. Anthropic tool use

### 2.1 Tool definition schema

Every tool is a JSON object with three required fields plus optional
metadata:

```json
{
  "name": "get_weather",
  "description": "Get the current weather in a given location",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": {
        "type": "string",
        "description": "The city and state, e.g. San Francisco, CA"
      },
      "unit": {
        "type": "string",
        "enum": ["celsius", "fahrenheit"],
        "description": "Temperature unit"
      }
    },
    "required": ["location"]
  }
}
```

- `name`: `^[a-zA-Z0-9_-]{1,64}$`. Must be unique within a single request.
- `description`: free text. Empty allowed but strongly discouraged — model
  tool selection quality degrades sharply.
- `input_schema`: JSON Schema 2020-12 subset. The top-level must be
  `"type": "object"`.
- `cache_control` (optional): `{ "type": "ephemeral" }` or
  `{ "type": "ephemeral", "ttl": "1h" }`. When placed on a tool, covers
  that tool and every tool defined *before* it in the array — see §3.
- `eager_input_streaming` (optional, boolean): enables fine-grained tool
  argument streaming (see 2.3).

Anthropic also has first-party "server tools" whose `type` is a dated
identifier rather than a custom object (e.g. `"type":
"web_search_20250305"`). jellyclaw does not ship those in Phase 02; they
arrive in Phase 07 (MCP integration) where first-party and MCP tools unify.

Source: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/implementing-tool-use>.

### 2.2 `tool_choice`

| Value                                                        | Semantics                                              |
|--------------------------------------------------------------|--------------------------------------------------------|
| `{ "type": "auto" }`                                         | Model picks whether/which to call. Default.            |
| `{ "type": "any" }`                                          | Model MUST call exactly one tool from the array.       |
| `{ "type": "tool", "name": "get_weather" }`                  | Model MUST call that specific tool.                    |
| `{ "type": "none" }`                                         | Model MUST NOT call any tool — behaves like no tools.  |

Optional flag on `auto` and `any`: `"disable_parallel_tool_use": true`
forces sequential single-tool turns. Default is parallel allowed.

### 2.3 Fine-grained streaming (`eager_input_streaming`)

From Anthropic: *"Tool use supports fine-grained streaming for parameter
values. Enable it per tool with `eager_input_streaming`."* Without this,
`input_json_delta` fragments still arrive one-key-at-a-time (waiting for
each key's full value). With it, the model can stream inside a string
value, so the delta granularity drops to partial bytes. Tradeoff: faster
perceived streaming of long tool arguments (e.g. a 10KB `file_contents`
argument) in exchange for a more involved partial-JSON parser on our side.

Phase 02 recommendation: **do not set `eager_input_streaming` by default**.
The partial-JSON parser complexity isn't worth it until Phase 04 when
tool-argument streaming has a concrete UX payoff (live file-edit preview).
Leave the flag reachable via config but default off.

Source: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming>.

### 2.4 Tool result turn

After a `tool_use` response, the next user turn carries the result as a
content block inside the `user` message:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01T1x1fJ34qAmk2tNTrN7Up6",
      "content": "72°F and sunny",
      "is_error": false
    }
  ]
}
```

- `tool_use_id`: **must** match the `id` from the preceding `tool_use` block.
- `content`: string OR array of content blocks (`text`, `image`). For
  jellyclaw, always string — we stringify tool outputs in the engine core
  before handing them to the provider wrapper.
- `is_error`: boolean, default `false`. When `true`, the model treats the
  tool output as a failure and adapts (retry, apologize, choose
  alternative).

Multiple `tool_result` blocks MAY appear in a single user turn when the
model emitted parallel `tool_use` blocks in one assistant turn.

### 2.5 Minimal request shape jellyclaw's Anthropic provider will build

```ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const stream = client.messages.stream({
  model: "claude-opus-4-6",
  max_tokens: 8192,
  system: [
    {
      type: "text",
      text: JELLYCLAW_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral", ttl: "1h" },   // breakpoint #1
    },
  ],
  tools: [
    ...toolsExceptLast,
    { ...lastTool, cache_control: { type: "ephemeral" } }, // breakpoint #2
  ],
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: CLAUDE_MD, cache_control: { type: "ephemeral" } }, // #3
        { type: "text", text: SKILLS_BUNDLE, cache_control: { type: "ephemeral" } }, // #4
        { type: "text", text: USER_TURN },
      ],
    },
    ...history,
  ],
});
```

Exactly four breakpoints, aligned with SPEC §7. See §3 for why.

---

## 3. Anthropic caching

**Source of truth:** <https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching>.

### 3.1 Eligible content types

Content blocks that may carry `cache_control`:

- **Tools**: any entry of `tools[]`.
- **System**: any entry of `system[]` when system is structured (array of
  content blocks).
- **Messages content**: `text`, `image`, `document`, `tool_use`,
  `tool_result` blocks in `messages[].content[]`, for both `user` and
  `assistant` turns.

Not eligible:
- `thinking` blocks (cannot be explicitly marked, but ARE cached implicitly
  as part of the preceding assistant turn when that turn is cached).
- Sub-content blocks like citations.
- Empty text blocks.

Quote:
> Cannot be cached directly: Thinking blocks (cannot be explicitly marked
> with `cache_control`, but can be cached alongside other content in
> previous assistant turns)

### 3.2 Minimum cacheable token thresholds

| Model tier                                              | Min tokens to cache |
|---------------------------------------------------------|---------------------|
| Claude Mythos Preview / Opus 4.6 / Opus 4.5             | 4096                |
| Claude Sonnet 4.6                                       | 2048                |
| Sonnet 4.5 / Opus 4.1 / Opus 4 / Sonnet 4 / Sonnet 3.7  | 1024                |
| Claude Haiku 4.5                                        | 4096                |
| Claude Haiku 3.5                                        | 2048                |
| Claude Haiku 3                                          | 4096                |

Quote:
> Shorter prompts cannot be cached, even if marked with `cache_control`.
> Any requests to cache fewer than this number of tokens will be processed
> without caching, and no error is returned.

**Jellyclaw note:** the gate is silent. A system prompt of 900 tokens will
still have `cache_control` emitted but will not create a cache entry,
`cache_creation_input_tokens` will stay 0, and the next call will also miss.
Emitting a warning when we detect a below-threshold breakpoint is worth
doing in Phase 02 — compute token count via
`client.messages.countTokens()` at startup for the system prompt, once,
and log if under the model threshold.

### 3.3 Cache control parameters — TTL + beta header

The `cache_control` object supports two shapes:

```json
{ "type": "ephemeral" }                         // 5-minute TTL (default)
{ "type": "ephemeral", "ttl": "1h" }            // 1-hour TTL (2× base write cost)
```

> Currently: "ephemeral" is the only supported cache type, which by default
> has a 5-minute lifetime.

**Beta header for 1-hour TTL:** `anthropic-beta: extended-cache-ttl-2025-04-11`.

Verified via multiple independent integrations in April 2026:
- Spring AI: *"automatically adds the required beta header
  `anthropic-beta: extended-cache-ttl-2025-04-11` when you configure 1-hour TTL"*
  — <https://spring.io/blog/2025/10/27/spring-ai-anthropic-prompt-caching-blog/>
- Continue IDE: same header string — <https://github.com/continuedev/continue/issues/6135>
- Agno: `default_headers={"anthropic-beta": "extended-cache-ttl-2025-04-11"}`
  — <https://www.agno.com/blog/llm-response-caching-in-agno>

Pricing: 1h cache writes are billed at 2× the base input token price;
reads at 0.1× (unchanged from 5m — Anthropic cache reads are always 10% of
base regardless of TTL).

**Jellyclaw MUST send the header** whenever any breakpoint in the outgoing
request has `ttl: "1h"`. The Anthropic SDK accepts multiple beta headers
comma-separated in a single `anthropic-beta` value:

```ts
new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: {
    "anthropic-beta": "extended-cache-ttl-2025-04-11",
  },
});
```

Or per-request via `client.messages.stream({...}, { headers: { "anthropic-beta": "..." } })`.

**Observed drift watch:** `extended-cache-ttl-2025-04-11` has been stable
since April 2025 (despite the name). Anthropic has rotated beta header
suffixes before; Phase 02 implementation should keep the literal in
exactly one constant:

```ts
// engine/src/providers/anthropic-beta.ts
export const BETA_EXTENDED_CACHE_TTL = "extended-cache-ttl-2025-04-11";
```

### 3.4 Invalidation hierarchy

From Anthropic:
> Hierarchy: `tools` → `system` → `messages`. Changes at each level
> invalidate that level and all subsequent levels.

| Change                     | Invalidates tools | system | messages |
|----------------------------|-------------------|--------|----------|
| Tool definitions change    | ✓                 | ✓      | ✓        |
| Web search toggle          |                   | ✓      | ✓        |
| Citations toggle           |                   | ✓      | ✓        |
| Speed setting              |                   | ✓      | ✓        |
| Tool choice                |                   |        | ✓        |
| Images                     |                   |        | ✓        |
| Thinking parameters        |                   |        | ✓        |

**Stability requirements per breakpoint:**

- **System block:** the entire `system` array content up to and including
  the breakpoint must be byte-identical across requests. Jellyclaw must not
  inject timestamps, session IDs, or changing user context into the system
  block. Agent persona + tool-use framing only.
- **Tools:** the entire `tools` array (in order) up to and including the
  breakpoint-carrying tool must be byte-identical. Jellyclaw must sort tools
  deterministically and never randomize order between turns.
- **CLAUDE.md block:** the file contents must be byte-identical between
  calls within the 5-minute window. If the user edits CLAUDE.md mid-session,
  the next call is a fresh write. Accept this cost; do not try to
  fingerprint partial changes.
- **Skills bundle:** the concatenation of the top-N skill bodies must be
  byte-identical. The `skillsTopN` config and the ranking algorithm must
  both be deterministic. In Phase 05 the rank function is keyed on recency
  of use within the session — stable for the duration of a session.

### 3.5 Maximum breakpoints

> Up to 4 cache breakpoints can be defined per request. If 4 explicit
> block-level breakpoints already exist, the API returns a 400 error with
> no slots left for automatic caching.

Jellyclaw's four slots (from SPEC §7) map directly onto this limit:

1. System (last block) → `ttl: "1h"`
2. Tools (last tool) → `ttl: "5m"` (default)
3. CLAUDE.md (user-turn text block) → `ttl: "5m"`
4. Skills bundle (user-turn text block) → `ttl: "5m"`

Rationale for the single 1h slot being on system: system changes rarely
(only on agent persona changes or SPEC edits), while tool definitions
change each time we add/remove an MCP server or skill. Keeping the 1h slot
on the most-stable surface maximizes the win from the 2× write cost.

### 3.6 Placement rule — the cache_control goes on the LAST block of the stable prefix

Anthropic's clearest statement:

> Place `cache_control` on the last block whose prefix is identical across
> the requests you want to share a cache... For a prompt with a varying
> suffix (timestamps, per-request context, the incoming message), place
> the breakpoint at the end of the static prefix, not on the varying block.

Practical corollaries for jellyclaw:

- **Tools array:** `cache_control` goes on the *last* tool. The API caches
  everything before AND including that tool.
- **System array:** if system has multiple blocks, `cache_control` goes on
  the last block that is stable — typically the single block we emit.
- **User content array:** the CLAUDE.md block comes first (stable), then
  the skills bundle (stable within session), then the user turn text
  (varies). `cache_control` goes on the skills bundle block (last stable
  element). The user turn text block that follows is NOT cached — it's the
  varying suffix.

Picture:

```
system:  [ <...persona...> cache_control:1h ]
         ^--------------------------^ cached as breakpoint #1

tools:   [ t0, t1, t2, ..., tN cache_control:5m ]
         ^-----------------------^ cached as breakpoint #2 (all tools)

messages[0].content:
         [ CLAUDE.md cache_control:5m,
           skills_bundle cache_control:5m,
           user_text ]
         ^---cached ---^   ^---cached---^   (not cached, varies)
         breakpoint #3     breakpoint #4
```

Anthropic's prompt-caching doc confirms that when placing `cache_control` on
the LAST element of tools or messages, *"all [elements] defined before and
including the marked [element] are cached as a single prefix."*

### 3.7 Lookback window

> The system checks at most 20 positions per breakpoint, counting the
> breakpoint itself as the first.

Meaning: if the exact byte prefix up to a given breakpoint was cached in a
previous request, that prefix is a cache read. The 20-position window means
the API looks back at most 20 tokens' worth of content prior to the
breakpoint when matching against prior cache entries. Jellyclaw does not
need to do anything special to take advantage of this; it's an upper bound
on matching fuzziness that we automatically benefit from.

### 3.8 Usage fields — how we read the hit rate

From `message_start` event (or response `usage` on non-streaming):

```json
"usage": {
  "input_tokens": 50,
  "output_tokens": 1,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 1800
}
```

Formula:

```
total_input_tokens = cache_read_input_tokens + cache_creation_input_tokens + input_tokens
```

- `cache_read_input_tokens`: prefix-before-breakpoint that was already cached (a hit).
- `cache_creation_input_tokens`: prefix-before-breakpoint being cached THIS request (a write).
- `input_tokens`: everything AFTER the last breakpoint (uncached).

jellyclaw's hit-rate metric:

```ts
hitRate =
  cache_read_input_tokens /
  (cache_read_input_tokens + cache_creation_input_tokens + input_tokens);
```

Target (from SPEC §7): ≥85% in steady-state Genie usage.

### 3.9 Automatic top-level caching (nice to know; we do not use it)

Anthropic also offers a shortcut: set `cache_control` at the **top level of
the request body** and the API auto-places breakpoints for you. jellyclaw
does NOT use this because:

1. We want deterministic breakpoint placement for cost modeling.
2. It's documented as only supported on direct Anthropic routes, not via
   Bedrock / Vertex (see §7).
3. Our four-slot strategy is tailored to jellyclaw's known content shape;
   auto placement cannot know that our skills-bundle block is worth
   caching separately from CLAUDE.md.

### 3.10 Complete Anthropic-path outgoing request (reference)

```ts
const BETA_EXTENDED_CACHE_TTL = "extended-cache-ttl-2025-04-11";

const stream = client.messages.stream(
  {
    model: "claude-opus-4-6",
    max_tokens: 8192,
    system: [
      { type: "text", text: PERSONA, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    tools: [
      ...earlyTools,
      { ...lastTool, cache_control: { type: "ephemeral" } },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: CLAUDE_MD, cache_control: { type: "ephemeral" } },
          { type: "text", text: SKILLS, cache_control: { type: "ephemeral" } },
          { type: "text", text: USER_TURN },
        ],
      },
      ...history,
    ],
  },
  {
    headers: { "anthropic-beta": BETA_EXTENDED_CACHE_TTL },
  },
);
```

---

## 4. Anthropic retry & errors

### 4.1 Error taxonomy

The `@anthropic-ai/sdk` exposes discriminated error classes all inheriting
from `Anthropic.APIError`:

```ts
try { /* ... */ } catch (error) {
  if (error instanceof Anthropic.APIError) {
    error.status;   // number, HTTP status
    error.message;  // human message
    error.headers;  // response headers (for Retry-After)
    if (error instanceof Anthropic.RateLimitError)             { /* 429 */ }
    else if (error instanceof Anthropic.AuthenticationError)   { /* 401 */ }
    else if (error instanceof Anthropic.PermissionDeniedError) { /* 403 */ }
    else if (error instanceof Anthropic.NotFoundError)         { /* 404 */ }
    else if (error instanceof Anthropic.ConflictError)         { /* 409 */ }
    else if (error instanceof Anthropic.UnprocessableEntityError) { /* 422 */ }
    else if (error instanceof Anthropic.BadRequestError)       { /* 400 */ }
    else if (error instanceof Anthropic.InternalServerError)   { /* 500-series */ }
    else if (error instanceof Anthropic.APIConnectionError)    { /* network */ }
  }
}
```

Source: `/anthropics/anthropic-sdk-typescript` (context7) and the SDK's
`src/error.ts`.

### 4.2 Retryability matrix

| Status / cause                                 | Retry?     | Notes                                                |
|------------------------------------------------|------------|------------------------------------------------------|
| `400 bad_request_error`                        | **NO**     | Client bug. Fix the request; retrying loops.         |
| `401 authentication_error`                     | **NO**     | Bad/expired key. Surface to user.                    |
| `403 permission_error`                         | **NO**     | Account-level. Surface to user.                      |
| `404 not_found_error`                          | **NO**     | Bad model ID usually.                                |
| `413 request_too_large`                        | **NO**     | Pre-flight size check should prevent. Fail hard.     |
| `429 rate_limit_error` w/ `Retry-After`        | **YES**    | Honor header exactly; then retry.                    |
| `429 rate_limit_error` w/o header              | **YES**    | Backoff 2s → 4s → 8s (cap 16s), up to 3 attempts.    |
| `500 api_error`                                | **YES**    | Transient server error.                              |
| `529 overloaded_error` (and SSE `error` event) | **YES**    | Anthropic overload. Backoff like 429-no-header.      |
| `ETIMEDOUT`, `ECONNRESET`, `EPIPE`             | **YES**    | Network. Backoff 250ms → 750ms → 2s.                 |
| DNS / TLS failure                              | **YES**    | Same as network.                                     |
| Unknown                                        | **NO**     | Surface, don't mask.                                 |

### 4.3 Retry budget (jellyclaw policy)

- **Max attempts per call:** 3 (initial + 2 retries).
- **Max total wall time per call:** 30 seconds including backoffs.
- **Backoff:** exponential with full jitter. Base = 250ms, cap = 8s.
  `delay = random(0, min(cap, base * 2^attempt))`.
- **`Retry-After` header:** overrides computed backoff when present and
  within budget; if `Retry-After` > remaining budget, abort without retry
  and bubble up so the router can try a secondary provider.

**Do not use `@anthropic-ai/sdk`'s built-in retry wrapper for streaming
calls.** The SDK's default (`maxRetries: 2`) covers only the initial
request establishment; once a stream is open, a mid-stream disconnect is
the caller's problem. jellyclaw's provider wrapper explicitly wraps the
`client.messages.stream(...)` call in its own retry loop that understands
"mid-stream error" versus "pre-stream error":

- Pre-stream error (before first `message_start`): safe to retry in full.
- Mid-stream error: fail to the router; the router may re-dispatch to a
  secondary, but we MUST NOT silently resume — partial output already
  streamed to the consumer is no longer reusable context.

### 4.4 Anthropic-specific error shape

Non-200 response body (per `/v1/messages`):

```json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "messages: at least one message is required"
  }
}
```

The outer `type` is always `"error"`. The inner `error.type` is one of
`invalid_request_error`, `authentication_error`, `permission_error`,
`not_found_error`, `request_too_large`, `rate_limit_error`, `api_error`,
`overloaded_error`. jellyclaw should log the `error.message` exactly (it
often contains a JSON pointer) and wrap for the user.

Source: <https://platform.claude.com/docs/en/api/errors>.

### 4.5 SDK construction with all the right knobs

```ts
import Anthropic from "@anthropic-ai/sdk";

export function makeAnthropicClient(opts: {
  apiKey: string;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
  includeExtendedCacheBeta: boolean;
}): Anthropic {
  return new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,  // undefined → https://api.anthropic.com
    timeout: opts.timeoutMs ?? 600_000,  // long; we handle shorter budgets ourselves
    maxRetries: opts.maxRetries ?? 0,    // OUR retry loop, not SDK's
    defaultHeaders: opts.includeExtendedCacheBeta
      ? { "anthropic-beta": "extended-cache-ttl-2025-04-11" }
      : {},
  });
}
```

- `maxRetries: 0` — jellyclaw wraps its own retry logic (4.3); the SDK's
  built-in retry hides too much state from the router (failure count,
  elapsed time, last error body).
- `timeout: 600_000` — the SDK-level timeout; we rely on our own 30s
  budget. A long SDK timeout avoids spurious aborts mid-stream when a
  long-thinking response is in flight.

---

## 5. OpenRouter endpoint contract

### 5.1 URL and method

**`POST https://openrouter.ai/api/v1/chat/completions`**

OpenAI-compatible chat completions schema. OpenRouter explicitly says:
*"OpenRouter's request and response schemas are very similar to the OpenAI
Chat API, and OpenRouter normalizes the schema across models and providers
so you only need to learn one."*

Source: <https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request>.

### 5.2 Request headers

| Header                    | Required?  | Value / purpose                                                                 |
|---------------------------|------------|---------------------------------------------------------------------------------|
| `Authorization`           | **yes**    | `Bearer <OR_KEY>`.                                                              |
| `Content-Type`            | **yes**    | `application/json`.                                                             |
| `HTTP-Referer`            | optional   | Site URL for OpenRouter leaderboard. Recommended for production.                |
| `X-Title`                 | optional   | Site title for leaderboard. Short string.                                       |
| `OpenRouter-*`            | —          | No known stable routing header at v1. Provider routing lives in the `provider` body field. |

Jellyclaw's OR wrapper sets:

```http
Authorization: Bearer <key>
Content-Type: application/json
HTTP-Referer: https://github.com/gtrush03/jellyclaw-engine
X-Title: jellyclaw
```

### 5.3 Request body shape (the fields jellyclaw cares about)

```ts
interface OpenRouterChatRequest {
  model: string;               // e.g. "anthropic/claude-sonnet-4.6" or "qwen/qwen3-coder"
  messages: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string | OpenAIContentPart[];
    name?: string;             // for tool role, optional
    tool_call_id?: string;     // REQUIRED on tool role
    tool_calls?: Array<{       // on assistant role when the turn included tool calls
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>;

  // Tool calling (OpenAI-compatible)
  tools?: Array<{
    type: "function";
    function: {
      name: string;
      description?: string;
      parameters: object;      // JSON Schema
    };
  }>;
  tool_choice?:
    | "none"
    | "auto"
    | "required"
    | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;

  // Streaming
  stream?: boolean;
  stream_options?: { include_usage?: boolean };

  // Generation
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  response_format?:
    | { type: "text" }
    | { type: "json_object" }
    | { type: "json_schema"; json_schema: object };

  // OR-specific
  provider?: {
    order?: string[];
    only?: string[];
    ignore?: string[];
    allow_fallbacks?: boolean;
    require_parameters?: boolean;
    data_collection?: "allow" | "deny";
    max_price?: { prompt?: number; completion?: number };
    quantizations?: string[];
  };
  transforms?: string[];
  route?: "fallback";  // legacy
  reasoning?: { effort?: "low" | "medium" | "high" };  // for reasoning models
}
```

Sources:
- <https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request>
- <https://openrouter.ai/docs/guides/features/tool-calling>
- <https://openrouter.ai/docs/api/reference/parameters>

### 5.4 Streaming SSE format

`stream: true` switches the response to SSE. Format is OpenAI-compat:

```
data: {"id":"gen-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"gen-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

: OPENROUTER PROCESSING

data: {"id":"gen-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}

data: {"id":"gen-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

Key quirks (from <https://openrouter.ai/docs/api/reference/streaming>):

- **Comment keepalives.** Lines beginning with `:` are SSE comments and
  must be ignored. OpenRouter uses `: OPENROUTER PROCESSING`.
- **Termination sentinel.** `data: [DONE]` marks the end of the stream.
  After this, close the connection.
- **Mid-stream errors.** When a provider errors after some tokens have
  been sent, OpenRouter sends a final chunk with `finish_reason: "error"`
  and an `error` field alongside the regular chunk fields. Jellyclaw must
  recognize this and treat as a failure (no retry mid-stream; router
  decides).
- **Cancellation.** Aborting the HTTP connection immediately halts billing
  **only for streaming requests to providers that support it (OpenAI,
  Anthropic, Fireworks, etc.).** For non-streaming or unsupported
  providers, billing continues.

### 5.5 Response headers worth capturing

- **`X-Generation-Id`**: a per-request identifier OpenRouter issues. Useful
  to correlate with OR's `/api/v1/generation/{id}` endpoint for post-hoc
  cost attribution and cache-hit verification. jellyclaw logs this on
  every call.

### 5.6 Response body (non-stream)

```json
{
  "id": "gen-1234567890",
  "object": "chat.completion",
  "created": 1745000000,
  "model": "anthropic/claude-sonnet-4.6",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Sure, let me look that up.",
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"location\":\"San Francisco, CA\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ],
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 45,
    "total_tokens": 1245,
    "prompt_tokens_details": {
      "cached_tokens": 0,
      "cache_write_tokens": 0
    }
  }
}
```

Per <https://openrouter.ai/docs/guides/best-practices/prompt-caching>, when
caching is observed by OR it reports via `prompt_tokens_details.cached_tokens`
and `prompt_tokens_details.cache_write_tokens`. On the Anthropic path via OR,
these are structurally present but frequently 0 even when they shouldn't be
— see §7.

### 5.7 Normalized `finish_reason` values (OpenRouter)

`tool_calls`, `stop`, `length`, `content_filter`, `error`.

Note this diverges from Anthropic's native `stop_reason` set
(`end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`,
`refusal`). The Phase 03 event adapter translates bidirectionally but
lossily — e.g., `refusal` collapses to `content_filter`, `pause_turn` to
`stop`.

### 5.8 Provider routing object (the one OR-specific knob)

```json
{
  "provider": {
    "order": ["anthropic", "google-vertex"],
    "only": ["anthropic"],
    "ignore": ["deepinfra"],
    "allow_fallbacks": true,
    "require_parameters": true,
    "data_collection": "deny",
    "max_price": { "prompt": 10, "completion": 30 }
  }
}
```

Jellyclaw's OR path for Anthropic models sets `provider.only: ["anthropic"]`
because we only want to route via OR's direct Anthropic vendor integration,
not via a Bedrock/Vertex re-routing that definitely has different caching
semantics. For non-Anthropic models, we leave `provider` empty and let OR
pick.

---

## 6. OpenRouter tool use mapping

### 6.1 Tool definitions

OR uses the OpenAI function-calling shape:

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather in a given location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": { "type": "string" }
          },
          "required": ["location"]
        }
      }
    }
  ]
}
```

Differences from Anthropic's shape:
- Outer wrapper is `{type:"function", function:{...}}`; Anthropic is flat.
- Tool schema key is `parameters`; Anthropic is `input_schema`.
- No `cache_control` field. See §7.

### 6.2 `tool_choice`

| Value                                                    | Semantics                           |
|----------------------------------------------------------|-------------------------------------|
| `"none"`                                                 | Disable tools; behave as chat.      |
| `"auto"`                                                 | Model decides. (Default when tools present.) |
| `"required"`                                             | Model MUST call ≥1 tool.            |
| `{"type":"function","function":{"name":"get_weather"}}`  | Force a specific tool.              |

Note the semantic difference vs. Anthropic:
- OR `required` ≈ Anthropic `{type:"any"}`.
- OR `auto` ≈ Anthropic `{type:"auto"}`.
- OR specific-name object ≈ Anthropic `{type:"tool", name:"..."}`.

### 6.3 Parallel tool calls

`parallel_tool_calls: boolean` (default varies by model/provider). When
`true`, the model MAY emit multiple `tool_calls[]` entries in a single
assistant message. Jellyclaw accepts this but Phase 04 tool runner will
serialize execution (parallel tool exec is Phase 08 territory).

### 6.4 Tool call shape in response + streaming

Non-streaming (shown in §5.6): `choices[0].message.tool_calls[]` with
`id`, `type: "function"`, `function.name`, `function.arguments` (a JSON
string — must be `JSON.parse`'d).

Streaming delta:

```
data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"location\":"}}]}}]}

data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \"SF\"}"}}]}}]}

data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}
```

Notes:
- The `tool_calls[].index` field (inside the delta array) identifies which
  parallel tool call this fragment contributes to.
- `function.arguments` is a partial JSON string and accumulates across
  chunks, same as Anthropic's `input_json_delta` — must not be parsed until
  the final chunk.
- `id` is emitted on the first chunk for that tool call; subsequent chunks
  omit it.

### 6.5 Multi-turn tool result turn

```json
{
  "messages": [
    { "role": "user", "content": "weather in SF?" },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        { "id": "call_abc", "type": "function", "function": { "name": "get_weather", "arguments": "{\"location\":\"SF\"}" } }
      ]
    },
    { "role": "tool", "tool_call_id": "call_abc", "content": "72°F and sunny" },
    { "role": "user", "content": "convert to C" }
  ]
}
```

Mapping table — Anthropic ↔ OpenRouter (jellyclaw's Phase 03 event adapter
owns this translation):

| Anthropic shape                                                | OpenRouter shape                                                          |
|----------------------------------------------------------------|---------------------------------------------------------------------------|
| `assistant` message with `tool_use` content block              | `assistant` message, `content: null`, `tool_calls: [{...}]`               |
| `user` message with `tool_result` content block                | `tool` message with `tool_call_id`                                        |
| `tool_use_id` (snake_case, on the tool_result)                 | `tool_call_id` (snake_case, on the tool message)                          |
| `tool_use.id = "toolu_01..."`                                  | `tool_calls[0].id = "call_..."` (prefix is provider-specific)             |
| `input_schema`                                                 | `function.parameters`                                                     |
| `name` on the tool                                             | `function.name`                                                           |
| `tool_use.input` is an object                                  | `function.arguments` is a **JSON string**                                 |

The Phase 03 event adapter emits a single `AgentEvent.tool_call` shape for
both providers — the translation hides above it.

---

## 7. OpenRouter caching regressions

Two separate but compounding problems, both of which jellyclaw must work
around. **The upshot (skip to §7.3 for the one-line policy):** on the
OpenRouter path, strip `cache_control` unconditionally. Never rely on
OpenRouter billing accounting for cache hits. Never quote cache economics
to the user when the active provider is OpenRouter.

### 7.1 Issue #1245 — cache_control silently dropped on Anthropic-via-OR path

**Primary citation in jellyclaw's docs:** SPEC §6.2 and PROVIDER-STRATEGY §1
both reference this issue as "#1245". The concrete tracked issue across
multiple forks is:

- <https://github.com/sst/opencode/issues/1245>
  (*"Anthropic caching not really working via OpenRouter"*)
  — Reporter noted: *"OpenRouter would be a great alternative. However,
  without proper caching, this is not viable."* Marked closed via the
  linked PR #1305 in that repo, but the fix was in opencode's integration,
  not in OpenRouter itself.
- <https://github.com/anomalyco/opencode/issues/1245> — same issue in the
  fork.
- <https://github.com/OpenRouterTeam/ai-sdk-provider/issues/35> — the
  **upstream root cause**: OR's `@openrouter/ai-sdk-provider` does not
  translate Vercel AI SDK `CachePoint` items into `cache_control`
  breakpoints on outbound requests, silently stripping them.
- <https://github.com/zed-industries/zed/issues/52576> — independent
  reproduction in Zed.
- <https://github.com/pydantic/pydantic-ai/issues/4392> — independent
  reproduction in Pydantic AI. Quote:
  > OpenRouterChatModel currently inherits the OpenAI base behavior which
  > silently drops CachePoint items... any CachePoint passed in messages
  > is silently ignored — even when the underlying model (e.g. Anthropic
  > via OpenRouter) supports it.

**The bug.** In multiple OpenRouter SDK code paths and in OpenRouter's
internal Anthropic proxy, `cache_control` objects in outbound requests are
silently dropped before reaching Anthropic. The request succeeds with a
200 but the prompt is billed at full base rate. `cache_read_input_tokens`
in Anthropic-reported usage ends up 0; OR's
`prompt_tokens_details.cached_tokens` also reports 0.

**Observed symptoms.**
- `cache_read_input_tokens == 0` on every subsequent request that should
  have been a hit.
- Cost per session is 4–10× higher than the direct-Anthropic baseline for
  the same model + prompt shape.
- No error, no warning, no indication in the response that caching was
  stripped.

**Upstream status (as of 2026-04-15).** Workarounds exist in downstream
integrations (pydantic-ai, opencode SDK fork). OpenRouter's own aisdk
provider (issue #35) is **still open** per the above linked thread. Some
OR code paths — specifically the raw REST path with cache_control placed
on messages content blocks — appear to forward correctly to Anthropic,
but others (SDK integrations, certain provider-routing configurations) do
not. The behavior is not consistent enough to rely on.

**Implication for jellyclaw.** **Never emit `cache_control` on the
OpenRouter path.** Even if one code path works, the next OR server-side
change can silently regress. The cost of a regression is a 10× billing
blowup; the cost of not caching on OR is 1× the OR markup. Asymmetric.

### 7.2 Issue #17910 — OAuth-scoped tokens + cache_control → HTTP 400 since 2026-03-17

**Primary citation:**
- <https://github.com/anomalyco/opencode/issues/17910> —
  *"bug: OAuth auth + cache_control ephemeral causes HTTP 400 on all Claude
  models since 2026-03-17"*

**The bug.** Starting 2026-03-17, Anthropic's API began returning HTTP 400
on any Claude-model request that uses **OAuth** authentication (which is
how OpenRouter's subscription tokens attach) **and** includes any
`cache_control` object in the request body. Previously, the cache_control
field was silently ignored for OAuth requests; now it is rejected.

Quote from the issue: *"Previously, the Anthropic API silently ignored
this field for OAuth requests; as of 2026-03-17, it returns HTTP 400."*

The immediate trigger in the OpenCode fork was that the bundled
`@ai-sdk/anthropic` package **unconditionally injects** `cache_control:
{"type":"ephemeral"}` into every system message block. Once Anthropic
flipped the server-side behavior, every OAuth-authenticated Claude call
via that code path started failing.

**Scope.**
- **Affected:** OAuth-authenticated Claude models (all versions tested).
- **Unaffected:** API-key authentication (normal direct Anthropic
  `x-api-key` flow — jellyclaw's primary path).
- **Unaffected:** non-Anthropic models, regardless of auth.

**Confirmation this is an Anthropic-side change, not an OR regression.** A
parallel report in `oh-my-openagent` hit identical symptoms at the same
moment with no OR involvement.

**Implication for jellyclaw.** Even if we solve #1245 (say OR fixes the
strip-on-proxy bug tomorrow), we STILL cannot emit `cache_control` when
routing through OpenRouter IF the user's OR account uses OAuth /
subscription-based tokens (common for Claude subscription users who hook
OR onto their Anthropic subscription). Since jellyclaw cannot reliably
distinguish OR-via-API-key from OR-via-OAuth at request time (OR doesn't
expose this), the safe policy is unconditional strip on the OR path.

### 7.3 Policy — the one-line rule

> **On the OpenRouter provider path, jellyclaw MUST strip every
> `cache_control` field from the outbound request body, for every model,
> regardless of model vendor or OR authentication mode.**

Implementation sketch:

```ts
// engine/src/providers/openrouter.ts
function stripCacheControl(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripCacheControl);
  if (obj && typeof obj === "object") {
    const { cache_control: _drop, ...rest } = obj as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) out[k] = stripCacheControl(v);
    return out;
  }
  return obj;
}
```

The Phase 02 `router.ts` must pipe the OR request through this function
UNCONDITIONALLY. The Anthropic provider path does NOT strip — that's the
whole point of having two providers.

### 7.4 Warning emitted when a user selects OR for an Anthropic model

Per SPEC §6.2, log once per process start:

```
[jellyclaw] OpenRouter provider active with an Anthropic model.
            Prompt caching is currently broken on this route
            (upstream issues #1245, #17910). Expect 4-10× higher
            token cost. Use --provider anthropic for full caching.
```

Detection: `providerName === "openrouter" && /^anthropic\//.test(modelId)`.

Non-Anthropic-via-OR calls (Gemini, Qwen, Llama) emit no warning — they're
the reason OR exists and don't suffer these regressions.

### 7.5 Re-evaluation cadence

Per PROVIDER-STRATEGY §8: *"OpenRouter's caching bugs may land a fix
before we can upstream our workaround. Re-evaluate quarterly."*

Concretely, once per quarter (or on any OR release announcement that
mentions caching), run:

```sh
bun run scripts/probe-or-cache.ts --model anthropic/claude-sonnet-4.6 --with-cache-control
```

If two consecutive runs report `cache_read_input_tokens > 0` on the
expected cache hit, **start a new research cycle** — do not flip the
policy based on one data point.

---

## 8. OpenRouter retry differences

### 8.1 Retryability matrix (OR)

| Status / cause                                  | Retry?     | OR-specific notes                                              |
|-------------------------------------------------|------------|---------------------------------------------------------------|
| `400`                                           | **NO**     | Client bug.                                                   |
| `401`                                           | **NO**     | Bad OR key.                                                   |
| `402 payment required`                          | **NO**     | OR credit balance zero. Surface prominently.                  |
| `403`                                           | **NO**     | Moderation / region block.                                    |
| `429` w/ `Retry-After`                          | **YES**    | Honor header.                                                 |
| `429` w/o `Retry-After`                         | **YES**    | Could be OR-level OR downstream provider. Backoff as usual.   |
| `502`                                           | **YES**    | Often downstream provider outage; safe to retry.              |
| `503 Service Unavailable`                       | **YES**    | Transient.                                                    |
| `504 Gateway Timeout`                           | **YES**    | Transient; downstream timed out.                              |
| Mid-stream `finish_reason: "error"`             | **MAYBE**  | Depends on `error.code`. If upstream `rate_limited` → retry with fresh connection.  |
| Network errors                                  | **YES**    | Same as Anthropic.                                            |

Source: <https://openrouter.ai/docs/api/reference/errors-and-debugging>.

### 8.2 Differences from Anthropic

- **`402 payment required` exists.** Direct Anthropic does not have this
  code; OR users can run out of prepaid credit. Jellyclaw treats 402 as
  fatal-non-retryable and surfaces a credit-balance-low error explicitly.
- **Multi-provider error aggregation.** When OR fails over internally
  between downstream providers (allowed unless
  `provider.allow_fallbacks: false`), the final error body may be the
  union of provider-level errors. jellyclaw logs the raw body verbatim on
  OR failures — parsing is best-effort.
- **`X-Generation-Id` on every response.** On retries, capture and log the
  new id each attempt — each attempt is a separate generation in OR's
  billing.
- **Mid-stream errors look different.** Anthropic sends an `event: error`
  SSE frame with a structured error payload. OR sends a final chunk with
  `finish_reason: "error"` plus an `error` field in the JSON. jellyclaw's
  OR wrapper detects both shapes.

### 8.3 Retry budget

Same numbers as Anthropic (3 attempts, 30s budget, exponential with
jitter). Document this as identical to avoid two code paths with subtly
different knobs.

---

## 9. Credential pooling

### 9.1 Pattern — `ANTHROPIC_API_KEY_1..N`

Jellyclaw supports optional round-robin across multiple Anthropic API keys
to smooth over per-key rate limits:

```sh
export ANTHROPIC_API_KEY_1=sk-ant-xxx
export ANTHROPIC_API_KEY_2=sk-ant-yyy
export ANTHROPIC_API_KEY_3=sk-ant-zzz
```

Resolution order:
1. Config file `anthropic.apiKey` (single) — if set, pooling off.
2. Environment `ANTHROPIC_API_KEY` (single) — if set, pooling off.
3. Environment `ANTHROPIC_API_KEY_1..N` scan (N until first gap) — if
   ≥2 keys found, pooling ON.
4. If only `_1` is set without `_2`, treat as single-key (pooling off).

### 9.2 Rotation policy

- **Round-robin** on successful calls (token-bucketless; every call
  advances the pointer).
- **On 429 with `Retry-After`**: rotate to the next key immediately and
  retry the same call. If *all* keys have been tried in the current retry
  budget, treat as exhausted → router falls over to secondary provider.
- **On 401**: mark that single key as dead for the process lifetime
  (bad key); continue rotating through remaining keys. Log a warning.
- **On non-retryable errors** (400, 403, 413): do not rotate — it's a
  request-shape issue, not a key issue. Fail fast.

### 9.3 OpenRouter pooling

Mirror the same pattern on `OPENROUTER_API_KEY_1..N`. Same rules. The
router does not mix pools across providers.

### 9.4 Off by default

The default configuration (single env var, single config field) **disables
pooling**. Pooling kicks in only when multiple numbered keys are present.
This matches the user's expectation that a fresh install with one key
behaves like any other SDK.

### 9.5 Telemetry

When pooling is active, tag each outbound call with `credentialSlot: N`
(1-indexed, not the key itself). Rotation events emit
`provider.credential.rotated` to the telemetry bus (opt-in per SPEC §12).

Keys themselves MUST be redacted by the `pino` logger. Existing redact
list in `engine/src/logger.ts` already handles `apiKey`; add
`ANTHROPIC_API_KEY_*` and `OPENROUTER_API_KEY_*` env var names to the
redact list during Phase 02 if not already present.

---

## 10. Decision: `acknowledgeCachingLimits` gate

### 10.1 What the gate is

A boolean config flag (default `false`) that **prevents the provider
router from dispatching any `anthropic/*` model via OpenRouter** unless
the user explicitly acknowledges the caching regressions by flipping it
to `true` in config, or passing `--acknowledge-caching-limits` on the CLI
for that invocation.

### 10.2 Why

The Ghost-Treasury-style blow-up story: someone sets
`OPENROUTER_API_KEY`, writes `model: "anthropic/claude-sonnet-4.6"` in
config, runs a long session, and at the end of the month realizes they
paid 8× what they expected because every cache breakpoint was stripped
(§7.1) and every cache-creation write was billed at base rate plus OR
markup. This gate makes that scenario unreachable by default.

The flag name — `acknowledgeCachingLimits` — is deliberately long and
explicit. No ambiguity at the config site: you are signing up for broken
caching.

### 10.3 Decision table — provider × model-vendor × gate-state → action

Columns:
- **Provider** is the resolved provider (after `--provider` / config /
  heuristic).
- **Model vendor** is the first slug segment of the model ID:
  `anthropic/...` → `anthropic`; `claude-...` (bare) → `anthropic` (via
  SPEC §6.3 rule 3); `google/...`, `qwen/...`, `llama/...`, etc. →
  `other`.
- **Gate** is the boolean `acknowledgeCachingLimits`.

| Provider     | Model vendor | Gate      | Action                                                                                       |
|--------------|--------------|-----------|----------------------------------------------------------------------------------------------|
| `anthropic`  | `anthropic`  | any       | **Proceed.** Full cache_control. This is the happy path.                                     |
| `anthropic`  | `other`      | any       | **Reject at config load.** Config is invalid — cannot route non-Anthropic via Anthropic SDK. Exit code 4. |
| `openrouter` | `other`      | any       | **Proceed.** Strip cache_control (§7.3). No warning beyond the one-time OR banner.           |
| `openrouter` | `anthropic`  | `false`   | **Reject at config load / CLI.** Print hard error with remediation text. Exit code 4.        |
| `openrouter` | `anthropic`  | `true`    | **Proceed.** Strip cache_control (§7.3). Emit the SPEC §6.2 warning once per process.        |

### 10.4 Hard-error text when the gate blocks a run

```
[jellyclaw] Refusing to dispatch model 'anthropic/claude-sonnet-4.6'
            via the OpenRouter provider with caching disabled.

            Known problems on this route (see engine/provider-research-notes.md §7):
              * Issue #1245 — cache_control is silently stripped in transit.
                Result: cache_read_input_tokens stays 0. Typical cost
                impact: 4-10× higher billing vs direct Anthropic.
              * Issue #17910 — OAuth-authenticated OpenRouter accounts
                return HTTP 400 on any request with cache_control since
                2026-03-17.

            To proceed anyway, either:
              * switch to --provider anthropic (recommended), OR
              * set "acknowledgeCachingLimits": true in your jellyclaw
                config, OR
              * pass --acknowledge-caching-limits on the CLI.

Exit code: 4 (config validation failure).
```

### 10.5 Where this lands in the schema

`engine/src/config/schema.ts` (Phase 02, Step 1) adds:

```ts
acknowledgeCachingLimits: z.boolean().default(false);
```

under the top-level `Config` object (not under `cache` — the flag is a
safety gate, not a cache knob).

### 10.6 What this gate does NOT do

- It does not prevent the user from picking a bad config via CLI flag
  `--provider openrouter --model anthropic/claude-sonnet-4.6
  --acknowledge-caching-limits`. That's an informed choice.
- It does not affect non-Anthropic-via-OR calls in any way. Gemini, Qwen,
  Llama etc. route via OR freely.
- It does not try to detect OR OAuth vs API key auth — see §7.2. We
  pessimistically assume OAuth is in play (worst case for #17910) and
  strip cache_control unconditionally on OR.

---

## Appendix A — Anthropic SDK version pin

SPEC §15 pins `@anthropic-ai/sdk` at `^0.40.0`, installed in Phase 01.
All code examples in this note assume that version line.

API changes worth flagging for upgrade vigilance:
- `setRequestOptions({...})` vs passing options directly as the first
  argument — the latter was removed in a recent minor. If we bump past
  `^0.40.0`, grep for any direct-first-arg pattern in `engine/src/`.
- Error class `instanceof` chains stayed backward compatible through the
  0.3x → 0.4x line but are worth re-verifying on bump.
- `messages.stream()` vs `messages.create({stream: true})`: the former is
  a helper that returns a `MessageStream` with accumulation methods; the
  latter returns a raw async iterable. Jellyclaw uses `.stream()`.

## Appendix B — URL reference list (for future-me)

### Anthropic
- Messages streaming: <https://platform.claude.com/docs/en/api/messages-streaming>
- Prompt caching: <https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching>
- Errors: <https://platform.claude.com/docs/en/api/errors>
- Tool use: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/implementing-tool-use>
- Fine-grained tool streaming: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming>
- Extended thinking: <https://platform.claude.com/docs/en/build-with-claude/extended-thinking>
- Versioning: <https://platform.claude.com/docs/en/api/versioning>
- TS SDK repo: <https://github.com/anthropics/anthropic-sdk-typescript>

### OpenRouter
- Chat completions API reference: <https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request>
- Streaming: <https://openrouter.ai/docs/api/reference/streaming>
- Errors: <https://openrouter.ai/docs/api/reference/errors-and-debugging>
- Parameters: <https://openrouter.ai/docs/api/reference/parameters>
- Tool calling: <https://openrouter.ai/docs/guides/features/tool-calling>
- Prompt caching guide: <https://openrouter.ai/docs/guides/best-practices/prompt-caching>

### Known OR caching issues
- sst/opencode#1245: <https://github.com/sst/opencode/issues/1245>
- anomalyco/opencode#17910: <https://github.com/anomalyco/opencode/issues/17910>
- OpenRouterTeam/ai-sdk-provider#35: <https://github.com/OpenRouterTeam/ai-sdk-provider/issues/35>
- pydantic/pydantic-ai#4392: <https://github.com/pydantic/pydantic-ai/issues/4392>
- zed-industries/zed#52576: <https://github.com/zed-industries/zed/issues/52576>
- anthropics/claude-code#46829 (cache TTL regression): <https://github.com/anthropics/claude-code/issues/46829>

### Third-party confirmations of `extended-cache-ttl-2025-04-11` header
- Spring AI: <https://spring.io/blog/2025/10/27/spring-ai-anthropic-prompt-caching-blog/>
- Continue: <https://github.com/continuedev/continue/issues/6135>
- Agno: <https://www.agno.com/blog/llm-response-caching-in-agno>
