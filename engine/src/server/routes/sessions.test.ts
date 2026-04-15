/**
 * Phase 10.5 — `/v1/sessions` route tests.
 *
 * Stubs a minimal {@link SessionManager} + {@link RunManager} and drives the
 * routes via `app.request(new Request(...))` without booting a server.
 */

import { EventEmitter } from "node:events";

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

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
import { registerSessionRoutes } from "./sessions.js";

function makeRunEntry(overrides: Partial<RunEntry> = {}): RunEntry {
  return {
    runId: "r1",
    sessionId: "s1",
    status: "running",
    buffer: [],
    emitter: new EventEmitter(),
    abortController: new AbortController(),
    completedAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeRunStub(): { manager: RunManager; created: CreateRunOptions[] } {
  const created: CreateRunOptions[] = [];
  const manager: RunManager = {
    create(o: CreateRunOptions) {
      created.push(o);
      return Promise.resolve(makeRunEntry({ runId: `r${created.length}`, sessionId: "s-new" }));
    },
    get() {
      return undefined;
    },
    cancel() {
      return false;
    },
    steer() {
      return true;
    },
    resume(_id: string, _o: ResumeRunOptions) {
      return Promise.resolve(makeRunEntry());
    },
    snapshot(): RunManagerSnapshot {
      return { activeRuns: 0, totalRuns: 0, completedRuns: 0 };
    },
    shutdown() {
      return Promise.resolve();
    },
  };
  return { manager, created };
}

function makeSessionStub(sessions: SessionSummary[]): {
  manager: SessionManager;
  deleted: string[];
  attached: string[];
} {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const deleted: string[] = [];
  const attached: string[] = [];
  const manager: SessionManager = {
    listSessions: () => [...byId.values()],
    getSession: (id) => byId.get(id),
    deleteSession: (id) => {
      if (!byId.has(id)) return false;
      byId.delete(id);
      deleted.push(id);
      return true;
    },
    listMessages: () => [],
    listPendingPermissions: () => [],
    replyPermission: () => true,
    onEvent: () => () => undefined,
    attachRun: (run) => {
      attached.push(run.runId);
    },
  };
  return { manager, deleted, attached };
}

function buildApp(rm: RunManager, sm: SessionManager): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  registerSessionRoutes(app, {
    runManager: rm,
    sessionManager: sm,
    logger: createLogger({ name: "test", level: "silent" }),
  });
  return app;
}

describe("GET /v1/sessions", () => {
  it("returns parsed list", async () => {
    const { manager: rm } = makeRunStub();
    const { manager: sm } = makeSessionStub([
      { id: "s1", createdAt: 1, status: "running", latestRunId: "r1" },
      { id: "s2", createdAt: 2, status: "completed", latestRunId: "r2" },
    ]);
    const app = buildApp(rm, sm);
    const res = await app.request(new Request("http://localhost/v1/sessions"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((b) => b.id).sort()).toEqual(["s1", "s2"]);
  });

  it("returns an empty array when no sessions", async () => {
    const { manager: rm } = makeRunStub();
    const { manager: sm } = makeSessionStub([]);
    const app = buildApp(rm, sm);
    const res = await app.request(new Request("http://localhost/v1/sessions"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("POST /v1/sessions", () => {
  it("400 on missing prompt", async () => {
    const { manager: rm } = makeRunStub();
    const { manager: sm } = makeSessionStub([]);
    const app = buildApp(rm, sm);
    const res = await app.request(
      new Request("http://localhost/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400 on unknown field (strict)", async () => {
    const { manager: rm } = makeRunStub();
    const { manager: sm } = makeSessionStub([]);
    const app = buildApp(rm, sm);
    const res = await app.request(
      new Request("http://localhost/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi", bogus: 1 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("201 creates a run, attaches it, returns {runId, sessionId}", async () => {
    const { manager: rm, created } = makeRunStub();
    const { manager: sm, attached } = makeSessionStub([]);
    const app = buildApp(rm, sm);
    const res = await app.request(
      new Request("http://localhost/v1/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "hi", model: "claude-sonnet" }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { runId: string; sessionId: string };
    expect(body.runId).toBeTruthy();
    expect(body.sessionId).toBe("s-new");
    expect(created).toHaveLength(1);
    expect(created[0]?.prompt).toBe("hi");
    expect(attached).toHaveLength(1);
  });
});

describe("GET /v1/sessions/:id", () => {
  it("404 when missing", async () => {
    const { manager: rm } = makeRunStub();
    const { manager: sm } = makeSessionStub([]);
    const app = buildApp(rm, sm);
    const res = await app.request(new Request("http://localhost/v1/sessions/nope"));
    expect(res.status).toBe(404);
  });

  it("returns summary when found", async () => {
    const { manager: rm } = makeRunStub();
    const { manager: sm } = makeSessionStub([
      { id: "s1", createdAt: 5, status: "running", latestRunId: "r1" },
    ]);
    const app = buildApp(rm, sm);
    const res = await app.request(new Request("http://localhost/v1/sessions/s1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe("s1");
    expect(body.status).toBe("running");
  });
});

describe("DELETE /v1/sessions/:id", () => {
  it("404 when missing", async () => {
    const { manager: rm } = makeRunStub();
    const { manager: sm } = makeSessionStub([]);
    const app = buildApp(rm, sm);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/nope", { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });

  it("200 and deletes", async () => {
    const { manager: rm } = makeRunStub();
    const { manager: sm, deleted } = makeSessionStub([
      { id: "s1", createdAt: 1, status: "running", latestRunId: "r1" },
    ]);
    const app = buildApp(rm, sm);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/s1", { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    expect(deleted).toEqual(["s1"]);
  });
});
