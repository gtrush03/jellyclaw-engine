/**
 * Conversation compaction (T3-01).
 *
 * Summarizes long conversations when input-token usage approaches the model's
 * context window, preventing HTTP 400 `prompt_too_long` errors. Matches
 * Claude Code's behavior: fire a PreCompact hook, issue a summary request,
 * then rewrite messages as [summary, ...last-3-turns].
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Logger } from "../logger.js";
import type { Provider, SystemBlock } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Context budget types
// ---------------------------------------------------------------------------

export interface ContextBudget {
  readonly windowTokens: number;
  readonly triggerRatio: number;
}

/**
 * Returns the context budget for a given model. Claude 4.x models have 200K
 * context windows. Unknown models get a safe 200K/0.8 default.
 */
export function contextBudgetForModel(model: string): ContextBudget {
  // Claude 4.x models: claude-opus-4-*, claude-sonnet-4-*, claude-haiku-4-*
  // Claude 3.5 models: claude-3-5-*
  // All have 200K context windows.
  const claude4Pattern = /^claude-(opus|sonnet|haiku)-4/;
  const claude35Pattern = /^claude-3-5-/;

  if (claude4Pattern.test(model) || claude35Pattern.test(model)) {
    return { windowTokens: 200_000, triggerRatio: 0.8 };
  }

  // Unknown model: use safe default (200K context, 80% trigger).
  return { windowTokens: 200_000, triggerRatio: 0.8 };
}

// ---------------------------------------------------------------------------
// Compact messages
// ---------------------------------------------------------------------------

/** System prompt for the summarization request. */
const COMPACTION_SYSTEM_PROMPT =
  "Produce a compact running summary of the conversation so far, preserving every file path, tool invocation, and open task. Return prose only.";

export interface CompactMessagesArgs {
  readonly messages: ReadonlyArray<Anthropic.Messages.MessageParam>;
  readonly system: readonly SystemBlock[];
  readonly provider: Provider;
  readonly model: string;
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

export interface CompactMessagesResult {
  readonly summary: string;
  readonly rewritten: Anthropic.Messages.MessageParam[];
}

/**
 * Compacts a conversation by summarizing older turns and keeping only the
 * last 3 user→assistant pairs.
 *
 * A "turn" is one user→assistant pair. The last 3 turns are kept in full,
 * including any trailing tool_result blocks. Everything else is replaced
 * with a summary.
 */
export async function compactMessages(args: CompactMessagesArgs): Promise<CompactMessagesResult> {
  const { messages, provider, model, logger, signal } = args;

  // Extract the last 3 turns (6 messages: user, assistant, user, assistant, user, assistant).
  // A turn is a user→assistant pair.
  const lastThreeTurns = extractLastThreeTurns(messages);
  const turnsToSummarize = messages.slice(0, messages.length - lastThreeTurns.length);

  // If there's nothing to summarize, return as-is.
  if (turnsToSummarize.length === 0) {
    logger.debug({ messageCount: messages.length }, "compaction: nothing to summarize");
    return {
      summary: "",
      rewritten: [...messages],
    };
  }

  // Build the summarization request.
  const summaryMessages: Anthropic.Messages.MessageParam[] = [
    {
      role: "user",
      content: `Please summarize the following conversation:\n\n${formatMessagesForSummary(turnsToSummarize)}`,
    },
  ];

  const req = {
    model,
    maxOutputTokens: 4096, // Summaries should be concise.
    system: [{ type: "text" as const, text: COMPACTION_SYSTEM_PROMPT }],
    messages: summaryMessages,
  };

  logger.info(
    {
      originalMessageCount: messages.length,
      messagesToSummarize: turnsToSummarize.length,
      keptTurns: lastThreeTurns.length / 2,
    },
    "compaction: summarizing conversation",
  );

  // Issue a non-streaming provider call to get the summary.
  let summaryText = "";
  try {
    for await (const chunk of provider.stream(req, signal)) {
      // Extract text from content_block_delta events.
      if (chunk.type === "content_block_delta") {
        const delta = chunk.delta as { type?: string; text?: string } | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          summaryText += delta.text;
        }
      }
    }
  } catch (err) {
    logger.error({ err }, "compaction: failed to generate summary");
    // On failure, return original messages unchanged.
    return {
      summary: "",
      rewritten: [...messages],
    };
  }

