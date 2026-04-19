/**
 * Phase 08 T3-02 — tests for `/v1/tui-token` and the underlying handoff ring.
 *
 * Coverage:
 *   - Issuance requires an Authorization: Bearer header (401 otherwise).
 *   - A freshly minted token verifies within its TTL.
 *   - A token is rejected after the TTL has elapsed.
 *   - A token issued against a different server session id is rejected
 *     (cross-session / cross-boot poisoning).
 *   - TTL bounds are enforced (max 600s).
 */

import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";

import { createAuthMiddleware } from "../auth.js";
import type { AppVariables } from "../types.js";
import { createTuiHandoff, registerTuiHandoffRoutes, verifyTuiToken } from "./tui-handoff.js";

const BEARER = "test-bearer-token-32-bytes-entro";

interface AppHarness {
  app: Hono<{ Variables: AppVariables }>;
  advance: (ms: number) => void;
  handoff: ReturnType<typeof createTuiHandoff>;
}

function buildApp(overrides: { serverSessionId?: string } = {}): AppHarness {
  let now = 1_700_000_000_000;
  const advance = (ms: number) => {
    now += ms;
  };
  const handoff = createTuiHandoff({
    now: () => now,
    ...(overrides.serverSessionId !== undefined
      ? { serverSessionId: overrides.serverSessionId }
      : {}),
  });
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", createAuthMiddleware({ authToken: BEARER }));
  registerTuiHandoffRoutes(app, { handoff });
  return { app, advance, handoff };
}

function issueToken(app: Hono<{ Variables: AppVariables }>, body: unknown = {}): Promise<Response> {
  return app.request("/v1/tui-token", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BEARER}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/tui-token — auth gate", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const { app } = buildApp();
    const res = await app.request("/v1/tui-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("rejects non-bearer auth schemes", async () => {
    const { app } = buildApp();
    const res = await app.request("/v1/tui-token", {
      method: "POST",
      headers: {
        Authorization: "Basic dXNlcjpwYXNz",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("accepts authenticated callers and returns a token + expiry", async () => {
    const { app } = buildApp();
    const res = await issueToken(app, { ttl_seconds: 60 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expires_at: string };
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(body.expires_at))).toBe(false);
  });

  it("rejects ttl_seconds above the max (600)", async () => {
    const { app } = buildApp();
    const res = await issueToken(app, { ttl_seconds: 9999 });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/tui-token — verification semantics", () => {
  let harness: AppHarness;
  beforeEach(() => {
    harness = buildApp();
  });

  it("verifies a freshly issued token within its TTL", async () => {
    const res = await issueToken(harness.app, { ttl_seconds: 120 });
    const { token } = (await res.json()) as { token: string };

    harness.advance(60_000); // 60s later — still valid

    expect(harness.handoff.verify(token)).toBe(true);
    expect(verifyTuiToken(harness.handoff, token)).toBe(true);
  });

  it("rejects a token after its TTL has elapsed", async () => {
    const res = await issueToken(harness.app, { ttl_seconds: 2 });
    const { token } = (await res.json()) as { token: string };

    harness.advance(3_000); // 3s later — expired

    expect(harness.handoff.verify(token)).toBe(false);
  });

  it("rejects tokens that were never issued", () => {
    expect(harness.handoff.verify("nope-nope-nope")).toBe(false);
    expect(harness.handoff.verify("")).toBe(false);
  });
});

describe("POST /v1/tui-token — cross-session poisoning defense", () => {
  it("tokens issued against a different server session id do not verify", async () => {
    const harnessA = buildApp({ serverSessionId: "boot-aaaa" });
    const harnessB = buildApp({ serverSessionId: "boot-bbbb" });

    // Issue from A, try to verify with B.
    const res = await issueToken(harnessA.app, { ttl_seconds: 120 });
    const { token } = (await res.json()) as { token: string };

    expect(harnessA.handoff.verify(token)).toBe(true);
    expect(harnessB.handoff.verify(token)).toBe(false);
  });
});
