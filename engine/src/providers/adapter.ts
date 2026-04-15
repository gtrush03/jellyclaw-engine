/**
 * Pure translator from `ProviderChunk` (raw Anthropic SDK stream events)
 * to `AgentEvent[]`. Stateful across chunks via `AdapterState`, but
 * otherwise deterministic: same state + same chunk + same `now` always
 * produces the same events and state transition. No I/O, no `Date.now()`.
 *
 * Owns the monotonic `seq` counter for the session. `session.started` is
 * emitted exactly once (on the first `message_start`).
 *
 * See `phases/PHASE-99-unfucking.md` prompt 01 for the mapping table.
 */

import type { AgentEvent } from "../events.js";
import type { ProviderChunk } from "./types.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface AdapterStateOptions {
  sessionId: string;
  model: string;
  wish: string;
  agent: string;
  cwd: string;
  provider: "anthropic" | "openrouter";
}

export interface AdapterState {
  readonly sessionId: string;
  readonly model: string;
  readonly wish: string;
  readonly agent: string;
  readonly cwd: string;
  readonly provider: "anthropic" | "openrouter";
  seq: number;
  textBuffer: string;
  thinkingBuffer: string;
  /** Keyed by content block index (NOT tool id). The `id` is only on start. */
  pendingTools: Map<number, { id: string; name: string; inputJson: string }>;
  emittedSessionStarted: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  stopReason?: string;
}