  if (summaryText.length === 0) {
    logger.warn("compaction: summary is empty, keeping original messages");
    return {
      summary: "",
      rewritten: [...messages],
    };
  }

  logger.info({ summaryLength: summaryText.length }, "compaction: generated summary");

  // Build rewritten messages: [summary, ...lastThreeTurns].
  const rewritten: Anthropic.Messages.MessageParam[] = [
    { role: "user", content: `[prior-conversation-summary] ${summaryText}` },
    // Insert a synthetic assistant acknowledgment to maintain alternating roles.
    { role: "assistant", content: "I understand. I have the context from the prior conversation." },
    ...lastThreeTurns,
  ];

  return {
    summary: summaryText,
    rewritten,
  };
}

/**
 * Extracts the last 3 turns from messages. A turn is a user→assistant pair.
 * Handles trailing tool_result blocks (which are user messages following an
 * assistant message with tool_use).
 */
function extractLastThreeTurns(
  messages: ReadonlyArray<Anthropic.Messages.MessageParam>,
): Anthropic.Messages.MessageParam[] {
  if (messages.length === 0) return [];

  // Work backwards through messages counting turns.
  // A turn boundary is when we see a user message that isn't a tool_result
  // (i.e., the start of a new conversational turn).
  const result: Anthropic.Messages.MessageParam[] = [];
  let turnCount = 0;
  const targetTurns = 3;

  for (let i = messages.length - 1; i >= 0 && turnCount < targetTurns; i--) {
    const msg = messages[i];
    if (msg === undefined) continue;

    result.unshift(msg);

    // Count as turn boundary when we see a user message.
    // But tool_result messages (user messages with tool_result content)
    // don't start a new turn, they continue the previous turn.
    if (msg.role === "user" && !isToolResultMessage(msg)) {
      turnCount++;
    }
  }

  return result;
}

/**
 * Check if a message is a tool_result message.
 */
function isToolResultMessage(msg: Anthropic.Messages.MessageParam): boolean {
  if (msg.role !== "user") return false;
  const content = msg.content;
  if (typeof content === "string") return false;
  if (!Array.isArray(content)) return false;

  // If ALL content blocks are tool_result, it's a tool_result message.
  return (
    content.length > 0 &&
    content.every((block) => {
      if (typeof block === "object" && block !== null && "type" in block) {
        return block.type === "tool_result";
      }
      return false;
    })
  );
}

/**
 * Format messages into a readable string for the summary request.
 */
function formatMessagesForSummary(
  messages: ReadonlyArray<Anthropic.Messages.MessageParam>,
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    const content = extractTextContent(msg.content);
    parts.push(`${role}: ${content}`);
  }

  return parts.join("\n\n");
}

/**
 * Extract text content from a message's content field.
 */
function extractTextContent(content: Anthropic.Messages.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "[unknown content]";

  const textParts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      textParts.push(block);
    } else if (typeof block === "object" && block !== null && "type" in block) {
      if (block.type === "text" && "text" in block && typeof block.text === "string") {
        textParts.push(block.text);
      } else if (block.type === "tool_use" && "name" in block) {
        textParts.push(`[tool_use: ${block.name}]`);
      } else if (block.type === "tool_result" && "content" in block) {
        const resultContent =
          typeof block.content === "string"
            ? block.content.slice(0, 200) + (block.content.length > 200 ? "..." : "")
            : "[tool result]";
        textParts.push(`[tool_result: ${resultContent}]`);
      }
    }
  }

  return textParts.join(" ");
}
