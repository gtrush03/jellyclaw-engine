/**
 * Tests for to-prior-messages.ts (T2-07).
 */

import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import { toPriorMessages } from "./to-prior-messages.js";
import type { EngineState, ReplayedMessage } from "./types.js";

function makeEmptyState(): EngineState {
  return {
    sessionId: "test-session",
    projectHash: "test-project",
    cwd: "/tmp",
    model: "claude-test",
    provider: "anthropic",
    messages: [],
    toolCalls: [],
    permissions: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdCents: 0,
    },
    lastSeq: 0,
    lastTs: Date.now(),
    turns: 0,
    truncatedTail: false,
    ended: false,
  };
}

function makeMessage(
  role: "user" | "assistant" | "system",
  content: string,
  firstSeq = 0,
): ReplayedMessage {
  return {
    role,
    content,
    firstSeq,
    firstTs: Date.now(),
  };
}

function makeMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as Logger;
}

describe("toPriorMessages", () => {
  describe("empty state", () => {
    it("returns empty array for empty state", () => {
      const state = makeEmptyState();
      const result = toPriorMessages(state);
      expect(result).toEqual([]);
    });
  });

  describe("basic conversion", () => {
    it("converts user and assistant messages", () => {
      const state = makeEmptyState();
      state.messages.push(makeMessage("user", "hi"), makeMessage("assistant", "hello"));
      // Need to cast because messages is readonly in EngineState
      const mutableState = { ...state, messages: [...state.messages] };

      const result = toPriorMessages(mutableState);
      expect(result).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]);
    });

    it("filters out system messages", () => {
      const state: EngineState = {
        ...makeEmptyState(),
        messages: [
          makeMessage("system", "system prompt"),
          makeMessage("user", "hi"),
          makeMessage("assistant", "hello"),
        ],
      };

      const result = toPriorMessages(state);
      expect(result).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ]);
    });
  });

  describe("role coalescing", () => {
    it("coalesces consecutive assistant messages", () => {
      const state: EngineState = {
        ...makeEmptyState(),
        messages: [
          makeMessage("user", "hi"),
          makeMessage("assistant", "hello"),
          makeMessage("assistant", "how are you?"),
        ],
      };

      const result = toPriorMessages(state);
      expect(result).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello\nhow are you?" },
      ]);
    });

    it("coalesces multiple consecutive assistant messages", () => {
      const state: EngineState = {
        ...makeEmptyState(),
        messages: [
          makeMessage("user", "hi"),
          makeMessage("assistant", "line1"),
          makeMessage("assistant", "line2"),
          makeMessage("assistant", "line3"),
        ],
      };

      const result = toPriorMessages(state);
      expect(result).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "line1\nline2\nline3" },
      ]);
    });

    it("does not coalesce non-consecutive assistant messages", () => {
      const state: EngineState = {
        ...makeEmptyState(),
        messages: [
          makeMessage("user", "hi"),
          makeMessage("assistant", "hello"),
          makeMessage("user", "how are you?"),
          makeMessage("assistant", "fine"),
        ],
      };

      const result = toPriorMessages(state);
      expect(result).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "how are you?" },
        { role: "assistant", content: "fine" },
      ]);
    });
  });

  describe("tool call drop warning", () => {
    it("logs info when tool calls are dropped", () => {
      const logger = makeMockLogger();
      const state: EngineState = {
        ...makeEmptyState(),
        messages: [makeMessage("user", "hi"), makeMessage("assistant", "hello")],
        toolCalls: [
          {
            toolId: "tool-1",
            toolName: "Bash",
            input: { command: "ls" },
            result: "file1\nfile2",
            error: null,
            durationMs: 100,
            startedAt: Date.now(),
            finishedAt: Date.now() + 100,
            startSeq: 2,
          },
        ],
      };

      const result = toPriorMessages(state, { logger });

      expect(result).toHaveLength(2);
      expect(logger.info).toHaveBeenCalledWith(
        { toolCallCount: 1 },
        "resume: tool call history dropped (text-only prior messages); context may be thin",
      );
    });

    it("does not log when no tool calls", () => {
      const logger = makeMockLogger();
      const state: EngineState = {
        ...makeEmptyState(),
        messages: [makeMessage("user", "hi")],
      };

      toPriorMessages(state, { logger });

      expect(logger.info).not.toHaveBeenCalled();
    });

    it("does not log when no logger provided", () => {
      const state: EngineState = {
        ...makeEmptyState(),
        messages: [makeMessage("user", "hi")],
        toolCalls: [
          {
            toolId: "tool-1",
            toolName: "Bash",
            input: { command: "ls" },
            result: "file1",
            error: null,
            durationMs: 100,
            startedAt: Date.now(),
            finishedAt: Date.now() + 100,
            startSeq: 2,
          },
        ],
      };

      // Should not throw even without logger.
      expect(() => toPriorMessages(state)).not.toThrow();
    });
  });
});