export function createAdapterState(opts: AdapterStateOptions): AdapterState {
  return {
    sessionId: opts.sessionId,
    model: opts.model,
    wish: opts.wish,
    agent: opts.agent,
    cwd: opts.cwd,
    provider: opts.provider,
    seq: 0,
    textBuffer: "",
    thinkingBuffer: "",
    pendingTools: new Map(),
    emittedSessionStarted: false,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envelope(
  state: AdapterState,
  now: number,
): {
  session_id: string;
  ts: number;
  seq: number;
} {
  return {
    session_id: state.sessionId,
    ts: now,
    seq: state.seq++,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// Chunk handlers
// ---------------------------------------------------------------------------

function handleMessageStart(
  state: AdapterState,
  chunk: ProviderChunk,
  now: number,
  out: AgentEvent[],
): void {
  // Usage snapshot from message_start.usage (initial input-token tally).
  const message = isRecord(chunk.message) ? chunk.message : undefined;
  const usage = message && isRecord(message.usage) ? message.usage : undefined;
  if (usage) {
    const input = num(usage.input_tokens);
    if (input !== undefined) state.inputTokens = input;
    const cacheRead = num(usage.cache_read_input_tokens);
    if (cacheRead !== undefined) state.cacheReadTokens = cacheRead;
    const cacheWrite = num(usage.cache_creation_input_tokens);
    if (cacheWrite !== undefined) state.cacheWriteTokens = cacheWrite;
  }

  if (!state.emittedSessionStarted) {
    state.emittedSessionStarted = true;
    out.push({
      type: "session.started",
      ...envelope(state, now),
      wish: state.wish,
      agent: state.agent,
      model: state.model,
      provider: state.provider,
      cwd: state.cwd,
    });
  }
}

function handleContentBlockStart(state: AdapterState, chunk: ProviderChunk): void {
  const index = num(chunk.index);
  const block = isRecord(chunk.content_block) ? chunk.content_block : undefined;
  if (index === undefined || block === undefined) return;
  const blockType = str(block.type);

  if (blockType === "text") {
    // Fresh text block: clear buffer. IGNORE pre-accumulated `text` from SDK.
    state.textBuffer = "";
    return;
  }
  if (blockType === "tool_use") {
    const id = str(block.id) ?? "";
    const name = str(block.name) ?? "";
    // IGNORE pre-accumulated `input` object — rebuild from input_json_delta.
    state.pendingTools.set(index, { id, name, inputJson: "" });
    return;
  }
  if (blockType === "thinking") {
    state.thinkingBuffer = "";
    return;
  }
  // Unknown block type: ignore (forward-compat).
}

function handleContentBlockDelta(
  state: AdapterState,
  chunk: ProviderChunk,
  now: number,
  out: AgentEvent[],
): void {
  const index = num(chunk.index);
  const delta = isRecord(chunk.delta) ? chunk.delta : undefined;
  if (index === undefined || delta === undefined) return;
  const deltaType = str(delta.type);

  if (deltaType === "text_delta") {
    const text = str(delta.text) ?? "";
    state.textBuffer += text;
    out.push({
      type: "agent.message",
      ...envelope(state, now),
      delta: text,
      final: false,
    });
    return;
  }

  if (deltaType === "input_json_delta") {
    const partial = str(delta.partial_json) ?? "";
    const pending = state.pendingTools.get(index);
    if (pending) pending.inputJson += partial;
    return;
  }

  if (deltaType === "thinking_delta") {
    const text = str(delta.thinking) ?? str(delta.text) ?? "";
    state.thinkingBuffer += text;
    out.push({
      type: "agent.thinking",
      ...envelope(state, now),
      delta: text,
    });
    return;
  }

  if (deltaType === "signature_delta") {
    const sig = str(delta.signature) ?? "";
    out.push({
      type: "agent.thinking",
      ...envelope(state, now),
      delta: "",
      signature: sig,
    });
    return;
  }
  // Unknown delta type: drop silently.
}

function handleContentBlockStop(
  state: AdapterState,
  chunk: ProviderChunk,
  now: number,
  out: AgentEvent[],
): void {
  const index = num(chunk.index);
  if (index === undefined) return;

  // Tool block? pendingTools has it by index.
  const pending = state.pendingTools.get(index);
  if (pending) {
    state.pendingTools.delete(index);
    const raw = pending.inputJson;
    let parsed: unknown;
    if (raw.length === 0) {
      // Anthropic emits tools with no arguments as an empty partial_json
      // stream; treat as an empty-object input.
      parsed = {};
    } else {
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        out.push({
          type: "tool.error",
          ...envelope(state, now),
          tool_id: pending.id,
          tool_name: pending.name,
          code: "invalid_input",
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
    out.push({
      type: "tool.called",
      ...envelope(state, now),
      tool_id: pending.id,
      tool_name: pending.name,
      input: parsed,
    });
    return;
  }

  // Otherwise it's a text (or thinking) block. Flush if we have text.
  if (state.textBuffer.length > 0) {
    out.push({
      type: "agent.message",
      ...envelope(state, now),
      delta: "",
      final: true,
    });
    state.textBuffer = "";
  }
}

function handleMessageDelta(
  state: AdapterState,
  chunk: ProviderChunk,
  now: number,
  out: AgentEvent[],
): void {
  const usage = isRecord(chunk.usage) ? chunk.usage : undefined;
  if (usage) {
    const output = num(usage.output_tokens);
    if (output !== undefined) state.outputTokens = output;
    const input = num(usage.input_tokens);
    if (input !== undefined) state.inputTokens = input;
    const cacheRead = num(usage.cache_read_input_tokens);
    if (cacheRead !== undefined) state.cacheReadTokens = cacheRead;
    const cacheWrite = num(usage.cache_creation_input_tokens);
    if (cacheWrite !== undefined) state.cacheWriteTokens = cacheWrite;
  }
  const delta = isRecord(chunk.delta) ? chunk.delta : undefined;
  const stop = delta ? str(delta.stop_reason) : undefined;
  if (stop !== undefined) state.stopReason = stop;

  out.push({
    type: "usage.updated",
    ...envelope(state, now),
    input_tokens: state.inputTokens,
    output_tokens: state.outputTokens,
    cache_read_tokens: state.cacheReadTokens,
    cache_write_tokens: state.cacheWriteTokens,
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function adaptChunk(state: AdapterState, chunk: ProviderChunk, now: number): AgentEvent[] {
  const out: AgentEvent[] = [];
  switch (chunk.type) {
    case "message_start":
      handleMessageStart(state, chunk, now, out);
      break;
    case "content_block_start":
      handleContentBlockStart(state, chunk);
      break;
    case "content_block_delta":
      handleContentBlockDelta(state, chunk, now, out);
      break;
    case "content_block_stop":
      handleContentBlockStop(state, chunk, now, out);
      break;
    case "message_delta":
      handleMessageDelta(state, chunk, now, out);
      break;
    case "message_stop":
      // No emission: agent loop decides session boundary from stop_reason.
      break;
    default:
      // Forward-compat: drop unknown chunk types silently, seq unchanged.
      break;
  }
  return out;
}

/**
 * Emit a `session.completed` envelope. Caller owns turn count + duration.
 */
export function adaptDone(
  state: AdapterState,
  opts: { turns: number; duration_ms: number; summary?: string; now: number },
): AgentEvent {
  return {
    type: "session.completed",
    session_id: state.sessionId,
    ts: opts.now,
    seq: state.seq++,
    turns: opts.turns,
    duration_ms: opts.duration_ms,
    ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
  };
}
