/**
 * Event-to-SDKMessage mapper (T3-12).
 *
 * Extracts the AgentEvent → SDKMessage transformation logic that was previously
 * embedded in ClaudeStreamJsonWriter. This pure function can be reused by both
 * the stream-json writer (for NDJSON output) and the SDK query() function.
 */

import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../events.js";
import type { SDKMessage } from "./types.js";

// ---------------------------------------------------------------------------
// Mapper state
// ---------------------------------------------------------------------------

export interface EventMapperOptions {
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly permissionMode?: string;
  readonly apiKeySource?: string;
  readonly claudeCodeVersion?: string;
  readonly agents?: readonly { readonly name: string; readonly description?: string }[];
  readonly skills?: readonly { readonly name: string; readonly description?: string }[];
  readonly slashCommands?: readonly string[];
  readonly plugins?: readonly { readonly name: string; readonly version?: string }[];
  readonly mcpServers?: readonly {
    readonly name: string;
    readonly status: "connected" | "failed" | "disconnected";
  }[];
  readonly outputStyle?: string;
}

export interface EventMapperState {
  sessionId: string | null;
  model: string;
  sessionInitialized: boolean;
  terminalEmitted: boolean;
  bufferedText: string;
  finalText: string;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  cacheCreate5m: number;
  cacheCreate1h: number;
  costSum: number;
}

export function createMapperState(): EventMapperState {
  return {
    sessionId: null,
    model: "",
    sessionInitialized: false,
    terminalEmitted: false,
    bufferedText: "",
    finalText: "",
    turnCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheCreate: 0,
    cacheCreate5m: 0,
    cacheCreate1h: 0,
    costSum: 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output);
}

function assistantId(state: EventMapperState, withTool: boolean): string {
  const prefix = state.sessionId !== null ? state.sessionId.slice(0, 8) : "nosess";
  const suffix = withTool ? "_tool" : "";
  return `msg_${prefix}_${state.turnCount}${suffix}`;
}

// ---------------------------------------------------------------------------
// Map function
// ---------------------------------------------------------------------------

/**
 * Maps an AgentEvent to zero or more SDKMessages.
 * Mutates state to track buffering, turns, and usage.
 *
 * Returns an array because some events (like session.completed with buffered text)
 * may produce multiple messages.
 */
