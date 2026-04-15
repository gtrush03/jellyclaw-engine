import { describe, expect, it, vi } from "vitest";
import {
  makePostToolUseEvent,
  makePreToolUseEvent,
  makeSessionStartEvent,
  makeUserPromptSubmitEvent,
} from "./events.js";
import { HookRegistry, type RunSingleHookFn, runHooksWith } from "./registry.js";
import type { CompiledHook, HookConfig, HookEventKind, HookOutcome } from "./types.js";

function fakeOutcome<K extends HookEventKind>(
  hookName: string,
  event: K,
  decision: HookOutcome<K>["decision"],
  extra: Partial<HookOutcome<K>> = {},
): HookOutcome<K> {
  return {
    hookName,
    event,
    decision,
    durationMs: 1,
    exitCode: 0,
    timedOut: false,
    ...extra,
  };
}

function recorder(decisions: Record<string, HookOutcome<HookEventKind>>): {
  runner: RunSingleHookFn;
  calls: string[];
} {
  const calls: string[] = [];
  const runner: RunSingleHookFn = (hook, event) => {
    calls.push(hook.name);
    const o = decisions[hook.name];
    if (o !== undefined) return Promise.resolve(o as HookOutcome<typeof event.kind>);
    return Promise.resolve(fakeOutcome(hook.name, event.kind, "neutral"));
  };
  return { runner, calls };
}

describe("HookRegistry — construction", () => {
  it("accepts zero hooks", () => {
    const reg = new HookRegistry([]);
    expect(reg.all).toEqual([]);
    expect(reg.warnings).toEqual([]);
  });

  it("records a warning for unknown event kinds and disables the hook", () => {
    const reg = new HookRegistry([
      { event: "NotARealEvent" as HookEventKind, command: "/bin/true" },
    ]);
    expect(reg.warnings.length).toBe(1);
    expect(reg.warnings[0]).toMatch(/unknown event kind/);
    expect(reg.all.length).toBe(1);
    // match() should be false for any event because the event is unrecognized.
    const m = reg.all[0] as CompiledHook;
    expect(m.match(makeSessionStartEvent({ sessionId: "s", cwd: "/", config: {} }))).toBe(false);
  });

  it("warns when matcher is set on events that ignore matchers", () => {
    const reg = new HookRegistry([
      { event: "SessionStart", matcher: "anything", command: "/bin/true", name: "h" },
    ]);
    expect(reg.warnings.some((w) => w.includes("is ignored for event kind SessionStart"))).toBe(
      true,
    );
    const hook = reg.all[0] as CompiledHook;
    // match-all behavior despite the ignored matcher
    expect(hook.match(makeSessionStartEvent({ sessionId: "s", cwd: "/", config: {} }))).toBe(true);
  });

  it("compiles invalid tool matcher as no-op with warning", () => {
    const reg = new HookRegistry([
      { event: "PreToolUse", matcher: "Bash(", command: "/bin/true", name: "broken" },
    ]);
    expect(reg.warnings.some((w) => w.includes("broken"))).toBe(true);
    const hook = reg.all[0] as CompiledHook;
    expect(
      hook.match(
        makePreToolUseEvent({
          sessionId: "s",
          toolName: "Bash",
          toolInput: { command: "ls" },
          callId: "c",
        }),
      ),
    ).toBe(false);
  });

  it("undefined matcher = match all for that kind", () => {
    const reg = new HookRegistry([{ event: "PreToolUse", command: "/bin/true", name: "any" }]);
    const hook = reg.all[0] as CompiledHook;
    expect(
      hook.match(
        makePreToolUseEvent({ sessionId: "s", toolName: "X", toolInput: {}, callId: "c" }),
      ),
    ).toBe(true);
    // but not for other event kinds
    expect(hook.match(makeSessionStartEvent({ sessionId: "s", cwd: "/", config: {} }))).toBe(false);
  });
});

