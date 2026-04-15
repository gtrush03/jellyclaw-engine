# Phase 12 — Genie integration behind flag — Prompt 02: Event parser rewrite (15-event superset)

**When to run:** After Prompt 01 of Phase 12 lands.
**Estimated duration:** 4-5 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `12`
- `<phase-name>` → `Genie integration behind flag`
- `<sub-prompt>` → `02-event-parser-rewrite`
<!-- END SESSION STARTUP -->

## Research task

1. Read `integration/GENIE-INTEGRATION.md` §2.6 (event parser dispatch table for the 15-event superset). This is the canonical implementation.
2. Read `/Users/gtrush/Downloads/genie-2.0/src/core/dispatcher.mjs:349-398` — the current Claurst-shape `handleEvent`. You will replace this block.
3. Read `engine/SPEC.md` §11 (event stream) and `phases/PHASE-03-event-stream.md` to confirm the 15 event types jellyclaw emits: `system_init`, `system_ready`, `user_message`, `assistant_start`, `text_delta`, `thinking_delta`, `assistant_stop`, `tool_use_start`, `tool_use_delta`, `tool_use_result`, `tool_use_error`, `subagent_start`, `subagent_stop`, `usage`, `result`, `error`.
4. Read `/Users/gtrush/Downloads/genie-2.0/src/core/telegram.mjs` — confirm `sendMessage(text, {plain})` signature so the new parser doesn't break Markdown handling.

## Implementation task

Replace the 4-event Claurst-shape `handleEvent` at lines 349-398 with a dual-mode parser: when `GENIE_ENGINE === 'claurst'`, call `handleEventClaurst(evt)` (the existing implementation, kept intact); when `GENIE_ENGINE === 'jellyclaw'`, call `handleEventJellyclaw(evt)` per §2.6's switch table. The Telegram-facing behavior must be **functionally identical** for both engines on identical wishes — same number of pings per tool call, same final-receipt format, same error message shape — so downstream consumers don't notice the swap.

### Files to create/modify

- `/Users/gtrush/Downloads/genie-2.0/src/core/dispatcher.mjs` — primary edit (lines 349-398 region)
- `/Users/gtrush/Downloads/genie-2.0/src/core/event-parsers/claurst.mjs` — extract existing parser into module
- `/Users/gtrush/Downloads/genie-2.0/src/core/event-parsers/jellyclaw.mjs` — new 15-event parser per §2.6
- `/Users/gtrush/Downloads/genie-2.0/src/core/event-parsers/shared.mjs` — `summarizeToolInput`, `maybeSendTool`, `flushPending` (already in dispatcher; relocate)
- `/Users/gtrush/Downloads/genie-2.0/test/event-parser-jellyclaw.test.mjs` — fixture-driven tests
- `/Users/gtrush/Downloads/genie-2.0/test/fixtures/streams/jellyclaw-{simple,subagent,error,resume}.jsonl` — captured streams

### Edit shape

In `dispatcher.mjs`:

```js
import { makeHandleEvent as makeClaurstHandler } from './event-parsers/claurst.mjs';
import { makeHandleEvent as makeJellyclawHandler } from './event-parsers/jellyclaw.mjs';

const handlerFactory = GENIE_ENGINE === 'claurst' ? makeClaurstHandler : makeJellyclawHandler;
const handleEvent = handlerFactory({
  trace, log, sendMessage, maybeSendTool, summarizeToolInput,
  state, // { sessionId, finalResult, turns, usdCost, assistantText, toolCount, initSent }
});
```

The factory pattern keeps event handlers pure-ish; state mutation is explicit via the passed `state` object.

`event-parsers/jellyclaw.mjs` implements the switch from §2.6 verbatim, including:
- `system_init`/`system_ready` set `sessionId` from `evt.session_id`, gate `initSent`, send the spawn ping.
- `text_delta` accumulates `assistantText`.
- `thinking_delta` traced only, never sent to Telegram.
- `tool_use_start` increments `toolCount`, normalizes `mcp__playwright__` and `mcp__plugin_compound-engineering_pw__` prefixes to `pw.`, calls `summarizeToolInput`, sends throttled.
- `tool_use_error` sends warn ping with truncated error.
- `subagent_start` sends `🧩 subagent: <description>` ping.
- `subagent_stop` swallowed (parent assistant text summarizes).
- `usage` updates `usdCost`.
- `error` sends warn ping.
- `result` finalizes `finalResult`, `usdCost`, `turns`.
- `user_message`, `assistant_start`, `assistant_stop`, `tool_use_delta`, `tool_use_result` accepted silently, traced only.
- `default:` logs `unknown event type: ${t}` (this is the breakage canary — Prompt 04 acceptance requires zero of these).

