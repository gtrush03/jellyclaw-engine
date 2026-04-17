/**
 * Tests for slash-command registry (T3-08).
 */

import { describe, expect, it, vi } from "vitest";
import type { CommandContext, ParsedCommand } from "./dispatch.js";
import { COMMANDS } from "./registry.js";

describe("key-does-not-exit", () => {
  it("handleKey does not call ctx.exit", () => {
    const keyCommand = COMMANDS.find((c) => c.name === "key");
    expect(keyCommand).toBeDefined();

    const exitSpy = vi.fn();
    const dispatchActionSpy = vi.fn();
    const pushSystemSpy = vi.fn();

    const ctx: CommandContext = {
      client: {} as CommandContext["client"],
      cwd: "/test",
      sessionId: "session-1",
      runId: "run-1",
      currentModel: "opus",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
      pushSystem: pushSystemSpy,
      exit: exitSpy,
      dispatchAction: dispatchActionSpy,
      dispatchEvent: vi.fn(),
    };

    const cmd: ParsedCommand = {
      name: "key",
      args: [],
      argString: "",
    };

    if (keyCommand === undefined) throw new Error("key command not found");
    keyCommand.handler(cmd, ctx);

    // exit should NEVER be called
    expect(exitSpy).not.toHaveBeenCalled();

    // dispatchAction should be called with open-modal
    expect(dispatchActionSpy).toHaveBeenCalledWith({
      kind: "open-modal",
      modal: "api-key",
    });

    // pushSystem should be called with the hint message
    expect(pushSystemSpy).toHaveBeenCalledWith(
      "rotate API key — paste a new key below, or Esc to cancel",
    );
  });

  it("handleKey dispatches open-modal with modal: 'api-key'", () => {
    const keyCommand = COMMANDS.find((c) => c.name === "key");
    expect(keyCommand).toBeDefined();

    const dispatchActionSpy = vi.fn();

    const ctx: CommandContext = {
      client: {} as CommandContext["client"],
      cwd: "/test",
      sessionId: null,
      runId: null,
      currentModel: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
      },
      pushSystem: vi.fn(),
      exit: vi.fn(),
      dispatchAction: dispatchActionSpy,
      dispatchEvent: vi.fn(),
    };

    const cmd: ParsedCommand = {
      name: "key",
      args: [],
      argString: "",
    };

    if (keyCommand === undefined) throw new Error("key command not found");
    keyCommand.handler(cmd, ctx);

    expect(dispatchActionSpy).toHaveBeenCalledTimes(1);
    expect(dispatchActionSpy).toHaveBeenCalledWith({
      kind: "open-modal",
      modal: "api-key",
    });
  });
});
