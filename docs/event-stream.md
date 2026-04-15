# Event stream — authoritative reference

**Status:** Phase 03 Prompt 01 — schemas and mapping only. The runtime
adapter that produces these events lands in Prompt 02; the emitter
(`writeLine` + backpressure) lands in Prompt 03.

**Where the types live:** [`shared/src/events.ts`](../shared/src/events.ts)
— workspace package `@jellyclaw/shared`. Consumed unchanged by the
engine, the Tauri desktop app, and the Genie integration.

---

## §1 Rationale

Claude Code emits a four-event stream: `system`, `user`, `assistant`,
`result`. Claurst (the OpenCode fork Genie v1 dispatches to) emits
essentially text deltas plus a terminal `result`. Neither carries
structured tool inputs, per-call timing, subagent hierarchy, or
cache-read vs cache-create ledger.

jellyclaw's 15-variant superset gives consumers all three layers in one
stream, and provides deterministic downgrades for consumers that only
speak the two legacy formats. The discriminated union is a hard public
API — bumps in shape bump the engine major version.

The adapter (Prompt 02) always produces the full 15-event stream
internally. The emitter (Prompt 03) projects that stream onto the
requested `--output-format` at write time.

Design constraints that fell out of OpenCode's bus (`§4.6` of
`engine/opencode-research-notes.md`):

1. Upstream bus is fan-out — `message.part.updated` covers both text
   deltas and tool-use blocks. The adapter must dedupe by
   `tool_use_id`.
2. Upstream does not emit a dedicated "session started" frame; we
   synthesise `system.init` + `system.config` from the bootstrap
   response.
3. Upstream `session.error` is terminal and may arrive without a
   preceding `result`. The adapter always synthesises a `result` so
   downstream state machines can treat the stream as well-formed.
4. `server.heartbeat` (every 10s) is consumed but not forwarded — it
   keeps the TCP connection warm, nothing else.

---

## §2 The 15 events

Every event carries `type: string` (the discriminator) and `ts: number`
(unix ms; injected by the adapter's clock, never `new Date()`).
Non-terminal events additionally carry `session_id: string`.

### 2.1 `system.init`

**Shape:** `{ session_id, cwd, model, tools: string[], ts }`
**When:** Exactly once, before every other event in a session.
Synthesised after the bootstrap `POST /session` response confirms a new
session id; the `tools` array is the union of built-in OpenCode tools,
MCP tools, and skill-provided tools.

### 2.2 `system.config`

**Shape:** `{ config: RedactedConfig, ts }`
**When:** Immediately after `system.init`. Payload is the
resolved-config snapshot passed through `redactConfig()`; §6 enumerates
what gets scrubbed.

### 2.3 `user`

**Shape:** `{ session_id, content: string | Block[], ts }`
**When:** Each user turn. For the CLI this is the prompt; for the HTTP
server this is each `POST /session/:id/prompt` body. `Block[]` carries
structured input (tool results, images, etc.) when present.

### 2.4 `assistant.delta`

**Shape:** `{ session_id, text, ts }`
**When:** Every streamed token/chunk from the model. Coalesced into the
terminal `assistant.message.message.content` by the emitter in
`claude-code-compat`.

### 2.5 `assistant.message`

**Shape:** `{ session_id, message: Message, usage: Usage, ts }`
**When:** At the end of each assistant turn, after all deltas and tool
calls have flushed. `usage` is the per-turn token + cost ledger (see
§2.14 for the rolling roll-up).

### 2.6 `tool.call.start`

**Shape:** `{ session_id, tool_use_id, name, input, subagent_path, ts }`
**When:** When the assistant commits a tool call (input is finalised
JSON). `subagent_path` is the chain of subagent names up to the caller
— `[]` for a root-session call, `["researcher"]` for a call made inside
the `task(researcher)` subagent, `["researcher", "web"]` for a nested
one. The adapter buffers this frame until it can guarantee it precedes
the matching `.end`.

### 2.7 `tool.call.delta`

**Shape:** `{ session_id, tool_use_id, partial_json, ts }`
**When:** Optional — reserved for tools that emit streaming JSON
progress before the final result. v1.4.5 OpenCode does not emit these
for built-in tools; MCP tools that declare streaming support may.

### 2.8 `tool.call.end`

**Shape:** `{ session_id, tool_use_id, result?, error?, duration_ms, ts }`
**When:** When the tool's `execute()` returns (success → `result`
populated, failure → `error` populated). `tool_use_id` always matches a
prior `tool.call.start` in the same session. `duration_ms` is measured
start→end by the adapter; not trusted from upstream.

### 2.9 `subagent.start`

**Shape:** `{ session_id, agent_name, parent_id, allowed_tools, ts }`
**When:** When the `task` tool spawns a subagent (Phase 06). The
`session_id` is the subagent's session; `parent_id` is the caller's
session id. The adapter guarantees this frame precedes any tool event
inside the subagent.

### 2.10 `subagent.end`

**Shape:** `{ session_id, summary, usage, ts }`
**When:** When the subagent's final assistant turn completes. `summary`
is the text passed back to the parent session as the `task` tool's
result.

