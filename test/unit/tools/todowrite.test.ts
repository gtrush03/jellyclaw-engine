/**
 * Unit tests for the TodoWrite tool.
 *
 * Covers:
 *   - Full-list replacement semantics (not delta).
 *   - `MultipleInProgressError` when >1 todo is in_progress.
 *   - Accepts single and zero in_progress.
 *   - Empty list clears state.
 *   - `ctx.session.update` is spied and called exactly once with the new list.
 *   - Missing session throws `SessionUnavailableError`.
 *   - Zod validation + schema parity + registry registration.
 */

import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

import { createLogger } from "../../../engine/src/logger.js";
import { getTool } from "../../../engine/src/tools/index.js";
import { allowAll } from "../../../engine/src/tools/permissions.js";
import { todowriteTool } from "../../../engine/src/tools/todowrite.js";
import {
  MultipleInProgressError,
  type SessionHandle,
  type SessionState,
  SessionUnavailableError,
  type TodoItem,
  type ToolContext,
} from "../../../engine/src/tools/types.js";
import todowriteSchema from "../../fixtures/tools/claude-code-schemas/todowrite.json" with {
  type: "json",
};

interface TestSession {
  readonly handle: SessionHandle;
  readonly state: { todos: TodoItem[] };
  readonly update: ReturnType<typeof vi.fn>;
}

function makeSession(): TestSession {
  const state: { todos: TodoItem[] } = { todos: [] };
  const update = vi.fn((patch: Partial<SessionState>) => {
    if (patch.todos !== undefined) {
      state.todos = [...patch.todos];
    }
  });
  const handle: SessionHandle = {
    get state() {
      return state as SessionState;
    },
    update,
  };
  return { handle, state, update };
}

function makeCtx(session?: SessionHandle): ToolContext {
  const base: ToolContext = {
    cwd: process.cwd(),
    sessionId: "test-session",
    readCache: new Set<string>(),
    abort: new AbortController().signal,
    logger: createLogger({ level: "silent" }),
    permissions: allowAll,
  };
  if (session) {
    return { ...base, session };
  }
  return base;
}

describe("todowriteTool — replace semantics", () => {
  it("replaces the todo list (does not merge)", async () => {
    const sess = makeSession();
    // Seed with 2 todos via the spy.
    sess.handle.update({
      todos: [
        { content: "old A", status: "pending", activeForm: "Doing A" },
        { content: "old B", status: "pending", activeForm: "Doing B" },
      ],
    });
    expect(sess.state.todos).toHaveLength(2);

    const newList: TodoItem[] = [{ content: "new", status: "pending", activeForm: "Doing new" }];
    const res = await todowriteTool.handler({ todos: newList }, makeCtx(sess.handle));

    expect(sess.state.todos).toHaveLength(1);
    expect(sess.state.todos[0]?.content).toBe("new");
    // The second update() call (the one under test) received the new list.
    expect(sess.update).toHaveBeenLastCalledWith({ todos: newList });
    expect(res).toEqual({ todos: newList, count: 1 });
  });

  it("empty list clears todos", async () => {
    const sess = makeSession();
    sess.handle.update({
      todos: [{ content: "stale", status: "pending", activeForm: "Doing stale" }],
    });
    expect(sess.state.todos).toHaveLength(1);

    const res = await todowriteTool.handler({ todos: [] }, makeCtx(sess.handle));
    expect(sess.state.todos).toEqual([]);
    expect(res).toEqual({ todos: [], count: 0 });
  });

  it("calls session.update exactly once with the full new list", async () => {
    const sess = makeSession();
    const todos: TodoItem[] = [
      { content: "a", status: "pending", activeForm: "Doing a" },
      { content: "b", status: "in_progress", activeForm: "Doing b" },
    ];
    await todowriteTool.handler({ todos }, makeCtx(sess.handle));
    expect(sess.update).toHaveBeenCalledTimes(1);
    expect(sess.update).toHaveBeenCalledWith({ todos });
  });
});

