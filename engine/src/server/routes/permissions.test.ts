/**
 * Phase 10.5 — `/v1/sessions/:id/permissions/*` route tests.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { createLogger } from "../../logger.js";
import type { PendingPermission, SessionManager, SessionSummary } from "../session-manager.js";
import type { AppVariables } from "../types.js";
import { registerPermissionRoutes } from "./permissions.js";

function makeSm(opts: {
  session?: SessionSummary;
  pending?: PendingPermission[];
  replyResult?: boolean;
}): { manager: SessionManager; replies: Array<{ s: string; p: string; r: string }> } {
  const replies: Array<{ s: string; p: string; r: string }> = [];
  const replyResult = opts.replyResult ?? true;
  const manager: SessionManager = {
    listSessions: () => (opts.session ? [opts.session] : []),
    getSession: (id) => (opts.session && opts.session.id === id ? opts.session : undefined),
    deleteSession: () => false,
    listMessages: () => [],
    listPendingPermissions: () => opts.pending ?? [],
    replyPermission: (s, p, r) => {
      replies.push({ s, p, r });
      return replyResult;
    },
    onEvent: () => () => undefined,
    attachRun: () => undefined,
  };
  return { manager, replies };
}

function buildApp(sm: SessionManager): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  registerPermissionRoutes(app, {
    sessionManager: sm,
    logger: createLogger({ name: "test", level: "silent" }),
  });
  return app;
}

describe("GET /v1/sessions/:id/permissions/pending", () => {
  it("404 when session missing", async () => {
    const { manager } = makeSm({});
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/nope/permissions/pending"),
    );
    expect(res.status).toBe(404);
  });

  it("returns {pending: []} when none", async () => {
    const { manager } = makeSm({
      session: { id: "s1", createdAt: 0, status: "running", latestRunId: "r1" },
    });
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/s1/permissions/pending"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pending: [] });
  });

  it("returns pending entries", async () => {
    const entry: PendingPermission = {
      id: "p1",
      sessionId: "s1",
      toolName: "bash",
      reason: "ls",
      inputPreview: { cmd: "ls" },
      askedAt: 1,
    };
    const { manager } = makeSm({
      session: { id: "s1", createdAt: 0, status: "running", latestRunId: "r1" },
      pending: [entry],
    });
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/s1/permissions/pending"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pending: PendingPermission[] };
    expect(body.pending).toHaveLength(1);
    expect(body.pending[0]?.id).toBe("p1");
  });
});

describe("POST /v1/sessions/:id/permissions/:permId(/reply)?", () => {
  it("400 on bad response value", async () => {
    const { manager } = makeSm({
      session: { id: "s1", createdAt: 0, status: "running", latestRunId: "r1" },
    });
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/s1/permissions/p1/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "maybe" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("404 when session missing", async () => {
    const { manager } = makeSm({});
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/nope/permissions/p1/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "once" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("404 when permission missing", async () => {
    const { manager } = makeSm({
      session: { id: "s1", createdAt: 0, status: "running", latestRunId: "r1" },
      replyResult: false,
    });
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/s1/permissions/px/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "once" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("200 on accept (canonical /reply path)", async () => {
    const { manager, replies } = makeSm({
      session: { id: "s1", createdAt: 0, status: "running", latestRunId: "r1" },
    });
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/s1/permissions/p1/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "once" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(replies).toEqual([{ s: "s1", p: "p1", r: "once" }]);
  });

  it("200 on accept (adapter-compat bare path, no /reply)", async () => {
    const { manager, replies } = makeSm({
      session: { id: "s1", createdAt: 0, status: "running", latestRunId: "r1" },
    });
    const app = buildApp(manager);
    const res = await app.request(
      new Request("http://localhost/v1/sessions/s1/permissions/p1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: "always" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(replies).toEqual([{ s: "s1", p: "p1", r: "always" }]);
  });
});
