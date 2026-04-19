/**
 * Phase 08 T5-03 — AuthProvider unit tests.
 */

import { describe, expect, it } from "vitest";

import { BearerAuthProvider } from "./bearer-provider.js";
import { MultiTenantAuthProviderStub } from "./multi-tenant-provider.js";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/test", { headers });
}

describe("BearerAuthProvider", () => {
  it("returns selfHostedPrincipal for valid token", async () => {
    const provider = new BearerAuthProvider({ authToken: "secret-token" });
    const req = makeRequest({ Authorization: "Bearer secret-token" });
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).not.toBeNull();
    expect(principal?.kind).toBe("bearer");
    expect(principal?.accountId).toBe("self-hosted");
    expect(principal?.tier).toBe("byok");
    expect(principal?.scopes).toContain("*");
  });

  it("returns null for invalid token", async () => {
    const provider = new BearerAuthProvider({ authToken: "correct" });
    const req = makeRequest({ Authorization: "Bearer wrong" });
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).toBeNull();
  });

  it("returns null for missing header", async () => {
    const provider = new BearerAuthProvider({ authToken: "secret" });
    const req = makeRequest({});
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).toBeNull();
  });

  it("returns null for non-Bearer scheme", async () => {
    const provider = new BearerAuthProvider({ authToken: "secret" });
    const req = makeRequest({ Authorization: "Basic dXNlcjpwYXNz" });
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).toBeNull();
  });

  it("throws on empty authToken", () => {
    expect(() => new BearerAuthProvider({ authToken: "" })).toThrow();
  });

  it("rejects prefix-match (shorter token)", async () => {
    const provider = new BearerAuthProvider({ authToken: "correct-full" });
    const req = makeRequest({ Authorization: "Bearer correct" });
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).toBeNull();
  });

  it("rejects suffix-match (longer token)", async () => {
    const provider = new BearerAuthProvider({ authToken: "correct" });
    const req = makeRequest({ Authorization: "Bearer correct-extra" });
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).toBeNull();
  });
});

describe("MultiTenantAuthProviderStub", () => {
  it("returns BYOK principal for x-anthropic-api-key with sk-ant- prefix", async () => {
    const provider = new MultiTenantAuthProviderStub();
    const req = makeRequest({ "x-anthropic-api-key": "sk-ant-api03-test-key" });
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).not.toBeNull();
    expect(principal?.kind).toBe("api_key");
    expect(principal?.tier).toBe("byok");
    expect(principal?.byok?.anthropicApiKey).toBe("sk-ant-api03-test-key");
    expect(principal?.accountId).toMatch(/^stub:[a-f0-9]{8}$/);
  });

  it("returns free-tier principal for x-api-key with jk_live_ prefix", async () => {
    const provider = new MultiTenantAuthProviderStub();
    const req = makeRequest({ "x-api-key": "jk_live_abc123" });
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).not.toBeNull();
    expect(principal?.kind).toBe("api_key");
    expect(principal?.tier).toBe("free");
    expect(principal?.byok).toBeNull();
    expect(principal?.accountId).toMatch(/^stub:[a-f0-9]{8}$/);
  });

  it("returns free-tier principal for x-api-key with jk_test_ prefix", async () => {
    const provider = new MultiTenantAuthProviderStub();
    const req = makeRequest({ "x-api-key": "jk_test_xyz789" });
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).not.toBeNull();
    expect(principal?.tier).toBe("free");
  });

  it("returns free-tier principal for Bearer jk_live_ token", async () => {
    const provider = new MultiTenantAuthProviderStub();
    const req = makeRequest({ Authorization: "Bearer jk_live_token123" });
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).not.toBeNull();
    expect(principal?.tier).toBe("free");
  });

  it("returns null for unknown API key format", async () => {
    const provider = new MultiTenantAuthProviderStub();
    const req = makeRequest({ "x-api-key": "unknown_format_key" });
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).toBeNull();
  });

  it("returns null for regular Bearer token (not jk_ prefix)", async () => {
    const provider = new MultiTenantAuthProviderStub();
    const req = makeRequest({ Authorization: "Bearer regular-token" });
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).toBeNull();
  });

  it("returns null for missing headers", async () => {
    const provider = new MultiTenantAuthProviderStub();
    const req = makeRequest({});
    const principal = await provider.authenticate(req, "127.0.0.1");

    expect(principal).toBeNull();
  });

  it("produces stable accountId for same key", async () => {
    const provider = new MultiTenantAuthProviderStub();
    const req1 = makeRequest({ "x-api-key": "jk_live_same_key" });
    const req2 = makeRequest({ "x-api-key": "jk_live_same_key" });

    const p1 = await provider.authenticate(req1, "127.0.0.1");
    const p2 = await provider.authenticate(req2, "127.0.0.1");

    expect(p1?.accountId).toBe(p2?.accountId);
  });

  it("produces different accountId for different keys", async () => {
    const provider = new MultiTenantAuthProviderStub();
    const req1 = makeRequest({ "x-api-key": "jk_live_key_a" });
    const req2 = makeRequest({ "x-api-key": "jk_live_key_b" });

    const p1 = await provider.authenticate(req1, "127.0.0.1");
    const p2 = await provider.authenticate(req2, "127.0.0.1");

    expect(p1?.accountId).not.toBe(p2?.accountId);
  });
});