describe("todowriteTool — in_progress invariant", () => {
  it("rejects >1 in_progress with MultipleInProgressError", async () => {
    const sess = makeSession();
    const todos: TodoItem[] = [
      { content: "a", status: "in_progress", activeForm: "Doing a" },
      { content: "b", status: "in_progress", activeForm: "Doing b" },
      { content: "c", status: "pending", activeForm: "Doing c" },
    ];
    await expect(todowriteTool.handler({ todos }, makeCtx(sess.handle))).rejects.toBeInstanceOf(
      MultipleInProgressError,
    );
    // Verify details.count
    try {
      await todowriteTool.handler({ todos }, makeCtx(sess.handle));
      expect.unreachable("handler should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MultipleInProgressError);
      expect((err as MultipleInProgressError).details).toMatchObject({ count: 2 });
    }
    // update MUST NOT have been called.
    expect(sess.update).not.toHaveBeenCalled();
  });

  it("accepts exactly one in_progress", async () => {
    const sess = makeSession();
    const todos: TodoItem[] = [
      { content: "a", status: "in_progress", activeForm: "Doing a" },
      { content: "b", status: "pending", activeForm: "Doing b" },
      { content: "c", status: "pending", activeForm: "Doing c" },
    ];
    const res = await todowriteTool.handler({ todos }, makeCtx(sess.handle));
    expect(res.count).toBe(3);
    expect(sess.update).toHaveBeenCalledTimes(1);
  });

  it("accepts zero in_progress", async () => {
    const sess = makeSession();
    const todos: TodoItem[] = [
      { content: "a", status: "pending", activeForm: "Doing a" },
      { content: "b", status: "completed", activeForm: "Doing b" },
    ];
    const res = await todowriteTool.handler({ todos }, makeCtx(sess.handle));
    expect(res.count).toBe(2);
    expect(sess.update).toHaveBeenCalledTimes(1);
  });
});

describe("todowriteTool — session requirement", () => {
  it("throws SessionUnavailableError when ctx.session is missing", async () => {
    await expect(
      todowriteTool.handler(
        { todos: [{ content: "x", status: "pending", activeForm: "Doing x" }] },
        makeCtx(),
      ),
    ).rejects.toBeInstanceOf(SessionUnavailableError);
  });
});

describe("todowriteTool — return shape", () => {
  it("returns { todos, count } mirroring the input list", async () => {
    const sess = makeSession();
    const todos: TodoItem[] = [
      { content: "a", status: "pending", activeForm: "Doing a", id: "t1" },
      { content: "b", status: "completed", activeForm: "Doing b" },
    ];
    const res = await todowriteTool.handler({ todos }, makeCtx(sess.handle));
    expect(res.todos).toEqual(todos);
    expect(res.count).toBe(2);
  });
});

describe("todowriteTool — schema validation", () => {
  it("rejects non-array todos with ZodError", async () => {
    const sess = makeSession();
    await expect(
      todowriteTool.handler(
        { todos: "not an array" } as unknown as { todos: TodoItem[] },
        makeCtx(sess.handle),
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(sess.update).not.toHaveBeenCalled();
  });

  it("rejects items missing required fields with ZodError", async () => {
    const sess = makeSession();
    await expect(
      todowriteTool.handler(
        { todos: [{ content: "only content" }] } as unknown as { todos: TodoItem[] },
        makeCtx(sess.handle),
      ),
    ).rejects.toBeInstanceOf(ZodError);
    expect(sess.update).not.toHaveBeenCalled();
  });

  it("rejects empty content with ZodError", async () => {
    const sess = makeSession();
    await expect(
      todowriteTool.handler(
        { todos: [{ content: "", status: "pending", activeForm: "Doing x" }] },
        makeCtx(sess.handle),
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it("rejects invalid status enum with ZodError", async () => {
    const sess = makeSession();
    await expect(
      todowriteTool.handler(
        {
          todos: [{ content: "x", status: "bogus", activeForm: "Doing x" } as unknown as TodoItem],
        },
        makeCtx(sess.handle),
      ),
    ).rejects.toBeInstanceOf(ZodError);
  });
});

describe("todowriteTool — schema parity + registry", () => {
  it("inputSchema deep-equals the claude-code JSON fixture", () => {
    expect(todowriteTool.inputSchema).toEqual(todowriteSchema);
  });

  it("is registered in the builtin registry under 'TodoWrite'", () => {
    expect(getTool("TodoWrite")).toBe(todowriteTool);
  });

  it("overridesOpenCode is true and name is exactly 'TodoWrite'", () => {
    expect(todowriteTool.name).toBe("TodoWrite");
    expect(todowriteTool.overridesOpenCode).toBe(true);
  });
});