### Shell commands

```bash
cd /Users/gtrush/Downloads/genie-2.0
# Capture a real jellyclaw stream into a fixture (requires jellyclaw binary from W1):
jellyclaw run --print --output-format stream-json -p "say hi" \
  > test/fixtures/streams/jellyclaw-simple.jsonl
jellyclaw run --print --output-format stream-json -p "spawn a subagent that runs pwd" \
  > test/fixtures/streams/jellyclaw-subagent.jsonl
# Run the parser tests:
node --test test/event-parser-jellyclaw.test.mjs
```

### Expected output

- `dispatcher.mjs` lines 349-398 region replaced by a 3-line factory call + import.
- New `event-parsers/jellyclaw.mjs` ≤180 lines, pure switch.
- Telegram ping count on the `simple` fixture matches Claurst's parser on the equivalent Claurst stream (compare with `wc -l` on `claurst -p "say hi" --output-format stream-json`).
- Subagent fixture produces exactly one `🧩 subagent:` ping plus the parent assistant receipt.
- Zero `unknown event type` logs across all 4 fixtures.

### Tests to add

- `event-parser-jellyclaw.test.mjs`:
  - `simple` fixture → 1 spawn ping + 1 receipt + 1 footer.
  - `subagent` fixture → ≥1 subagent ping; final receipt non-null.
  - `error` fixture → 1 `⚠️ Error` ping; `success: false`.
  - `resume` fixture → second `system_ready` does NOT re-send the spawn ping (gated by `initSent`).
- `event-parser-equivalence.test.mjs`: feed the simple Claurst fixture to its parser and the simple jellyclaw fixture to its parser; assert ping count and final-result string are equal modulo whitespace.

### Verification

```bash
cd /Users/gtrush/Downloads/genie-2.0
node --test test/event-parser-jellyclaw.test.mjs test/event-parser-equivalence.test.mjs
GENIE_ENGINE=jellyclaw node -e "
  import('./src/core/event-parsers/jellyclaw.mjs').then(m=>{
    const fs=require('fs');
    const lines=fs.readFileSync('test/fixtures/streams/jellyclaw-simple.jsonl','utf8').trim().split('\n');
    const state={initSent:false,toolCount:0,assistantText:'',sessionId:null,finalResult:null,usdCost:null,turns:null};
    const h=m.makeHandleEvent({trace:()=>{},log:console.log,sendMessage:async()=>{},maybeSendTool:async()=>{},summarizeToolInput:()=>'',state});
    Promise.all(lines.map(l=>h(JSON.parse(l)))).then(()=>console.log(state));
  });
"
```

### Common pitfalls

- **`tool_use_result` carries the actual tool output** (often huge — file contents, screenshots base64). Do NOT forward to Telegram. Trace only. Today's Claurst parser silently drops these because Claurst doesn't emit them; the jellyclaw parser must explicitly swallow.
- **`thinking_delta` leakage:** if you forward thinking to Telegram, Genie users see the model's internal reasoning. Privacy + UX disaster. Trace-only, no send.
- **`session_id` from `system_init` vs `system_ready`:** jellyclaw emits `system_init` first (config loaded) then `system_ready` (provider connected). Take `session_id` from whichever fires first; don't double-send the spawn ping.
- **MCP tool name normalization:** §2.6 strips both `mcp__playwright__` and `mcp__plugin_compound-engineering_pw__` to `pw.`. Test both — Genie has been observed to receive both prefixes depending on which MCP variant is configured.
- **`usage` events arrive multiple times** (incremental Anthropic billing). Latest wins for `usdCost`. Don't sum.
- **Don't break Claurst path:** the old handler is now `event-parsers/claurst.mjs`. Verify by re-running the existing Genie smoke wishes with `GENIE_ENGINE=claurst` — Telegram traffic must be byte-identical to pre-refactor.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `12`
- `<phase-name>` → `Genie integration behind flag`
- `<sub-prompt>` → `02-event-parser-rewrite`
- Do NOT mark Phase 12 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
