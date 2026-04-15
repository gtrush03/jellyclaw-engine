# Phase 99 — Unfucking — Prompt 04: Claude-Code-compatible stream-json writer

**When to run:** After 99-03 (`jellyclaw run` works against real Anthropic).
**Estimated duration:** ~120 minutes
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
<!-- Use /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- Phase doc: /Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-99-unfucking.md -->
<!-- Working API key: <REDACTED_API_KEY> -->
<!-- END SESSION STARTUP -->

---

## Pre-flight — confirm starting state

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
# 1. 99-03 must be done. `jellyclaw run` should emit a real model reply, not "[phase-0 stub]".
export ANTHROPIC_API_KEY='<REDACTED_API_KEY>'
node engine/dist/cli/main.js run --output-format stream-json "say pong" | head
# Expect at least one agent.message frame with "delta" containing "pong". If you still see "[phase-0 stub]", STOP — 99-03 not landed.

# 2. Fixture A already captured — confirm.
ls -la engine/test/fixtures/claude-compat/A-text.claude.ndjson
wc -l engine/test/fixtures/claude-compat/A-text.claude.ndjson  # should be > 3 lines

# 3. `claude` must be on $PATH to capture fixtures B and C (tool call + error).
which claude && claude --version
# If claude is NOT installed, skip Step "Capture fixtures" and use A + the synthetic
# fixtures documented at end of this file.
```

## Why this exists

Jelly-Claw's `genie-server/src/core/dispatcher.mjs:684` spawns `claude -p --output-format stream-json` and parses Claude Code's specific NDJSON event shapes. To swap the engine, jellyclaw must emit identical-shape events on stdout under a new `--output-format claude-stream-json` flag. Then the dispatcher swap is a one-line change (Prompt 07).

## Captured fixture — real `claude -p` NDJSON (A-text scenario)

Captured April 15 2026 with `claude --version 2.1.109`, command:
```bash
claude -p --output-format stream-json --max-turns 1 --verbose "say pong"
```

Result written to `engine/test/fixtures/claude-compat/A-text.claude.ndjson` (6 lines). The important shapes the dispatcher consumes:

**Line 1 — hook_started** (optional, depends on user's local claude config — safe to DROP in jellyclaw output):
```json
{"type":"system","subtype":"hook_started","hook_id":"…","hook_name":"SessionStart:startup","hook_event":"SessionStart","uuid":"…","session_id":"…"}
```

**Line 2 — hook_response** (optional, DROP):
```json
{"type":"system","subtype":"hook_response","hook_id":"…","exit_code":0,"outcome":"success","uuid":"…","session_id":"…"}
```

**Line 3 — `system.init`** (REQUIRED first meaningful line, dispatcher keys off this):
```json
{"type":"system","subtype":"init","cwd":"/Users/gtrush/Downloads/jellyclaw-engine","session_id":"218f9985-…","tools":["Task","AskUserQuestion","Bash",…],"mcp_servers":[{"name":"…","status":"connected"}],"model":"claude-opus-4-6[1m]","permissionMode":"dontAsk","slash_commands":[…],"apiKeySource":"none","claude_code_version":"2.1.109","output_style":"default","agents":[…],"skills":[…],"plugins":[…],"uuid":"…","memory_paths":{"auto":"…"},"fast_mode_state":"off"}
```

Minimum jellyclaw-emitted init shape (dispatcher only reads a subset):
```json
{"type":"system","subtype":"init","session_id":"<uuid>","model":"<model>","cwd":"<abs>","tools":["Bash","Read","Write"],"permissionMode":"default","apiKeySource":"env","claude_code_version":"jellyclaw-0.0.0","mcp_servers":[],"slash_commands":[],"agents":[],"skills":[],"plugins":[]}
```

**Line 4 — `assistant` message** (REQUIRED, carries the model's text/tool_use blocks):
```json
{"type":"assistant","message":{"model":"claude-opus-4-6","id":"msg_01…","type":"message","role":"assistant","content":[{"type":"text","text":"pong"}],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":3,"cache_creation_input_tokens":33014,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":33014},"output_tokens":1,"service_tier":"standard","inference_geo":"not_available"},"context_management":null},"parent_tool_use_id":null,"session_id":"218f9985-…","uuid":"…"}
```

**Line 5 — rate_limit_event** (optional, DROP):
```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":…,"rateLimitType":"seven_day","utilization":0.27,"isUsingOverage":false},"uuid":"…","session_id":"…"}
```

**Line 6 — `result`** (REQUIRED terminal frame, dispatcher reads `result`, `total_cost_usd`, `num_turns`, `duration_ms`, `usage`, `modelUsage`, `permission_denials`, `terminal_reason`, `is_error`):
```json
{"type":"result","subtype":"success","is_error":false,"duration_ms":6711,"duration_api_ms":2472,"num_turns":1,"result":"pong","stop_reason":"end_turn","session_id":"218f9985-…","total_cost_usd":0.2064775,"usage":{"input_tokens":3,"cache_creation_input_tokens":33014,"cache_read_input_tokens":0,"output_tokens":5,"server_tool_use":{…},"service_tier":"standard","cache_creation":{…},"inference_geo":"","iterations":[{…}],"speed":"standard"},"modelUsage":{"claude-opus-4-6[1m]":{…}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","uuid":"…"}
```

**Minimum required jellyclaw result shape:**
```json
{"type":"result","subtype":"success","is_error":false,"duration_ms":<n>,"num_turns":<n>,"result":"<final-text>","stop_reason":"end_turn","session_id":"<uuid>","total_cost_usd":<n>,"usage":{"input_tokens":<n>,"output_tokens":<n>,"cache_read_input_tokens":<n>,"cache_creation_input_tokens":<n>},"permission_denials":[],"terminal_reason":"completed"}
```

## Capture the remaining fixtures (B and C)

```bash
# Scenario B — single tool use (Bash)
claude -p --output-format stream-json --allowedTools Bash --max-turns 3 "run: ls /tmp | head -3 then summarize" \
  > engine/test/fixtures/claude-compat/B-tool.claude.ndjson

# Scenario C — tool error
claude -p --output-format stream-json --allowedTools Bash --max-turns 3 "run: thiscommanddoesnotexist then report what happened" \
  > engine/test/fixtures/claude-compat/C-tool-error.claude.ndjson
```

If `claude` is not installed on this machine, skip these and either (a) have George capture them from a machine with `claude` installed and commit them, or (b) author synthetic fixtures based on the assistant+tool_use+tool_result shape documented in `Jelly-Claw/genie-server/src/core/dispatcher.mjs`.

Capture equivalent jellyclaw events for the same prompts using JSON output format, to use as AgentEvent-input fixtures to the writer:

```bash
node engine/dist/cli/main.js run "say pong" --output-format json > engine/test/fixtures/claude-compat/A-text.jellyclaw.json
# repeat for B, C once the loop supports tools
```

## Files to read first

1. `/Users/gtrush/Downloads/Jelly-Claw/genie-server/src/core/dispatcher.mjs` lines 453-470 (`handleEvent`) and 798-810 (NDJSON line parser) — the EXACT event shapes the dispatcher consumes.
2. `/Users/gtrush/Downloads/Jelly-Claw/genie-server/src/core/dispatcher.mjs` lines 659-687 — current spawn args.
3. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/output.ts` — current `createOutputWriter`.
4. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/output-types.ts` — `OutputFormat` union. **Today this is `"stream-json" | "text" | "json"`. Add `"claude-stream-json"`.**
5. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/run.ts` — flag wiring. Flag name: `--output-format` (already exists).
6. `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/events.ts` — AgentEvent variants.

## Current OutputWriter interface (observed, do NOT break)

Verified via `node engine/dist/cli/main.js run --output-format <fmt> "say pong"`:

- `stream-json`: one AgentEvent per line as JSON (shape: `{type,session_id,ts,seq,...}`), terminal `session.completed` event. One trailing `\n` per object.
- `text`: assistant message `delta` text printed raw to stdout. No framing.
- `json`: single JSON blob `{session_id, transcript: AgentEvent[], usage, summary}` after all events buffered.

Extend with:
- `claude-stream-json`: one Claude Code NDJSON frame per line (see shapes above). First frame `system.init`, last frame `type:"result"`.

## Build

### Step A — Writer

Create `engine/src/cli/output-claude-stream-json.ts`:

```ts
import type { AgentEvent } from "../events.js";
import type { OutputWriter } from "./output-types.js";

interface TextBlock { type: "text"; text: string }
interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
type ContentBlock = TextBlock | ToolUseBlock;

export class ClaudeStreamJsonWriter implements OutputWriter {
  private bufferedText = "";
  private assistantBlocks: ContentBlock[] = [];
  private finalText = "";
  private costSum = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheRead = 0;
  private cacheCreate = 0;
  private turnCount = 0;
  private sessionId: string | null = null;
  private model = "";
  private startTs = 0;

  constructor(
    private out: NodeJS.WriteStream,
    private opts: { cwd: string; tools: string[]; permissionMode?: string }
  ) {}

  handle(evt: AgentEvent): void {
    switch (evt.type) {
      case "session.started":
        this.sessionId = evt.session_id;
        this.model = evt.model;
        this.startTs = evt.ts;
        this.write({
          type: "system",
          subtype: "init",
          cwd: this.opts.cwd,
          session_id: evt.session_id,
          tools: this.opts.tools,
          model: evt.model,
          permissionMode: this.opts.permissionMode ?? "default",
          apiKeySource: "env",
          claude_code_version: "jellyclaw-0.0.0",
          mcp_servers: [],
          slash_commands: [],
          agents: [],
          skills: [],
          plugins: [],
        });
        break;
      case "agent.message":
        if (evt.final) this.flushAssistantText(evt.delta);
        else this.bufferedText += evt.delta;
        break;
      case "tool.called":
        // If text exists + tool starts: flush text + tool_use in same assistant message.
        this.appendToolUse(evt);
        break;
      case "tool.result":
      case "tool.error":
        this.write({
          type: "user",
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: evt.id,
              content: "result" in evt ? evt.result : evt.error,
              is_error: evt.type === "tool.error",
            }],
          },
          session_id: this.sessionId,
        });
        break;
      case "usage.updated":
        this.inputTokens += evt.input_tokens ?? 0;
        this.outputTokens += evt.output_tokens ?? 0;
        this.cacheRead += evt.cache_read_tokens ?? 0;
        this.cacheCreate += evt.cache_write_tokens ?? 0;
        this.costSum = evt.cost_usd ?? this.costSum;
        break;
      case "session.completed":
        if (this.bufferedText.length > 0) this.flushAssistantText(this.bufferedText);
        this.write({
          type: "result",
          subtype: "success",
          is_error: false,
          duration_ms: evt.duration_ms,
          num_turns: evt.turns ?? this.turnCount,
          result: this.finalText,
          stop_reason: "end_turn",
          session_id: this.sessionId,
          total_cost_usd: this.costSum,
          usage: {
            input_tokens: this.inputTokens,
            output_tokens: this.outputTokens,
            cache_read_input_tokens: this.cacheRead,
            cache_creation_input_tokens: this.cacheCreate,
          },
          permission_denials: [],
          terminal_reason: "completed",
        });
        break;
      case "session.error":
        this.write({
          type: "result",
          subtype: "error",
          is_error: true,
          result: "",
          error: evt.message ?? evt.code,
          session_id: this.sessionId,
          terminal_reason: "error",
        });
        break;
      // DROP: agent.thinking, permission.*, subagent.*, stream.ping, hook_*
    }
  }

  private flushAssistantText(text: string): void {
    this.finalText += text;
    this.write({
      type: "assistant",
      message: {
        model: this.model,
        id: `msg_${this.sessionId?.slice(0, 8)}_${this.turnCount}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
        stop_reason: null,
      },
      session_id: this.sessionId,
    });
    this.bufferedText = "";
    this.turnCount++;
  }

  private appendToolUse(evt: Extract<AgentEvent, { type: "tool.called" }>): void {
    this.write({
      type: "assistant",
      message: {
        model: this.model,
        id: `msg_${this.sessionId?.slice(0, 8)}_${this.turnCount}_tool`,
        type: "message",
        role: "assistant",
        content: this.bufferedText.length > 0
          ? [{ type: "text", text: this.bufferedText }, { type: "tool_use", id: evt.id, name: evt.name, input: evt.args }]
          : [{ type: "tool_use", id: evt.id, name: evt.name, input: evt.args }],
        stop_reason: null,
      },
      session_id: this.sessionId,
    });
    if (this.bufferedText.length > 0) this.finalText += this.bufferedText;
    this.bufferedText = "";
    this.turnCount++;
  }

  private write(obj: unknown): void {
    this.out.write(`${JSON.stringify(obj)}\n`); // ONE write = ONE line. Critical.
  }
}
```

### Step B — Wire flag

- Modify `engine/src/cli/output-types.ts`: extend `OutputFormat` union with `"claude-stream-json"`. Update `isOutputFormat` type guard.
- Modify `engine/src/cli/output.ts`: add case in `createOutputWriter`.
- Modify `engine/src/cli/run.ts`: no change — flag arrives via Commander already.
- Modify `engine/src/cli/cli-flags.test.ts`: cover the new value.
- Modify `engine/src/cli/main.ts`: add to `--help` description if hardcoded.

### Step C — Critical edge cases

| Case | Behavior |
|---|---|
| `agent.thinking`, `permission.*`, `subagent.*`, `stream.ping`, Claude's `hook_*`/`rate_limit_event`/`hook_response` | DROP. Optionally write to stderr behind `JELLYCLAW_DEBUG=1`. |
| `tool.called` with empty text buffer | Open new assistant message containing only `tool_use` block. |
| `tool.called` with non-empty text buffer | Flush buffered text + tool_use into ONE assistant message (Claude's interleaving pattern). |
| `usage.updated` | Accumulate, don't emit. Final cost + tokens live in `result`. |
| `session.completed` arrives without prior `session.started` | Bail loudly: write `result{subtype:"error",is_error:true,error:"missing session.started"}` and exit nonzero. |
| Final text empty | `result.result` must still be a string (empty allowed). Dispatcher's `finalResult` must not be null. |
| Multi-byte UTF-8 in tool result | `JSON.stringify` handles. Don't manually escape. |
| pino log lines on stdout | Must be fixed in 99-03 (stdout = pure NDJSON). If still broken, this format is useless — block prompt 04 on it. |

## Tests

Create `engine/src/cli/output-claude-stream-json.test.ts`:

1. Replay AgentEvent stream from jellyclaw fixture → assert NDJSON output's normalized shape (strip timestamps, uuids, round costs to 4dp) matches normalized `claude -p` fixture A.
2. Same for fixtures B and C (tool use, tool error).
3. Property test: every `tool_use_id` emitted has a matching `tool_result` frame.
4. NDJSON discipline test: every `out.write` call produces exactly one `\n`-terminated JSON object (no embedded newlines, no partial writes).
5. Order test: `system.init` is always the FIRST line of output. `result` is always LAST.
6. Integration: replay engine's stdout through `makeHandleEvent` from `dispatcher.mjs` in a vitest harness (dynamic ESM import). Assert all dispatcher callbacks fire (`onSessionInit`, `onAssistantText`, `onToolUseIncrement`, `onResult`) with same values as `claude -p` baseline.

Live smoke:
```bash
ANTHROPIC_API_KEY=<REDACTED_API_KEY> \
  node engine/dist/cli/main.js run "say pong" --output-format claude-stream-json | jq -c .
```

First line MUST be `{"type":"system","subtype":"init",...}`. Last MUST be `{"type":"result",...,"is_error":false}`. Every line MUST parse as JSON.

## Out of scope

- Don't change Jelly-Claw yet — that's prompt 07.
- Don't break existing `--output-format stream-json` (jellyclaw-native NDJSON) or `text` or `json`.
- Don't try to emit Claude's `hook_*`/`rate_limit_event` frames — they're session-local to the real Claude Code CLI and the dispatcher ignores them.

## Done when

- All test gates green
- Live smoke produces 3-line minimum NDJSON valid against Claude's schema (init → ≥1 assistant → result)
- Fixtures A (committed), B, C (committed if `claude` available) live under `engine/test/fixtures/claude-compat/`
- COMPLETION-LOG.md updated with sample output

<!-- BEGIN SESSION CLOSEOUT -->
<!-- Tag commit `phase-99-stream-json-compat`. -->
<!-- END SESSION CLOSEOUT -->
