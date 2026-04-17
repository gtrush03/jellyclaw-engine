/**
 * Convert EngineState to priorMessages for session resumption (T2-07).
 *
 * Extracts user/assistant message pairs from a replayed session state,
 * coalescing consecutive assistant messages and dropping system messages
 * and tool call history.
 *
 * @module
 */

import type { Logger } from "../logger.js";
import type { EngineState, ReplayedMessage } from "./types.js";

export interface PriorMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface ToPriorMessagesOptions {
  /** Logger for info/warnings (e.g., when tool call history is dropped). */
  readonly logger?: Logger | undefined;
}

/**
 * Convert an EngineState to an array of prior messages suitable for
 * `AgentLoopOptions.priorMessages`.
 *
 * Rules:
 *   - Only user and assistant messages are included; system messages are dropped.
 *   - Consecutive assistant messages are coalesced into one (separated by newline).
 *   - Tool call history in `state.toolCalls` is NOT rehydrated into the
 *     conversation; if present, an info-level log is emitted.
 *
 * @param state - The EngineState from `resumeSession()`
 * @param options - Optional logger for warnings
 * @returns Array of prior messages ready for the agent loop
 */
export function toPriorMessages(
  state: EngineState,
  options: ToPriorMessagesOptions = {},
): PriorMessage[] {
  const result: PriorMessage[] = [];

  // Warn if tool calls are being dropped.
  if (state.toolCalls.length > 0 && options.logger) {
    options.logger.info(
      { toolCallCount: state.toolCalls.length },
      "resume: tool call history dropped (text-only prior messages); context may be thin",
    );
  }

  // Filter to user/assistant messages only.
  const conversationMessages = state.messages.filter(
    (m): m is ReplayedMessage & { role: "user" | "assistant" } =>
      m.role === "user" || m.role === "assistant",
  );

  // Coalesce consecutive assistant messages.
  for (const msg of conversationMessages) {
    const last = result[result.length - 1];

    if (msg.role === "assistant" && last?.role === "assistant") {
      // Coalesce: append to last assistant message.
      result[result.length - 1] = {
        role: "assistant",
        content: `${last.content}\n${msg.content}`,
      };
    } else {
      result.push({
        role: msg.role,
        content: msg.content,
      });
    }
  }

  return result;
}
