import { Buffer } from "node:buffer";

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { constantTimeTokenCompare, createAuthMiddleware } from "./auth.js";
import type { AuthProvider, Principal } from "./auth/index.js";
import { selfHostedPrincipal } from "./auth/index.js";
import type { AppVariables } from "./types.js";

function makeApp(token: string): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", createAuthMiddleware({ authToken: token }));
  app.get("/v1/health", (c) => c.json({ ok: true }));
  return app;
}

function makeAppWithProvider(provider: AuthProvider): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use("*", createAuthMiddleware({ provider }));
  app.get("/v1/health", (c) => {
    const principal = c.get("principal");
    const authenticated = c.get("authenticated");
    return c.json({ ok: true, principal, authenticated });
  });
  return app;
}

function makeMockProvider(returnValue: Principal | null): AuthProvider {
  return {
    authenticate: vi.fn().mockResolvedValue(returnValue),
  };
}

describe("auth middleware", () => {
  it("rejects requests without an Authorization header", async () => {
    const app = makeApp("secret-32-bytes-of-entropy-here-a");
    const res = await app.request("/v1/health");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects non-Bearer schemes", async () => {
    const app = makeApp("secret-32-bytes-of-entropy-here-a");
    const res = await app.request("/v1/health", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const app = makeApp("correct");
    const res = await app.request("/v1/health", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts the correct token", async () => {
    const app = makeApp("correct");
    const res = await app.request("/v1/health", {
      headers: { Authorization: "Bearer correct" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects a token that differs only in length (prefix match)", async () => {
    const app = makeApp("correct-full");
    const res = await app.request("/v1/health", {
      headers: { Authorization: "Bearer correct" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects an over-long token (suffix after prefix match)", async () => {
    const app = makeApp("correct");
    const res = await app.request("/v1/health", {
      headers: { Authorization: "Bearer correct-extra" },
    });
    expect(res.status).toBe(401);
  });

  it("refuses to construct with empty token", () => {
    expect(() => createAuthMiddleware({ authToken: "" })).toThrow();
  });
});

describe("constantTimeTokenCompare", () => {
  it("returns true for an exact match", () => {
    expect(constantTimeTokenCompare("abc", Buffer.from("abc"))).toBe(true);
  });

  it("returns false for different-length same-prefix input", () => {
    expect(constantTimeTokenCompare("abc", Buffer.from("abcd"))).toBe(false);
    expect(constantTimeTokenCompare("abcd", Buffer.from("abc"))).toBe(false);
  });

  it("returns false for empty input against a non-empty expected", () => {
    expect(constantTimeTokenCompare("", Buffer.from("abc"))).toBe(false);
  });

  it("returns false for wrong equal-length input", () => {
    expect(constantTimeTokenCompare("xyz", Buffer.from("abc"))).toBe(false);
  });
});

describe("auth middleware with provider", () => {
  it("returns 401 when provider returns null", async () => {
    const provider = makeMockProvider(null);
    const app = makeAppWithProvider(provider);

    const res = await app.request("/v1/health");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("sets c.var.principal when provider returns Principal", async () => {
    const principal = selfHostedPrincipal();
    const provider = makeMockProvider(principal);
    const app = makeAppWithProvider(provider);

    const res = await app.request("/v1/health");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.principal.accountId).toBe("self-hosted");
    expect(body.principal.kind).toBe("bearer");
  });

  it("sets c.var.authenticated = true for back-compat", async () => {
    const principal = selfHostedPrincipal();
    const provider = makeMockProvider(principal);
    const app = makeAppWithProvider(provider);

    const res = await app.request("/v1/health");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
  });

  it("refuses to construct without provider or authToken", () => {
    expect(() => createAuthMiddleware({})).toThrow();
  });
});
