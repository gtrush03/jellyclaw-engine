/**
 * Phase 10.02 — route handler tests.
 *
 * We mount `registerRunRoutes` onto a fresh Hono app with a stubbed
 * `RunManager` and use `app.request(new Request(...))` to drive the routes
 * without booting a network server.
 */

import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";

import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../../logger.js";
import { SessionPaths } from "../../session/paths.js";
import type {
  AppVariables,
  CreateRunOptions,
  ResumeRunOptions,
  RunEntry,
  RunManager,
  RunManagerSnapshot,
} from "../types.js";
import { __setStreamRunEventsForTests, registerRunRoutes } from "./runs.js";

// ---------------------------------------------------------------------------
// Stub RunManager
// ---------------------------------------------------------------------------

function makeRunEntry(overrides: Partial<RunEntry> = {}): RunEntry {
  return {
    runId: "run-1",
    sessionId: "sess-1",
    status: "running",
    buffer: [],
    emitter: new EventEmitter(),
    abortController: new AbortController(),
    completedAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

interface StubCalls {
  create: CreateRunOptions[];
  steer: Array<{ id: string; text: string }>;
  cancel: string[];
  resume: Array<{ id: string; opts: ResumeRunOptions }>;
}

function makeStub(
  opts: {
    runs?: Map<string, RunEntry>;
    onCreate?: (o: CreateRunOptions) => Promise<RunEntry>;
    onResume?: (id: string, o: ResumeRunOptions) => Promise<RunEntry>;
    onSteer?: (id: string, t: string) => boolean;
    onCancel?: (id: string) => boolean;
  } = {},
): { manager: RunManager; calls: StubCalls } {
  const calls: StubCalls = { create: [], steer: [], cancel: [], resume: [] };
  const runs = opts.runs ?? new Map<string, RunEntry>();
  const manager: RunManager = {
    create(o) {
      calls.create.push(o);
      if (opts.onCreate) return opts.onCreate(o);
      const entry = makeRunEntry({ runId: `run-${calls.create.length}` });
      runs.set(entry.runId, entry);
      return Promise.resolve(entry);
    },
    get(id) {
      return runs.get(id);
    },
    cancel(id) {
      calls.cancel.push(id);
      if (opts.onCancel) return opts.onCancel(id);
      return runs.has(id);
    },
    steer(id, text) {
      calls.steer.push({ id, text });
      if (opts.onSteer) return opts.onSteer(id, text);
      const r = runs.get(id);
      if (!r || r.status !== "running") return false;
      return true;
    },
    resume(id, o) {
      calls.resume.push({ id, opts: o });
      if (opts.onResume) return opts.onResume(id, o);
      const fresh = makeRunEntry({ runId: `${id}-resumed`, sessionId: "sess-resumed" });
      runs.set(fresh.runId, fresh);
      return Promise.resolve(fresh);
    },
    snapshot(): RunManagerSnapshot {
      return { activeRuns: 0, totalRuns: 0, completedRuns: 0 };
    },
    shutdown(_grace) {
      return Promise.resolve();
    },
  };
  return { manager, calls };
}

function buildApp(manager: RunManager): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  registerRunRoutes(app, {
    runManager: manager,
    sessionPaths: new SessionPaths({ home: tmpdir() }),
    logger: createLogger({ name: "test", level: "silent" }),
    version: "0.0.0-test",
  });
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  __setStreamRunEventsForTests(async ({ stream }) => {
    await stream.writeSSE({ event: "test", data: "ok", id: "1" });
    await stream.close();
  });
});

