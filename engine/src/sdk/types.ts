/**
 * SDK types matching @anthropic-ai/claude-agent-sdk shape.
 *
 * These types define the public interface for the `query()` function,
 * mirroring the Claude Agent SDK's message shapes for wire compatibility.
 */

// ---------------------------------------------------------------------------
// SDKMessage discriminated union
// ---------------------------------------------------------------------------

export interface SystemInitMessage {
  readonly type: "system";
  readonly subtype: "init";
  readonly session_id: string;
  readonly model: string;
  readonly cwd: string;
  readonly tools: readonly string[];
  readonly permissionMode: string;
  readonly apiKeySource: string;
  readonly claude_code_version: string;
  readonly uuid: string;
  readonly mcp_servers: readonly unknown[];
  readonly slash_commands: readonly string[];
  readonly agents: readonly unknown[];
  readonly skills: readonly unknown[];
  readonly plugins: readonly unknown[];
  readonly output_style: string;
  readonly cache_creation: {
    readonly ephemeral_5m_input_tokens: number;
    readonly ephemeral_1h_input_tokens: number;
  };
}

export interface AssistantMessage {
  readonly type: "assistant";
  readonly message: {
    readonly id: string;
    readonly type: "message";
    readonly role: "assistant";
    readonly model: string;
    readonly content: readonly unknown[];
    readonly stop_reason: string | null;
    readonly stop_sequence: string | null;
  };
  readonly parent_tool_use_id: string | null;
  readonly session_id: string | null;
  readonly uuid: string;
}

export interface UserMessage {
  readonly type: "user";
  readonly message: {
    readonly role: "user";
    readonly content: readonly unknown[];
  };
  readonly parent_tool_use_id: string | null;
  readonly session_id: string | null;
  readonly uuid: string;
}

export interface ResultMessage {
  readonly type: "result";
  readonly subtype: "success" | "error";
  readonly is_error: boolean;
  readonly result: string;
  readonly session_id: string | null;
  readonly uuid: string;
  readonly duration_ms?: number;
  readonly num_turns?: number;
  readonly total_cost_usd?: number;
  readonly stop_reason?: string;
  readonly usage?: unknown;
  readonly modelUsage?: unknown;
  readonly cache_creation?: {
    readonly ephemeral_5m_input_tokens: number;
    readonly ephemeral_1h_input_tokens: number;
  };
  readonly permission_denials?: readonly unknown[];
  readonly terminal_reason?: string;
  readonly error?: string;
}

export type SDKMessage = SystemInitMessage | AssistantMessage | UserMessage | ResultMessage;

// ---------------------------------------------------------------------------
// QueryOptions
// ---------------------------------------------------------------------------

export interface UserInputMessage {
  readonly type: "user";
  readonly message: {
    readonly role: "user";
    readonly content: string;
  };
}

export interface QueryOptions {
  readonly prompt: string | AsyncIterable<UserInputMessage>;
  readonly options?: {
    readonly model?: string;
    readonly cwd?: string;
    readonly allowedTools?: readonly string[];
    readonly disallowedTools?: readonly string[];
    readonly permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
    readonly abortController?: AbortController;
    readonly maxTurns?: number;
    readonly systemPrompt?: string;
    readonly resume?: string;
  };
}

// ---------------------------------------------------------------------------
// Query interface
// ---------------------------------------------------------------------------

export interface Query {
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage, void, void>;
  next(): Promise<IteratorResult<SDKMessage, void>>;
  return(value?: void | PromiseLike<void>): Promise<IteratorResult<SDKMessage, void>>;
  throw(error?: unknown): Promise<IteratorResult<SDKMessage, void>>;
  interrupt(): Promise<void>;
}
