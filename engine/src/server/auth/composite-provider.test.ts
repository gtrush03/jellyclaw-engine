/**
 * Phase 08 T5-03 — CompositeAuthProvider tests.
 */

import { describe, expect, it, vi } from "vitest";

import { CompositeAuthProvider } from "./composite-provider.js";
import { selfHostedPrincipal, type Principal } from "./principal.js";
import type { AuthProvider } from "./provider.js";

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/v1/test", { headers });
}

function makeMockProvider(returnValue: Principal | null): AuthProvider {
  return {
    authenticate: vi.fn().mockResolvedValue(returnValue),
  };
}

describe("CompositeAuthProvider", () => {
  it("returns first non-null result", async () => {
    const principal = selfHostedPrincipal();
    const provider1 = makeMockProvider(null);
    const provider2 = makeMockProvider(principal);
    const provider3 = makeMockProvider(null);

    const composite = new CompositeAuthProvider([provider1, provider2, provider3]);
    const result = await composite.authenticate(makeRequest(), "127.0.0.1");

    expect(result).toBe(principal);
    expect(provider1.authenticate).toHaveBeenCalledTimes(1);
    expect(provider2.authenticate).toHaveBeenCalledTimes(1);
    expect(provider3.authenticate).not.toHaveBeenCalled();
  });

  it("returns null when all providers return null", async () => {
    const provider1 = makeMockProvider(null);
    const provider2 = makeMockProvider(null);

    const composite = new CompositeAuthProvider([provider1, provider2]);
    const result = await composite.authenticate(makeRequest(), "127.0.0.1");

    expect(result).toBeNull();
    expect(provider1.authenticate).toHaveBeenCalledTimes(1);
    expect(provider2.authenticate).toHaveBeenCalledTimes(1);
  });

  it("respects provider order", async () => {
    const principal1: Principal = { ...selfHostedPrincipal(), accountId: "first" };
    const principal2: Principal = { ...selfHostedPrincipal(), accountId: "second" };

    const provider1 = makeMockProvider(principal1);
    const provider2 = makeMockProvider(principal2);

    const composite = new CompositeAuthProvider([provider1, provider2]);
    const result = await composite.authenticate(makeRequest(), "127.0.0.1");

    expect(result?.accountId).toBe("first");
    expect(provider2.authenticate).not.toHaveBeenCalled();
  });

  it("returns null for empty provider list", async () => {
    const composite = new CompositeAuthProvider([]);
    const result = await composite.authenticate(makeRequest(), "127.0.0.1");

    expect(result).toBeNull();
  });

  it("passes request and ip to each provider", async () => {
    const provider = makeMockProvider(null);
    const composite = new CompositeAuthProvider([provider]);

    const req = makeRequest({ "x-test": "value" });
    await composite.authenticate(req, "1.2.3.4");

    expect(provider.authenticate).toHaveBeenCalledWith(req, "1.2.3.4");
  });
});