export function mapEventToSdkMessages(
  event: AgentEvent,
  state: EventMapperState,
  opts: EventMapperOptions,
): SDKMessage[] {
  const messages: SDKMessage[] = [];

  if (state.terminalEmitted) {
    return messages;
  }

  switch (event.type) {
    case "session.started": {
      state.sessionId = event.session_id;
      state.model = event.model;
      state.sessionInitialized = true;
      messages.push({
        type: "system",
        subtype: "init",
        session_id: event.session_id,
        model: event.model,
        cwd: opts.cwd,
        tools: opts.tools,
        permissionMode: opts.permissionMode ?? "default",
        apiKeySource: opts.apiKeySource ?? (process.env.ANTHROPIC_API_KEY ? "env" : "none"),
        claude_code_version: opts.claudeCodeVersion ?? "0.0.1",
        uuid: randomUUID(),
        mcp_servers: opts.mcpServers ?? [],
        slash_commands: opts.slashCommands ?? [],
        agents: opts.agents ?? [],
        skills: opts.skills ?? [],
        plugins: opts.plugins ?? [],
        output_style: opts.outputStyle ?? "default",
        cache_creation: {
          ephemeral_5m_input_tokens: 0,
          ephemeral_1h_input_tokens: 0,
        },
      });
      break;
    }

    case "agent.message": {
      if (!event.final) {
        state.bufferedText += event.delta;
        break;
      }
      // final: flush any buffered text as an assistant text message.
      if (state.bufferedText.length > 0) {
        const text = state.bufferedText;
        state.bufferedText = "";
        state.finalText += text;
        state.turnCount += 1;
        messages.push({
          type: "assistant",
          message: {
            id: assistantId(state, false),
            type: "message",
            role: "assistant",
            model: state.model,
            content: [{ type: "text", text }],
            stop_reason: null,
            stop_sequence: null,
          },
          parent_tool_use_id: null,
          session_id: state.sessionId,
          uuid: randomUUID(),
        });
      }
      break;
    }

    case "tool.called": {
      const content: unknown[] = [];
      if (state.bufferedText.length > 0) {
        const text = state.bufferedText;
        state.bufferedText = "";
        state.finalText += text;
        content.push({ type: "text", text });
      }
      content.push({
        type: "tool_use",
        id: event.tool_id,
        name: event.tool_name,
        input: event.input,
      });
      state.turnCount += 1;
      messages.push({
        type: "assistant",
        message: {
          id: assistantId(state, true),
          type: "message",
          role: "assistant",
          model: state.model,
          content,
          stop_reason: null,
          stop_sequence: null,
        },
        parent_tool_use_id: null,
        session_id: state.sessionId,
        uuid: randomUUID(),
      });
      break;
    }

    case "tool.result": {
      messages.push({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: event.tool_id,
              content: stringifyToolOutput(event.output),
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: state.sessionId,
        uuid: randomUUID(),
      });
      break;
    }

    case "tool.error": {
      messages.push({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: event.tool_id,
              content: event.message,
              is_error: true,
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: state.sessionId,
        uuid: randomUUID(),
      });
      break;
    }

    case "usage.updated": {
      state.inputTokens += event.input_tokens;
      state.outputTokens += event.output_tokens;
      state.cacheRead += event.cache_read_tokens;
      state.cacheCreate += event.cache_write_tokens;
      state.cacheCreate5m += event.cache_write_tokens;
      if (typeof event.cost_usd === "number") {
        state.costSum = event.cost_usd;
      }
      // usage events don't produce messages
      break;
    }

    case "session.completed": {
      if (!state.sessionInitialized) {
        messages.push({
          type: "result",
          subtype: "error",
          is_error: true,
          result: "",
          error: "missing session.started",
          session_id: null,
          terminal_reason: "error",
          uuid: randomUUID(),
        });
        state.terminalEmitted = true;
        break;
      }
      // Flush any trailing buffered text as a final assistant message.
      if (state.bufferedText.length > 0) {
        const text = state.bufferedText;
        state.bufferedText = "";
        state.finalText += text;
        state.turnCount += 1;
        messages.push({
          type: "assistant",
          message: {
            id: assistantId(state, false),
            type: "message",
            role: "assistant",
            model: state.model,
            content: [{ type: "text", text }],
            stop_reason: null,
            stop_sequence: null,
          },
          parent_tool_use_id: null,
          session_id: state.sessionId,
          uuid: randomUUID(),
        });
      }
      messages.push({
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: event.duration_ms,
        num_turns: event.turns,
        result: state.finalText,
        stop_reason: "end_turn",
        session_id: state.sessionId,
        total_cost_usd: state.costSum,
        usage: {
          input_tokens: state.inputTokens,
          output_tokens: state.outputTokens,
          cache_read_input_tokens: state.cacheRead,
          cache_creation_input_tokens: state.cacheCreate,
        },
        cache_creation: {
          ephemeral_5m_input_tokens: state.cacheCreate5m,
          ephemeral_1h_input_tokens: state.cacheCreate1h,
        },
        modelUsage: {
          [state.model]: {
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            cacheReadInputTokens: state.cacheRead,
            cacheCreationInputTokens: state.cacheCreate,
            webSearchRequests: 0,
            costUSD: state.costSum,
            contextWindow: 200_000,
          },
        },
        permission_denials: [],
        terminal_reason: "completed",
        uuid: randomUUID(),
      });
      state.terminalEmitted = true;
      break;
    }

    case "session.error": {
      messages.push({
        type: "result",
        subtype: "error",
        is_error: true,
        result: state.finalText,
        error: event.message,
        session_id: state.sessionId,
        terminal_reason: "error",
        uuid: randomUUID(),
      });
      state.terminalEmitted = true;
      break;
    }

    // Dropped event types
    case "agent.thinking":
    case "permission.requested":
    case "permission.granted":
    case "permission.denied":
    case "subagent.spawned":
    case "subagent.returned":
    case "stream.ping":
    case "user.prompt":
    case "team.created":
    case "team.member.started":
    case "team.member.result":
    case "team.deleted":
    case "monitor.started":
    case "monitor.event":
    case "monitor.stopped":
      // These events don't produce SDK messages
      break;

    default: {
      const _exhaustive: never = event;
      void _exhaustive;
    }
  }

  return messages;
}

/**
 * Create a terminal error message for when the stream ends without session.completed.
 */
export function createTerminalErrorMessage(state: EventMapperState): SDKMessage {
  return {
    type: "result",
    subtype: "error",
    is_error: true,
    result: state.finalText,
    error: "stream ended without session.completed",
    session_id: state.sessionId,
    terminal_reason: "error",
    uuid: randomUUID(),
  };
}
