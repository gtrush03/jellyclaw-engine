/**
 * Phase 10.5 — `/v1/sessions/:id/messages` route tests.
 */

import { EventEmitter } from "node:events";

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../events.js";
import { createLogger } from "../../logger.js";
import type { SessionManager, SessionSummary } from "../session-manager.js";
import type {
  AppVariables,
  CreateRunOptions,
  ResumeRunOptions,
  RunEntry,
  RunManager,
  RunManagerSnapshot,
} from "../types.js";
import { registerMessageRoutes } from "./messages.js";

function makeRunStub(): {
  manager: RunManager;
  steered: Array<{ id: string; text: string }>;
  steerResult: boolean;
  setSteerResult: (v: boolean) => void;
} {
  const steered: Array<{ id: string; text: string }> = [];
  let steerResult = true;
  const manager: RunManager = {
    create(_o: CreateRunOptions) {
      return Promise.resolve({
        runId: "r",
        sessionId: "s",
        status: "running",
        buffer: [],
        emitter: new EventEmitter(),
        abortController: new AbortController(),
        completedAt: null,
        createdAt: 0,
      } satisfies RunEntry);
    },
    get: () => undefined,
    cancel: () => false,
    steer(id, text) {
      steered.push({ id, text });
      return steerResult;
    },
    resume: (_id: string, _o: ResumeRunOptions) => Promise.reject(new Error("unused")),
    snapshot: (): RunManagerSnapshot => ({ activeRuns: 0, totalRuns: 0, completedRuns: 0 }),
    shutdown: () => Promise.resolve(),
  };
  return {
    manager,
    steered,
    get steerResult() {
      return steerResult;
    },
    setSteerResult: (v: boolean) => {
      steerResult = v;
    },
  };
}

function makeSm(session: SessionSummary | undefined, messages: AgentEvent[]): SessionManager {
  return {
    listSessions: () => (session ? [session] : []),
    getSession: (id) => (session && session.id === id ? session : undefined),
    deleteSession: () => false,
    listMessages: () => messages,
    listPendingPermissions: () => [],
    replyPermission: () => true,
    onEvent: () => () => undefined,
    attachRun: () => undefined,
  };
}

function buildApp(rm: RunManager, sm: SessionManager): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  registerMessageRoutes(app, {
    runManager: rm,
    sessionManager: sm,
    logger: createLogger({ name: "test", level: "silent" }),
  });
  return app;
}

describe("GET /v1/sessions/:id/messages", () => {
  it("404 when session missing", async () => {
    const { manager: rm } = makeRunStub();
    const app = buildApp(rm, makeSm(undefined, []));
    const res = await app.request(new Request("http://localhost/v1/sessions/nope/messages"));
    expect(res.status).toBe(404);
  });

  it("returns {messages: []} shape", async () => {
    const { manager: rm } = makeRunStub();
    const msg: AgentEvent = {
      type: "agent.message",
      session_id: "s1",
      ts: 1,
      seq: 0,
      delta: "hi",
      final: true,
    };
    const sm = makeSm(
      { id: "s1", createdAt: 0, status: "running", latestRunId: "r1" },
      [msg],
    );
    const app = buildApp(rm, sm);
    const res = await app.request(new Request("http://localhost/v1/sessions/s1/messages"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(1);
  });
});

describe("POST /v1/sessions/:id/messages", () => {
  it("400 on empty text", async () => {
    const { manager: rm } = makeRunStub();
    const sm = makeSm({ id: "s1", createdAt: 0, status: "running", latestRunId: "r1" }, []);
    const app = buildApp(rm, sm);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/s1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("404 when session missing", async () => {
    const { manager: rm } = makeRunStub();
    const app = buildApp(rm, makeSm(undefined, []));
    const res = await app.request(
      new Request("http://localhost/v1/sessions/nope/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("409 when session terminal", async () => {
    const { manager: rm } = makeRunStub();
    const sm = makeSm({ id: "s1", createdAt: 0, status: "completed", latestRunId: "r1" }, []);
    const app = buildApp(rm, sm);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/s1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("202 accepted — funnels to runManager.steer", async () => {
    const { manager: rm, steered } = makeRunStub();
    const sm = makeSm({ id: "s1", createdAt: 0, status: "running", latestRunId: "r-latest" }, []);
    const app = buildApp(rm, sm);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/s1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "continue please" }),
      }),
    );
    expect(res.status).toBe(202);
    expect(steered).toEqual([{ id: "r-latest", text: "continue please" }]);
  });

  it("409 when steer returns false", async () => {
    const { manager: rm, setSteerResult } = makeRunStub();
    setSteerResult(false);
    const sm = makeSm({ id: "s1", createdAt: 0, status: "running", latestRunId: "r1" }, []);
    const app = buildApp(rm, sm);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/s1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      }),
    );
    expect(res.status).toBe(409);
  });
});