describe("POST /v1/runs", () => {
  it("rejects missing prompt with 400 + issues", async () => {
    const { manager } = makeStub();
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: unknown[] };
    expect(body.error).toBe("bad_request");
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it("rejects empty prompt string", async () => {
    const { manager } = makeStub();
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown fields (strict schema)", async () => {
    const { manager } = makeStub();
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi", notARealField: 1 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("creates a run and returns runId + sessionId", async () => {
    const { manager, calls } = makeStub();
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hello world", model: "claude-sonnet-4-6" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string; sessionId: string };
    expect(body.runId).toBeTruthy();
    expect(body.sessionId).toBeTruthy();
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]?.prompt).toBe("hello world");
    expect(calls.create[0]?.model).toBe("claude-sonnet-4-6");
  });
});

describe("POST /v1/runs/:id/steer", () => {
  it("404 when run missing", async () => {
    const { manager } = makeStub();
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs/nope/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("run_not_found");
  });

  it("409 when run is terminal", async () => {
    const runs = new Map<string, RunEntry>();
    const done = makeRunEntry({ runId: "r1", status: "completed", completedAt: Date.now() });
    runs.set("r1", done);
    const { manager } = makeStub({ runs });
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs/r1/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; status: string };
    expect(body.error).toBe("run_terminal");
    expect(body.status).toBe("completed");
  });

  it("202 when steer accepted and funnels through runManager.steer", async () => {
    const runs = new Map<string, RunEntry>();
    runs.set("r1", makeRunEntry({ runId: "r1" }));
    const { manager, calls } = makeStub({ runs });
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs/r1/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "redirect please" }),
      }),
    );
    expect(res.status).toBe(202);
    expect(calls.steer).toEqual([{ id: "r1", text: "redirect please" }]);
  });

  it("400 on empty text", async () => {
    const runs = new Map<string, RunEntry>();
    runs.set("r1", makeRunEntry({ runId: "r1" }));
    const { manager } = makeStub({ runs });
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs/r1/steer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/runs/:id/cancel", () => {
  it("404 when run missing", async () => {
    const { manager } = makeStub();
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs/nope/cancel", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });

  it("202 and aborts via runManager.cancel", async () => {
    const runs = new Map<string, RunEntry>();
    runs.set("r1", makeRunEntry({ runId: "r1" }));
    const { manager, calls } = makeStub({ runs });
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs/r1/cancel", { method: "POST" }),
    );
    expect(res.status).toBe(202);
    expect(calls.cancel).toEqual(["r1"]);
  });
});

describe("POST /v1/runs/:id/resume", () => {
  it("404 when run missing", async () => {
    const { manager } = makeStub();
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs/nope/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "continue" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("201 returns new runId + sessionId", async () => {
    const runs = new Map<string, RunEntry>();
    runs.set("r1", makeRunEntry({ runId: "r1" }));
    const { manager, calls } = makeStub({ runs });
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs/r1/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "continue" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string; sessionId: string };
    expect(body.runId).toBe("r1-resumed");
    expect(body.sessionId).toBe("sess-resumed");
    expect(calls.resume).toEqual([{ id: "r1", opts: { prompt: "continue" } }]);
  });
});

describe("GET /v1/runs/:id/events", () => {
  it("404 when run missing", async () => {
    const { manager } = makeStub();
    const app = buildApp(manager);
    const res = await app.request(new Request("http://localhost/v1/runs/nope/events"));
    expect(res.status).toBe(404);
  });

  it("streams SSE when run exists (delegates to streamRunEvents)", async () => {
    const runs = new Map<string, RunEntry>();
    runs.set("r1", makeRunEntry({ runId: "r1" }));
    const { manager } = makeStub({ runs });
    let passedLastId: number | null = -1;
    __setStreamRunEventsForTests(async ({ stream, lastEventId }) => {
      passedLastId = lastEventId;
      await stream.writeSSE({ event: "t", data: "ok", id: "1" });
      await stream.close();
    });
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/runs/r1/events", {
        headers: { "Last-Event-Id": "42" },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")?.includes("text/event-stream")).toBe(true);
    // Consume body so the handler runs.
    const text = await res.text();
    expect(text).toContain("data: ok");
    expect(passedLastId).toBe(42);
  });
});
