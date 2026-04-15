/**
 * Phase 99.04 — Claude-compatible stream-json writer.
 *
 * Translates jellyclaw's `AgentEvent` stream into the NDJSON frames that
 * Jelly-Claw's `genie-server/src/core/dispatcher.mjs` consumes from real
 * `claude -p --output-format stream-json`. The goal is wire-level
 * compatibility — the dispatcher should not notice the swap.
 *
 * Supported frames (one JSON object per line, terminated with `\n`):
 *   • `{type:"system",subtype:"init",…}`        — session bootstrap
 *   • `{type:"assistant",message:{content:[…]}}` — text / tool_use turns
 *   • `{type:"user",message:{content:[…]}}`      — tool_result turns
 *   • `{type:"result",subtype:"success"|"error",…}` — terminal frame
 *
 * Dropped: `agent.thinking`, `permission.*`, `subagent.*`, `stream.ping`
 * (behind `JELLYCLAW_DEBUG=1` a short note goes to stderr). We do NOT emit
 * `hook_*` or `rate_limit_event` frames — out of scope.
 */

import type { AgentEvent } from "../events.js";
import type { OutputWriter } from "./output-types.js";

// ---------------------------------------------------------------------------
// Backpressure-aware line writer (mirrors StreamJsonWriter)
// ---------------------------------------------------------------------------

