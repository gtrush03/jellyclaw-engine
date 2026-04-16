/**
 * Unit tests for the slash-command parser + dispatcher.
 */

import { describe, expect, it, vi } from "vitest";

import type { JellyclawClient } from "../client.js";
import {
  type CommandContext,
  executeCommand,
  parseSlash,
  type UiCommandAction,
} from "./dispatch.js";

// ---------------------------------------------------------------------------
// parseSlash
// ---------------------------------------------------------------------------

describe("parseSlash", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlash("hello")).toBeNull();
    expect(parseSlash("")).toBeNull();
    expect(parseSlash("   ")).toBeNull();
    expect(parseSlash("how do I use /help?")).toBeNull();
  });

  it("returns null for a bare slash", () => {
    expect(parseSlash("/")).toBeNull();
    expect(parseSlash("  /  ")).toBeNull();
  });

  it("parses /help with no args", () => {
    const p = parseSlash("/help");
    expect(p).not.toBeNull();
    expect(p?.name).toBe("help");
    expect(p?.args).toEqual([]);
    expect(p?.argString).toBe("");
  });

  it("parses /model with a name arg", () => {
    const p = parseSlash("/model claude-opus-4-6");
    expect(p?.name).toBe("model");
    expect(p?.args).toEqual(["claude-opus-4-6"]);
    expect(p?.argString).toBe("claude-opus-4-6");
  });

  it("parses /resume with an id", () => {
    const p = parseSlash("/resume abc-123");
    expect(p?.name).toBe("resume");
    expect(p?.args).toEqual(["abc-123"]);
  });

  it("lowercases the command name but preserves arg casing", () => {
    const p = parseSlash("/MODEL Claude-Opus-4-6");
    expect(p?.name).toBe("model");
    expect(p?.args).toEqual(["Claude-Opus-4-6"]);
  });

  it("trims surrounding whitespace", () => {
    const p = parseSlash("   /help   ");
    expect(p?.name).toBe("help");
  });

  it("handles multi-arg commands", () => {
    const p = parseSlash("/foo   a   b  c");
    expect(p?.name).toBe("foo");
    expect(p?.args).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// executeCommand
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<CommandContext> = {}): {
  ctx: CommandContext;
  pushed: string[];
  actions: UiCommandAction[];
  exited: number[];
} {
  const pushed: string[] = [];
  const actions: UiCommandAction[] = [];
  const exited: number[] = [];
  const ctx: CommandContext = {
    client: {} as JellyclawClient,
    cwd: "/tmp/test",
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
    pushSystem: (text) => pushed.push(text),
    exit: (code) => exited.push(code),
    dispatchAction: (a) => actions.push(a),
    dispatchEvent: () => undefined,
    ...overrides,
  };
  return { ctx, pushed, actions, exited };
}

describe("executeCommand", () => {
  it("/help pushes an available-commands listing", async () => {
    const { ctx, pushed } = makeCtx();
    const parsed = parseSlash("/help");
    if (parsed === null) throw new Error("expected parse");
    const res = await executeCommand(parsed, ctx);
    expect(res.status).toBe("ok");
    expect(pushed.length).toBeGreaterThan(0);
    expect(pushed[0]).toContain("Available commands");
    expect(pushed[0]).toContain("/help");
    expect(pushed[0]).toContain("/model");
  });

  it("/model with no args reports the current model", async () => {
    const { ctx, pushed } = makeCtx({ currentModel: "claude-opus-4-6" });
    const parsed = parseSlash("/model");
    if (parsed === null) throw new Error("expected parse");
    await executeCommand(parsed, ctx);
    expect(pushed[0]).toContain("claude-opus-4-6");
  });

  it("/model <name> dispatches set-model", async () => {
    const { ctx, actions } = makeCtx();
    const parsed = parseSlash("/model claude-sonnet-4-5");
    if (parsed === null) throw new Error("expected parse");
    await executeCommand(parsed, ctx);
    expect(actions).toEqual([{ kind: "set-model", model: "claude-sonnet-4-5" }]);
  });

  it("/clear dispatches clear-transcript", async () => {
    const { ctx, actions } = makeCtx();
    const parsed = parseSlash("/clear");
    if (parsed === null) throw new Error("expected parse");
    await executeCommand(parsed, ctx);
    expect(actions).toEqual([{ kind: "clear-transcript" }]);
  });

  it("/new dispatches new-session", async () => {
    const { ctx, actions } = makeCtx();
    const parsed = parseSlash("/new");
    if (parsed === null) throw new Error("expected parse");
    await executeCommand(parsed, ctx);
    expect(actions.some((a) => a.kind === "new-session")).toBe(true);
  });

  it("/cwd prints the current cwd", async () => {
    const { ctx, pushed } = makeCtx({ cwd: "/home/george/work" });
    const parsed = parseSlash("/cwd");
    if (parsed === null) throw new Error("expected parse");
    await executeCommand(parsed, ctx);
    expect(pushed[0]).toContain("/home/george/work");
  });

  it("/end calls exit(0)", async () => {
    const { ctx, exited } = makeCtx();
    const parsed = parseSlash("/end");
    if (parsed === null) throw new Error("expected parse");
    await executeCommand(parsed, ctx);
    expect(exited).toEqual([0]);
  });

  it("/exit aliases /end", async () => {
    const { ctx, exited } = makeCtx();
    const parsed = parseSlash("/exit");
    if (parsed === null) throw new Error("expected parse");
    await executeCommand(parsed, ctx);
    expect(exited).toEqual([0]);
  });

  it("/cost prints a usage summary", async () => {
    const { ctx, pushed } = makeCtx({
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        costUsd: 0.0123,
      },
    });
    const parsed = parseSlash("/cost");
    if (parsed === null) throw new Error("expected parse");
    await executeCommand(parsed, ctx);
    expect(pushed[0]).toContain("100");
    expect(pushed[0]).toContain("$0.0123");
  });

  it("/cancel with no active run reports that fact", async () => {
    const { ctx, pushed } = makeCtx({ runId: null });
    const parsed = parseSlash("/cancel");
    if (parsed === null) throw new Error("expected parse");
    await executeCommand(parsed, ctx);
    expect(pushed[0]).toContain("no active run");
  });

  it("/cancel with an active run calls client.cancel and dispatches run-cancelled", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const { ctx, actions } = makeCtx({
      runId: "run-123",
      client: { cancel } as unknown as JellyclawClient,
    });
    const parsed = parseSlash("/cancel");
    if (parsed === null) throw new Error("expected parse");
    await executeCommand(parsed, ctx);
    expect(cancel).toHaveBeenCalledWith("run-123");
    expect(actions).toContainEqual({ kind: "run-cancelled" });
  });

  it("/resume without an id shows usage", async () => {
    const { ctx, pushed } = makeCtx();
    const parsed = parseSlash("/resume");
    if (parsed === null) throw new Error("expected parse");
    await executeCommand(parsed, ctx);
    expect(pushed[0]).toContain("usage:");
  });

  it("unknown /foo returns status: unknown", async () => {
    const { ctx, pushed } = makeCtx();
    const parsed = parseSlash("/foo");
    if (parsed === null) throw new Error("expected parse");
    const res = await executeCommand(parsed, ctx);
    expect(res.status).toBe("unknown");
    expect(pushed[0]).toContain("unknown command");
  });
});