describe("HookRegistry — matcher semantics", () => {
  it("PreToolUse 'Bash(git *)' matches 'git status' but not 'ls'", () => {
    const reg = new HookRegistry([
      { event: "PreToolUse", matcher: "Bash(git *)", command: "/bin/true", name: "g" },
    ]);
    const hook = reg.all[0] as CompiledHook;
    expect(
      hook.match(
        makePreToolUseEvent({
          sessionId: "s",
          toolName: "Bash",
          toolInput: { command: "git status" },
          callId: "c",
        }),
      ),
    ).toBe(true);
    expect(
      hook.match(
        makePreToolUseEvent({
          sessionId: "s",
          toolName: "Bash",
          toolInput: { command: "ls" },
          callId: "c",
        }),
      ),
    ).toBe(false);
  });

  it("PostToolUse matcher behaves like PreToolUse", () => {
    const reg = new HookRegistry([
      { event: "PostToolUse", matcher: "Write(src/**)", command: "/bin/true", name: "w" },
    ]);
    const hook = reg.all[0] as CompiledHook;
    expect(
      hook.match(
        makePostToolUseEvent({
          sessionId: "s",
          toolName: "Write",
          toolInput: { file_path: "src/foo.ts" },
          toolResult: null,
          callId: "c",
          durationMs: 1,
        }),
      ),
    ).toBe(true);
    expect(
      hook.match(
        makePostToolUseEvent({
          sessionId: "s",
          toolName: "Write",
          toolInput: { file_path: "docs/foo.md" },
          toolResult: null,
          callId: "c",
          durationMs: 1,
        }),
      ),
    ).toBe(false);
  });

  it("UserPromptSubmit matches against prompt head", () => {
    const reg = new HookRegistry([
      { event: "UserPromptSubmit", matcher: "hello*", command: "/bin/true", name: "p" },
    ]);
    const hook = reg.all[0] as CompiledHook;
    expect(hook.match(makeUserPromptSubmitEvent({ sessionId: "s", prompt: "hello world" }))).toBe(
      true,
    );
    expect(hook.match(makeUserPromptSubmitEvent({ sessionId: "s", prompt: "goodbye" }))).toBe(
      false,
    );
  });
});

describe("HookRegistry.hooksFor", () => {
  it("filters by event kind and predicate", () => {
    const configs: HookConfig[] = [
      { event: "PreToolUse", matcher: "Bash", command: "/bin/a", name: "a" },
      { event: "PreToolUse", matcher: "Write", command: "/bin/b", name: "b" },
      { event: "PostToolUse", command: "/bin/c", name: "c" },
    ];
    const reg = new HookRegistry(configs);
    const hooks = reg.hooksFor(
      makePreToolUseEvent({
        sessionId: "s",
        toolName: "Bash",
        toolInput: { command: "ls" },
        callId: "c",
      }),
    );
    expect(hooks.map((h) => h.name)).toEqual(["a"]);
  });

  it("preserves declaration order", () => {
    const reg = new HookRegistry([
      { event: "PreToolUse", command: "/bin/1", name: "first" },
      { event: "PreToolUse", command: "/bin/2", name: "second" },
      { event: "PreToolUse", command: "/bin/3", name: "third" },
    ]);
    const hooks = reg.hooksFor(
      makePreToolUseEvent({ sessionId: "s", toolName: "X", toolInput: {}, callId: "c" }),
    );
    expect(hooks.map((h) => h.name)).toEqual(["first", "second", "third"]);
  });
});