function writeLine(stream: NodeJS.WritableStream, line: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const ok = stream.write(line, (err) => {
      if (err) reject(err);
    });
    if (ok) {
      resolve();
      return;
    }
    stream.once("drain", () => resolve());
  });
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output);
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ClaudeStreamJsonWriterOptions {
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly permissionMode?: string;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export class ClaudeStreamJsonWriter implements OutputWriter {
  readonly #stdout: NodeJS.WritableStream;
  readonly #cwd: string;
  readonly #tools: readonly string[];
  readonly #permissionMode: string;

  #sessionId: string | null = null;
  #model = "";
  #sessionInitialized = false;
  #terminalEmitted = false;

  #bufferedText = "";
  #finalText = "";
  #turnCount = 0;

  #inputTokens = 0;
  #outputTokens = 0;
  #cacheRead = 0;
  #cacheCreate = 0;
  #costSum = 0;

  readonly #pendingToolIds = new Set<string>();

  constructor(stdout: NodeJS.WritableStream, opts: ClaudeStreamJsonWriterOptions) {
    this.#stdout = stdout;
    this.#cwd = opts.cwd;
    this.#tools = opts.tools;
    this.#permissionMode = opts.permissionMode ?? "default";
  }

  // -------------------------------------------------------------------------
  // Public contract
  // -------------------------------------------------------------------------

  async write(event: AgentEvent): Promise<void> {
    if (this.#terminalEmitted) {
      this.#debug(`drop after terminal: ${event.type}`);
      return;
    }

    switch (event.type) {
      case "session.started":
        await this.#onSessionStarted(event);
        return;
      case "agent.message":
        await this.#onAgentMessage(event);
        return;
      case "tool.called":
        await this.#onToolCalled(event);
        return;
      case "tool.result":
        await this.#onToolResult(event);
        return;
      case "tool.error":
        await this.#onToolError(event);
        return;
      case "usage.updated":
        this.#onUsage(event);
        return;
      case "session.completed":
        await this.#onSessionCompleted(event);
        return;
      case "session.error":
        await this.#onSessionError(event);
        return;
      case "agent.thinking":
      case "permission.requested":
      case "permission.granted":
      case "permission.denied":
      case "subagent.spawned":
      case "subagent.returned":
      case "stream.ping":
        this.#debug(`drop: ${event.type}`);
        return;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
        return;
      }
    }
  }

  async finish(): Promise<void> {
    if (this.#terminalEmitted) return;
    await this.#emit({
      type: "result",
      subtype: "error",
      is_error: true,
      result: this.#finalText,
      error: "stream ended without session.completed",
      session_id: this.#sessionId,
      terminal_reason: "error",
    });
    this.#terminalEmitted = true;
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  async #onSessionStarted(ev: Extract<AgentEvent, { type: "session.started" }>): Promise<void> {
    this.#sessionId = ev.session_id;
    this.#model = ev.model;
    this.#sessionInitialized = true;
    await this.#emit({
      type: "system",
      subtype: "init",
      session_id: ev.session_id,
      model: ev.model,
      cwd: this.#cwd,
      tools: this.#tools,
      permissionMode: this.#permissionMode,
      apiKeySource: "env",
      claude_code_version: "jellyclaw-0.0.0",
      mcp_servers: [],
      slash_commands: [],
      agents: [],
      skills: [],
      plugins: [],
    });
  }

  async #onAgentMessage(ev: Extract<AgentEvent, { type: "agent.message" }>): Promise<void> {
    if (!ev.final) {
      this.#bufferedText += ev.delta;
      return;
    }
    // final: flush any buffered text as an assistant text message.
    if (this.#bufferedText.length > 0) {
      const text = this.#bufferedText;
      this.#bufferedText = "";
      this.#finalText += text;
      this.#turnCount += 1;
      await this.#emit({
        type: "assistant",
        message: {
          id: this.#assistantId(false),
          type: "message",
          role: "assistant",
          model: this.#model,
          content: [{ type: "text", text }],
          stop_reason: null,
          stop_sequence: null,
        },
        parent_tool_use_id: null,
        session_id: this.#sessionId,
      });
    }
  }

  async #onToolCalled(ev: Extract<AgentEvent, { type: "tool.called" }>): Promise<void> {
    this.#pendingToolIds.add(ev.tool_id);
    const content: unknown[] = [];
    if (this.#bufferedText.length > 0) {
      const text = this.#bufferedText;
      this.#bufferedText = "";
      this.#finalText += text;
      content.push({ type: "text", text });
    }
    content.push({
      type: "tool_use",
      id: ev.tool_id,
      name: ev.tool_name,
      input: ev.input,
    });
    this.#turnCount += 1;
    await this.#emit({
      type: "assistant",
      message: {
        id: this.#assistantId(true),
        type: "message",
        role: "assistant",
        model: this.#model,
        content,
        stop_reason: null,
        stop_sequence: null,
      },
      parent_tool_use_id: null,
      session_id: this.#sessionId,
    });
  }

  async #onToolResult(ev: Extract<AgentEvent, { type: "tool.result" }>): Promise<void> {
    this.#pendingToolIds.delete(ev.tool_id);
    await this.#emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: ev.tool_id,
            content: stringifyToolOutput(ev.output),
            is_error: false,
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: this.#sessionId,
    });
  }

  async #onToolError(ev: Extract<AgentEvent, { type: "tool.error" }>): Promise<void> {
    this.#pendingToolIds.delete(ev.tool_id);
    await this.#emit({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: ev.tool_id,
            content: ev.message,
            is_error: true,
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: this.#sessionId,
    });
  }

  #onUsage(ev: Extract<AgentEvent, { type: "usage.updated" }>): void {
    this.#inputTokens += ev.input_tokens;
    this.#outputTokens += ev.output_tokens;
    this.#cacheRead += ev.cache_read_tokens;
    this.#cacheCreate += ev.cache_write_tokens;
    if (typeof ev.cost_usd === "number") {
      this.#costSum = ev.cost_usd;
    }
  }

  async #onSessionCompleted(ev: Extract<AgentEvent, { type: "session.completed" }>): Promise<void> {
    if (!this.#sessionInitialized) {
      await this.#emit({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "",
        error: "missing session.started",
        session_id: null,
        terminal_reason: "error",
      });
      this.#terminalEmitted = true;
      return;
    }
    // Flush any trailing buffered text as a final assistant message.
    if (this.#bufferedText.length > 0) {
      const text = this.#bufferedText;
      this.#bufferedText = "";
      this.#finalText += text;
      this.#turnCount += 1;
      await this.#emit({
        type: "assistant",
        message: {
          id: this.#assistantId(false),
          type: "message",
          role: "assistant",
          model: this.#model,
          content: [{ type: "text", text }],
          stop_reason: null,
          stop_sequence: null,
        },
        parent_tool_use_id: null,
        session_id: this.#sessionId,
      });
    }
    await this.#emit({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: ev.duration_ms,
      num_turns: ev.turns,
      result: this.#finalText,
      stop_reason: "end_turn",
      session_id: this.#sessionId,
      total_cost_usd: this.#costSum,
      usage: {
        input_tokens: this.#inputTokens,
        output_tokens: this.#outputTokens,
        cache_read_input_tokens: this.#cacheRead,
        cache_creation_input_tokens: this.#cacheCreate,
      },
      permission_denials: [],
      terminal_reason: "completed",
    });
    this.#terminalEmitted = true;
  }

  async #onSessionError(ev: Extract<AgentEvent, { type: "session.error" }>): Promise<void> {
    await this.#emit({
      type: "result",
      subtype: "error",
      is_error: true,
      result: this.#finalText,
      error: ev.message,
      session_id: this.#sessionId,
      terminal_reason: "error",
    });
    this.#terminalEmitted = true;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  #assistantId(withTool: boolean): string {
    const prefix = this.#sessionId !== null ? this.#sessionId.slice(0, 8) : "nosess";
    const suffix = withTool ? "_tool" : "";
    return `msg_${prefix}_${this.#turnCount}${suffix}`;
  }

  async #emit(frame: unknown): Promise<void> {
    await writeLine(this.#stdout, `${JSON.stringify(frame)}\n`);
  }

  #debug(msg: string): void {
    if (process.env.JELLYCLAW_DEBUG === "1") {
      process.stderr.write(`[claude-stream-json] ${msg}\n`);
    }
  }
}
