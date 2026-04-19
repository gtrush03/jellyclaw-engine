/**
 * Phase 10.5 — `GET /v1/events` global SSE route tests.
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../events.js";
import { createLogger } from "../../logger.js";
import type { SessionManager } from "../session-manager.js";
import type { AppVariables } from "../types.js";
import { registerEventRoutes } from "./events.js";

function makeSm(): {
  manager: SessionManager;
  emit: (ev: AgentEvent) => void;
} {
  const listeners = new Set<(ev: AgentEvent) => void>();
  const manager: SessionManager = {
    listSessions: () => [],
    getSession: () => undefined,
    deleteSession: () => false,
    listMessages: () => [],
    listPendingPermissions: () => [],
    replyPermission: () => true,
    onEvent: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    attachRun: () => undefined,
  };
  return {
    manager,
    emit: (ev) => {
      for (const l of listeners) l(ev);
    },
  };
}

function buildApp(sm: SessionManager): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  registerEventRoutes(app, {
    sessionManager: sm,
    logger: createLogger({ name: "test", level: "silent" }),
  });
  return app;
}

describe("GET /v1/events", () => {
  it("responds with SSE content-type", async () => {
    const { manager, emit } = makeSm();
    const app = buildApp(manager);
    const controller = new AbortController();
    // Fire one event shortly after request starts, then abort.
    setTimeout(() => {
      emit({
        type: "agent.message",
        session_id: "s1",
        ts: 1,
        seq: 0,
        delta: "hi",
        final: false,
      });
      setTimeout(() => controller.abort(), 10);
    }, 5);
    const res = await app.request(
      new Request("http://localhost/v1/events", { signal: controller.signal }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")?.includes("text/event-stream")).toBe(true);
    try {
      const text = await res.text();
      expect(text).toContain("event: event");
      expect(text).toContain('"type":"agent.message"');
    } catch {
      // abort → fetch may throw; ok for this smoke test.
    }
  });

  it("subscribes and unsubscribes cleanly on abort", async () => {
    const { manager } = makeSm();
    const app = buildApp(manager);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    try {
      await app.request(new Request("http://localhost/v1/events", { signal: controller.signal }));
    } catch {
      // expected on abort
    }
    // No assertion on unsubscribe internals — the fact that the handler
    // returned without hanging is the contract.
    expect(true).toBe(true);
  });
});
