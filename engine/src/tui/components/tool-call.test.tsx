/**
 * Tests for ToolCall component (T3-07).
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { ToolCallMessage } from "../state/types.js";
import { ToolCall } from "./tool-call.js";

describe("ToolCall: non-edit-tools-use-toolcall", () => {
  it("Bash tool renders via ToolCall component", () => {
    const message: ToolCallMessage = {
      kind: "tool",
      id: "test-1",
      toolId: "tool-1",
      toolName: "Bash",
      input: { command: "ls -la" },
      status: "ok",
      output: "file1.txt\nfile2.txt",
    };

    const { lastFrame } = render(<ToolCall message={message} />);
    const frame = lastFrame();

    // Should contain the tool name
    expect(frame).toContain("Bash");
    // Should contain the input
    expect(frame).toContain("ls -la");
    // Should contain the output
    expect(frame).toContain("file1.txt");
    // Should have the success checkmark
    expect(frame).toContain("\u2713");
  });

  it("Read tool renders via ToolCall component", () => {
    const message: ToolCallMessage = {
      kind: "tool",
      id: "test-2",
      toolId: "tool-2",
      toolName: "Read",
      input: { file_path: "/path/to/file.ts" },
      status: "ok",
      output: "file contents here",
    };

    const { lastFrame } = render(<ToolCall message={message} />);
    const frame = lastFrame();

    expect(frame).toContain("Read");
    expect(frame).toContain("/path/to/file.ts");
  });

  it("Grep tool renders via ToolCall component", () => {
    const message: ToolCallMessage = {
      kind: "tool",
      id: "test-3",
      toolId: "tool-3",
      toolName: "Grep",
      input: { pattern: "TODO", path: "." },
      status: "ok",
      output: "src/index.ts:10:// TODO: implement this",
    };

    const { lastFrame } = render(<ToolCall message={message} />);
    const frame = lastFrame();

    expect(frame).toContain("Grep");
    expect(frame).toContain("TODO");
  });

  it("renders pending status with spinner indicator", () => {
    const message: ToolCallMessage = {
      kind: "tool",
      id: "test-4",
      toolId: "tool-4",
      toolName: "Bash",
      input: { command: "sleep 5" },
      status: "pending",
    };

    const { lastFrame } = render(<ToolCall message={message} reducedMotion={true} />);
    const frame = lastFrame();

    expect(frame).toContain("Bash");
    // Should not have the success checkmark
    expect(frame).not.toContain("\u2713");
    expect(frame).not.toContain("\u2717");
  });

  it("renders error status with X indicator", () => {
    const message: ToolCallMessage = {
      kind: "tool",
      id: "test-5",
      toolId: "tool-5",
      toolName: "Bash",
      input: { command: "false" },
      status: "error",
      errorCode: "command_failed",
      errorMessage: "Command exited with code 1",
    };

    const { lastFrame } = render(<ToolCall message={message} />);
    const frame = lastFrame();

    expect(frame).toContain("Bash");
    expect(frame).toContain("\u2717");
    expect(frame).toContain("command_failed");
  });
});
