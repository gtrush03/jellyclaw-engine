/**
 * Transcript component tests (T1-03).
 *
 * Covers 3 rows (user/assistant/tool) rendered in order with correct accents.
 */

import { render } from "ink-testing-library";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../state/types.js";
import { Transcript } from "./transcript.js";

describe("Transcript", () => {
  const userItem: TranscriptItem = {
    kind: "message",
    id: "msg-1",
    role: "user",
    text: "Hello, can you help me?",
    done: true,
  };

  const assistantItem: TranscriptItem = {
    kind: "message",
    id: "msg-2",
    role: "assistant",
    text: "Of course! I am here to help.",
    done: true,
  };

  const toolItem: TranscriptItem = {
    kind: "tool",
    id: "tool-1",
    toolId: "call-1",
    toolName: "Read",
    input: { file_path: "/path/to/file.ts" },
    status: "ok",
    output: "file contents",
  };

  it("renders user, assistant, and tool rows in order", () => {
    const items: readonly TranscriptItem[] = [userItem, assistantItem, toolItem];
    const { lastFrame } = render(<Transcript items={items} rows={10} />);
    const frame = stripAnsi(lastFrame());

    // User content
    expect(frame).toContain("Hello, can you help me?");
    expect(frame).toContain("you");

    // Assistant content
    expect(frame).toContain("Of course!");
    expect(frame).toContain("jc");

    // Tool content
    expect(frame).toContain("Read");
    expect(frame).toContain("/path/to/file.ts");
  });

  it("applies user accent color", () => {
    const items: readonly TranscriptItem[] = [userItem];
    const { lastFrame } = render(<Transcript items={items} rows={10} />);
    const frame = lastFrame();

    // Should contain the user row with vertical bar
    expect(frame).toContain("│");
    expect(frame).toContain("you");
  });

  it("applies assistant accent with jellyfish emoji", () => {
    const items: readonly TranscriptItem[] = [assistantItem];
    const { lastFrame } = render(<Transcript items={items} rows={10} />);
    const frame = stripAnsi(lastFrame());

    // Should contain jellyfish and jc prefix
    expect(frame).toContain("🪼");
    expect(frame).toContain("jc");
  });

  it("renders tool calls with bordered card", () => {
    const items: readonly TranscriptItem[] = [toolItem];
    const { lastFrame } = render(<Transcript items={items} rows={10} />);
    const frame = lastFrame();

    // Should contain tool name
    expect(frame).toContain("Read");
    // Should contain the success checkmark
    expect(frame).toContain("✓");
  });

  it("renders error items with error styling", () => {
    const errorItem: TranscriptItem = {
      kind: "error",
      id: "err-1",
      code: "api_error",
      message: "Rate limit exceeded",
    };
    const items: readonly TranscriptItem[] = [errorItem];
    const { lastFrame } = render(<Transcript items={items} rows={10} />);
    const frame = lastFrame();

    expect(frame).toContain("api_error");
    expect(frame).toContain("Rate limit exceeded");
    expect(frame).toContain("✗");
  });

  it("renders system messages with dim styling", () => {
    const systemItem: TranscriptItem = {
      kind: "message",
      id: "sys-1",
      role: "system",
      text: "System initialized",
      done: true,
    };
    const items: readonly TranscriptItem[] = [systemItem];
    const { lastFrame } = render(<Transcript items={items} rows={10} />);
    const frame = lastFrame();

    expect(frame).toContain("System initialized");
    expect(frame).toContain("·");
  });

  it("slices to max rows when exceeded", () => {
    const items: readonly TranscriptItem[] = [
      { ...userItem, id: "msg-1", text: "First message" },
      { ...userItem, id: "msg-2", text: "Second message" },
      { ...userItem, id: "msg-3", text: "Third message" },
      { ...userItem, id: "msg-4", text: "Fourth message" },
    ];
    const { lastFrame } = render(<Transcript items={items} rows={2} />);
    const frame = lastFrame();

    // Should only show last 2 items
    expect(frame).not.toContain("First message");
    expect(frame).not.toContain("Second message");
    expect(frame).toContain("Third message");
    expect(frame).toContain("Fourth message");
  });

  it("shows thinking indicator when streaming", () => {
    const streamingItem: TranscriptItem = {
      kind: "message",
      id: "msg-stream",
      role: "assistant",
      text: "",
      done: false,
    };
    const items: readonly TranscriptItem[] = [streamingItem];
    const { lastFrame } = render(
      <Transcript items={items} rows={10} status="streaming" reducedMotion={true} />,
    );
    const frame = lastFrame();

    expect(frame).toContain("thinking");
  });

  it("uses session-based row accents", () => {
    const items: readonly TranscriptItem[] = [userItem];

    // Same session ID should produce consistent output
    const { lastFrame: frame1 } = render(
      <Transcript items={items} rows={10} sessionId="session-123" />,
    );
    const { lastFrame: frame2 } = render(
      <Transcript items={items} rows={10} sessionId="session-123" />,
    );

    expect(frame1()).toEqual(frame2());
  });
});