### 2.11 `hook.fire`

**Shape:** `{ session_id, event, decision, stdout, stderr, ts }`
**When:** Each time the permission / tool / chat hook pipeline fires.
`event` is the hook trigger (`tool.execute.before`, etc.); `decision`
is `allow` | `deny` | `ask` | `noop`; `stdout`/`stderr` are the captured
hook command output, truncated to 4KB each.

### 2.12 `permission.request`

**Shape:** `{ session_id, tool, rule_matched, action, ts }`
**When:** Each tool invocation the permission engine evaluates.
`rule_matched` is the first rule in the ruleset that matched; `action`
is the resolved decision after hook interaction.

### 2.13 `session.update`

**Shape:** `{ session_id, patch, ts }`
**When:** Todos mutated, session memory patched, or OpenCode publishes
`session.updated` on the bus. `patch` is the diff shape described in
`engine/SPEC.md` §11.

### 2.14 `cost.tick`

**Shape:** `{ session_id, usage: Usage, ts }`
**When:** At each assistant turn boundary — the rolling session total,
not the per-turn delta. Consumers that track live spend display this;
`assistant.message.usage` is the per-turn value.

### 2.15 `result`

**Shape:** `{ session_id, status, stats: { turns, tools_called, duration_ms }, ts }`
**When:** Exactly once per session, terminal. `status` is `"success"` |
`"error"` | `"cancelled"` | `"max_turns"`. The adapter synthesises a
`result` even if OpenCode disposes the session without one (upstream
`global.disposed` → synthetic `result{status:"cancelled"}`).

---

## §3 Upstream mapping table

OpenCode event frames observed on `GET /event` (see
`engine/opencode-research-notes.md` §4.6). Sample frames live at
`test/golden/opencode-raw-samples.jsonl` when captured from a live
server; the schema-only table below is authoritative.

| OpenCode event             | Key discriminator in `properties`  | jellyclaw event(s)                     | Transformation notes                                                                                                                             |
| -------------------------- | ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server.connected`         | —                                  | *(dropped)*                            | Adapter uses this only to confirm the subscription is live.                                                                                       |
| `server.heartbeat`         | —                                  | *(dropped)*                            | Keep-alive; not forwarded.                                                                                                                        |
| `global.disposed`          | —                                  | `result` (synthetic)                    | Only emitted if no prior `result` was already produced. `status = "cancelled"`.                                                                   |
| `session.updated`          | `info.id`, `info.title`            | `session.update`                        | `patch` field carries the upstream `info` diff verbatim.                                                                                          |
| `session.error`            | `sessionID`, `error`               | `result` (synthetic) + `assistant.message`? | Error string goes into a synthetic `result{status:"error"}`. If a partial assistant turn was streaming, a final `assistant.message` is flushed first. |
| `message.updated`          | `info.id`, `info.role`             | `assistant.message` (on `role:"assistant"`) | Emitted at the close of an assistant turn — the adapter coalesces the preceding deltas' usage into this frame.                                     |
| `message.part.updated` (text)        | `part.type:"text"`                 | `assistant.delta`                       | Passthrough text chunk. Adapter dedupes by `(messageID, partID)` offset so replayed frames don't double-emit.                                       |
| `message.part.updated` (tool-use)    | `part.type:"tool-use"`             | `tool.call.start` + optional `tool.call.delta` | First seen `(messageID, partID)` → `.start`; subsequent input-delta chunks → `.delta`. Once `part.input` is complete, adapter releases `.start`.    |
| `message.part.updated` (tool-result) | `part.type:"tool-result"`          | `tool.call.end`                         | `result` = `part.output`; if `part.isError`, promote to `error`. `duration_ms` measured by adapter, not trusted from upstream.                      |
| `tool.permission.ask`      | `callID`, `tool`                   | `permission.request{action:"ask"}`      | Adapter forwards; the separate `allow`/`deny` events come from the jellyclaw permission engine (Phase 08), not from upstream.                       |
| `project.updated`          | `project`                          | *(dropped)*                             | Not relevant to a single-session stream.                                                                                                            |
| *(jellyclaw-native)* `tool.execute.before` (plugin hook) | `tool`, `agent` | `hook.fire{event:"tool.execute.before"}` | Produced by `engine/src/plugin/agent-context.ts` (Phase 01). Adapter forwards the envelope.                                                          |
| *(jellyclaw-native)* `tool.execute.after`  (plugin hook) | `tool`, `agent` | `hook.fire{event:"tool.execute.after"}`  | Same.                                                                                                                                               |
| *(jellyclaw-native)* permission decision  | —                                 | `permission.request{action:"allow"\|"deny"}` | Produced by the permission engine (Phase 08) once the ask/hook round-trip resolves.                                                                  |
| *(jellyclaw-native)* task-tool spawn      | —                                 | `subagent.start`                        | Emitted by the task-tool wrapper (Phase 06) before the child session starts streaming.                                                               |
| *(jellyclaw-native)* task-tool return     | —                                 | `subagent.end`                          | Emitted when the child session finishes.                                                                                                             |
| *(jellyclaw-native)* usage roll-up        | —                                 | `cost.tick`                             | Emitted at each assistant turn boundary by the adapter, from the running ledger.                                                                     |

No upstream event is silently dropped without a reason in this table.

### 3.1 Live-sample capture (optional)

If the engine bootstrap is running, raw upstream frames can be captured
for regression tests via:

```sh
curl -N -H "Authorization: Bearer <token>" \
  http://127.0.0.1:<port>/event \
  | tee test/golden/opencode-raw-samples.jsonl