describe("runHooksWith — composition", () => {
  it("returns neutral when no hooks match", async () => {
    const { runner } = recorder({});
    const result = await runHooksWith(runner, {
      event: makePreToolUseEvent({
        sessionId: "s",
        toolName: "X",
        toolInput: {},
        callId: "c",
      }),
      sessionId: "s",
      hooks: [],
    });
    expect(result.decision).toBe("neutral");
    expect(result.outcomes.length).toBe(0);
  });

  it("fires hooks in declaration order and records all outcomes", async () => {
    const reg = new HookRegistry([
      { event: "PreToolUse", command: "/bin/1", name: "a" },
      { event: "PreToolUse", command: "/bin/2", name: "b" },
      { event: "PreToolUse", command: "/bin/3", name: "c" },
    ]);
    const event = makePreToolUseEvent({
      sessionId: "s",
      toolName: "X",
      toolInput: {},
      callId: "id",
    });
    const { runner, calls } = recorder({});
    const result = await runHooksWith(runner, {
      event,
      sessionId: "s",
      hooks: reg.hooksFor(event),
    });
    expect(calls).toEqual(["a", "b", "c"]);
    expect(result.outcomes.length).toBe(3);
    expect(result.decision).toBe("neutral");
  });

  it("deny-wins with firstDeny reason + denyingHookName", async () => {
    const reg = new HookRegistry([
      { event: "PreToolUse", command: "/bin/a", name: "allow" },
      { event: "PreToolUse", command: "/bin/m", name: "modify" },
      { event: "PreToolUse", command: "/bin/d", name: "deny" },
    ]);
    const event = makePreToolUseEvent({
      sessionId: "s",
      toolName: "X",
      toolInput: {},
      callId: "id",
    });
    const { runner } = recorder({
      allow: fakeOutcome("allow", "PreToolUse", "allow"),
      modify: fakeOutcome("modify", "PreToolUse", "modify", {
        modified: {
          sessionId: "s",
          toolName: "X",
          toolInput: { changed: true },
          callId: "id",
        },
      }),
      deny: fakeOutcome("deny", "PreToolUse", "deny", { reason: "nope" }),
    });
    const result = await runHooksWith(runner, {
      event,
      sessionId: "s",
      hooks: reg.hooksFor(event),
    });
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("nope");
    expect(result.denyingHookName).toBe("deny");
    expect(result.outcomes.length).toBe(3);
  });

  it("last-write-wins for modify decisions", async () => {
    const reg = new HookRegistry([
      { event: "PreToolUse", command: "/bin/1", name: "m1" },
      { event: "PreToolUse", command: "/bin/2", name: "m2" },
    ]);
    const event = makePreToolUseEvent({
      sessionId: "s",
      toolName: "X",
      toolInput: {},
      callId: "id",
    });
    const { runner } = recorder({
      m1: fakeOutcome("m1", "PreToolUse", "modify", {
        modified: { sessionId: "s", toolName: "X", toolInput: { v: 1 }, callId: "id" },
      }),
      m2: fakeOutcome("m2", "PreToolUse", "modify", {
        modified: { sessionId: "s", toolName: "X", toolInput: { v: 2 }, callId: "id" },
      }),
    });
    const result = await runHooksWith(runner, {
      event,
      sessionId: "s",
      hooks: reg.hooksFor(event),
    });
    expect(result.decision).toBe("modify");
    expect((result.modified?.toolInput as { v: number } | undefined)?.v).toBe(2);
  });

  it("returns allow when at least one hook allowed and none denied/modified", async () => {
    const reg = new HookRegistry([{ event: "PreToolUse", command: "/bin/a", name: "a" }]);
    const event = makePreToolUseEvent({
      sessionId: "s",
      toolName: "X",
      toolInput: {},
      callId: "id",
    });
    const { runner } = recorder({
      a: fakeOutcome("a", "PreToolUse", "allow"),
    });
    const result = await runHooksWith(runner, {
      event,
      sessionId: "s",
      hooks: reg.hooksFor(event),
    });
    expect(result.decision).toBe("allow");
  });

  it("calls the audit sink once per blocking outcome", async () => {
    const reg = new HookRegistry([
      { event: "PreToolUse", command: "/bin/1", name: "a" },
      { event: "PreToolUse", command: "/bin/2", name: "b" },
    ]);
    const event = makePreToolUseEvent({
      sessionId: "s",
      toolName: "X",
      toolInput: {},
      callId: "id",
    });
    const { runner } = recorder({});
    const audit = vi.fn();
    await runHooksWith(runner, {
      event,
      sessionId: "s",
      hooks: reg.hooksFor(event),
      audit,
    });
    expect(audit).toHaveBeenCalledTimes(2);
  });
});

describe("runHooksWith — non-blocking PostToolUse", () => {
  it("fire-and-forget: never awaits, stub outcome has warn=blocking=false", async () => {
    const reg = new HookRegistry([
      {
        event: "PostToolUse",
        command: "/bin/slow",
        name: "slow",
        blocking: false,
      },
    ]);
    const event = makePostToolUseEvent({
      sessionId: "s",
      toolName: "X",
      toolInput: {},
      toolResult: null,
      callId: "id",
      durationMs: 1,
    });

    let resolved = false;
    const runner: RunSingleHookFn = () =>
      new Promise((r) => {
        setTimeout(() => {
          resolved = true;
          r(fakeOutcome("slow", "PostToolUse", "neutral"));
        }, 5_000);
      });

    const t0 = Date.now();
    const result = await runHooksWith(runner, {
      event,
      sessionId: "s",
      hooks: reg.hooksFor(event),
    });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(500); // did not wait for the 5 s hook
    expect(resolved).toBe(false);
    expect(result.outcomes.length).toBe(1);
    expect(result.outcomes[0]?.warn).toBe("blocking=false");
    expect(result.decision).toBe("neutral");
  });
});