```

Prompt 02 replays these samples through the adapter and asserts the
15-event projection byte-for-byte after timestamp + id normalization.
This file is intentionally gitignored when empty and committed when
populated.

---

## §4 Output-format downgrades

Three wire formats. The adapter always produces the full 15-event
stream internally; the emitter consults `OUTPUT_FORMAT_EVENTS` in
[`shared/src/events.ts`](../shared/src/events.ts) to decide what to
write.

| Event                | `jellyclaw-full` | `claude-code-compat` | `claurst-min` |
| -------------------- | :--------------: | :------------------: | :-----------: |
| `system.init`        | ✅                | ✅                    | ❌             |
| `system.config`      | ✅                | ❌                    | ❌             |
| `user`               | ✅                | ✅                    | ❌             |
| `assistant.delta`    | ✅                | ⟶ coalesced           | ✅             |
| `assistant.message`  | ✅                | ✅ (text only)         | ❌             |
| `tool.call.start`    | ✅                | ❌                    | ❌             |
| `tool.call.delta`    | ✅                | ❌                    | ❌             |
| `tool.call.end`      | ✅                | ❌                    | ❌             |
| `subagent.start`     | ✅                | ❌                    | ❌             |
| `subagent.end`       | ✅                | ❌                    | ❌             |
| `hook.fire`          | ✅                | ❌                    | ❌             |
| `permission.request` | ✅                | ❌                    | ❌             |
| `session.update`     | ✅                | ❌                    | ❌             |
| `cost.tick`          | ✅                | ❌                    | ❌             |
| `result`             | ✅                | ✅                    | ✅             |

- **`claude-code-compat`** drops tool events entirely because Claude
  Code's `stream-json` mode does not include per-tool frames — tool
  activity surfaces only in the `assistant.message.content` blocks.
  `assistant.delta` is not written; the emitter buffers delta `text`
  and flushes it as the terminal `assistant.message`'s text block.
- **`claurst-min`** drops everything except text deltas and the
  terminal `result`. This matches the minimum surface Claurst's v0
  Genie dispatcher was built against; adding jellyclaw behind a Claurst
  consumer requires no dispatcher changes.

---

## §5 Ordering invariants

The schema admits any order; the adapter (Prompt 02) guarantees the
following. Tests in Prompt 02 enforce each.

1. **`system.init` is always first.** No other event emits before it.
2. **`system.config` is second.** Always immediately after
   `system.init`.
3. **`result` is terminal.** No event emits after a `result` in the
   same `session_id`. If upstream disposes without producing one, the
   adapter synthesises it.
4. **`tool.call.start` precedes `tool.call.end`** for any given
   `tool_use_id`. The adapter buffers `.end` events whose matching
   `.start` has not yet released.
5. **`subagent.start` precedes any tool event** whose `subagent_path`
   includes that subagent's name. `subagent.end` follows all of them.
6. **`ts` is monotonic per session.** Ties are permitted; regression
   is not.
7. **`assistant.message` follows all `assistant.delta`s** of the same
   turn. A new turn's deltas do not interleave with the previous
   turn's message.

---

## §6 Redaction rules for `system.config`

`redactConfig()` in [`shared/src/events.ts`](../shared/src/events.ts) is
the canonical scrubber. It is applied to the config snapshot **before**
the snapshot ever reaches the event stream.

**Key-name patterns scrubbed** (case-insensitive unless noted):

- `apiKey` (and the `api_key` / `api-key` variants)
- anything ending in `token`
- anything ending in `password`
- anything ending in `secret`
- `OPENCODE_SERVER_PASSWORD` (case-sensitive — matches the bootstrap-minted token)

**String-value patterns scrubbed** (caught even under unknown keys):

- `sk-ant-...`    — Anthropic API keys
- `sk-or-...`     — OpenRouter API keys
- `AKIA[0-9A-Z]{16}` — AWS access key IDs
- `github_pat_...` — GitHub fine-grained PATs
- `gh[pous]_...`  — GitHub legacy PATs

Tests in `shared/src/events.test.ts` cover both dimensions. `redactConfig`
is pure — it never mutates its input.

**Interaction with the logger redactor.** `engine/src/logger.ts` holds a
separate pino redact list for log output. These two lists are kept in
sync manually; the logger one is a safety net for accidental
`logger.info({ config })` calls, while `redactConfig` is the load-bearing
scrubber for the event stream itself.

---

## §7 Future work (out of scope for Phase 03 Prompt 01)

- Compression / framing for long-lived HTTP-SSE transport (Phase 10).
- Event-stream persistence to SQLite for `--resume` replay (Phase 09).
- Tracing-span correlation — each event gets a `trace_id` injected by
  the observability layer (Phase 14).
