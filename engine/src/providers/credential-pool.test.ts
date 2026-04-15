import { describe, expect, it } from "vitest";
import { AllKeysDeadError, type CredentialPool, resolveCredentials } from "./credential-pool.js";

/** Helper: build an env object with only the given keys set. */
function envOf(entries: Record<string, string>): NodeJS.ProcessEnv {
  return { ...entries } as NodeJS.ProcessEnv;
}

describe("resolveCredentials", () => {
  it("returns null when no credentials are present", () => {
    const pool = resolveCredentials({ provider: "anthropic", env: envOf({}) });
    expect(pool).toBeNull();
  });

  it("builds a single-slot pool from the unnumbered env var", () => {
    const pool = resolveCredentials({
      provider: "anthropic",
      env: envOf({ ANTHROPIC_API_KEY: "sk-plain" }),
    });
    expect(pool).not.toBeNull();
    const p = pool as CredentialPool;
    expect(p.size).toBe(1);
    expect(p.provider).toBe("anthropic");
    expect(p.next()).toBe("sk-plain");
    expect(p.lastSlot).toBe(1);
    expect(() => p.rotateOnRateLimit()).toThrow(AllKeysDeadError);
  });

  it("configKey takes precedence over numbered env vars", () => {
    const pool = resolveCredentials({
      provider: "anthropic",
      configKey: "cfg",
      env: envOf({
        ANTHROPIC_API_KEY_1: "sk-1",
        ANTHROPIC_API_KEY_2: "sk-2",
      }),
    });
    expect(pool).not.toBeNull();
    const p = pool as CredentialPool;
    expect(p.size).toBe(1);
    expect(p.next()).toBe("cfg");
  });

  it("numbered pool cycles round-robin with 1-indexed lastSlot", () => {
    const pool = resolveCredentials({
      provider: "anthropic",
      env: envOf({
        ANTHROPIC_API_KEY_1: "sk-1",
        ANTHROPIC_API_KEY_2: "sk-2",
        ANTHROPIC_API_KEY_3: "sk-3",
      }),
    });
    const p = pool as CredentialPool;
    expect(p.size).toBe(3);
    expect(p.lastSlot).toBe(0);

    expect(p.next()).toBe("sk-1");
    expect(p.lastSlot).toBe(1);
    expect(p.next()).toBe("sk-2");
    expect(p.lastSlot).toBe(2);
    expect(p.next()).toBe("sk-3");
    expect(p.lastSlot).toBe(3);
    expect(p.next()).toBe("sk-1");
    expect(p.lastSlot).toBe(1);
  });

  it("discontiguous numbered (only _2) falls back — returns null when no unnumbered exists", () => {
    const pool = resolveCredentials({
      provider: "anthropic",
      env: envOf({ ANTHROPIC_API_KEY_2: "sk-orphan" }),
    });
    expect(pool).toBeNull();
  });

  it("discontiguous numbered falls back to unnumbered when present", () => {
    const pool = resolveCredentials({
      provider: "anthropic",
      env: envOf({
        ANTHROPIC_API_KEY_2: "sk-orphan",
        ANTHROPIC_API_KEY: "sk-plain",
      }),
    });
    const p = pool as CredentialPool;
    expect(p.size).toBe(1);
    expect(p.next()).toBe("sk-plain");
  });

  it("lone _1 is treated as a single-slot pool (pooling off)", () => {
    const pool = resolveCredentials({
      provider: "anthropic",
      env: envOf({ ANTHROPIC_API_KEY_1: "sk-only" }),
    });
    const p = pool as CredentialPool;
    expect(p.size).toBe(1);
    expect(p.next()).toBe("sk-only");
    expect(() => p.rotateOnRateLimit()).toThrow(AllKeysDeadError);
  });

  it("rotateOnRateLimit advances one slot past current, skipping dead ones", () => {
    const pool = resolveCredentials({
      provider: "anthropic",
      env: envOf({
        ANTHROPIC_API_KEY_1: "sk-1",
        ANTHROPIC_API_KEY_2: "sk-2",
        ANTHROPIC_API_KEY_3: "sk-3",
      }),
    });
    const p = pool as CredentialPool;
    // Prime: use slot 1.
    expect(p.next()).toBe("sk-1");
    // Rotate: must move to slot 2 (not re-use slot 1).
    expect(p.rotateOnRateLimit()).toBe("sk-2");
    expect(p.lastSlot).toBe(2);

    // Mark slot 3 dead, then rotate from slot 2 → should skip to slot 1.
    // First, advance cursor by using next() so lastSlot=3, then kill it.
    // Actually easier: rotate from current (slot 2) — next live is slot 3.
    expect(p.rotateOnRateLimit()).toBe("sk-3");
    p.markCurrentDead("401");
    // Now rotating from dead slot 3 should land on slot 1 (skipping dead 3).
    expect(p.rotateOnRateLimit()).toBe("sk-1");
    expect(p.lastSlot).toBe(1);
  });

  it("markCurrentDead then next() skips dead slots; all dead throws", () => {
    const pool = resolveCredentials({
      provider: "anthropic",
      env: envOf({
        ANTHROPIC_API_KEY_1: "sk-1",
        ANTHROPIC_API_KEY_2: "sk-2",
      }),
    });
    const p = pool as CredentialPool;
    expect(p.next()).toBe("sk-1");
    p.markCurrentDead("bad key");
    // Slot 1 dead → next() returns slot 2.
    expect(p.next()).toBe("sk-2");
    expect(p.lastSlot).toBe(2);
    p.markCurrentDead();
    // Both dead → next() throws.
    expect(() => p.next()).toThrow(AllKeysDeadError);
    expect(() => p.next()).toThrow(/All 2 credentials for anthropic/);
  });

  it("openrouter prefix works identically", () => {
    const pool = resolveCredentials({
      provider: "openrouter",
      env: envOf({
        OPENROUTER_API_KEY_1: "or-1",
        OPENROUTER_API_KEY_2: "or-2",
      }),
    });
    const p = pool as CredentialPool;
    expect(p.provider).toBe("openrouter");
    expect(p.size).toBe(2);
    expect(p.next()).toBe("or-1");
    expect(p.next()).toBe("or-2");
    expect(p.next()).toBe("or-1");
  });

  it("JSON.stringify does not leak key material", () => {
    const pool = resolveCredentials({
      provider: "anthropic",
      env: envOf({
        ANTHROPIC_API_KEY_1: "sk-secret-aaa",
        ANTHROPIC_API_KEY_2: "sk-secret-bbb",
      }),
    });
    const p = pool as CredentialPool;
    // Prime so lastSlot reflects something non-trivial.
    p.next();
    const serialised = JSON.stringify(p);
    expect(serialised).not.toContain("sk-secret-aaa");
    expect(serialised).not.toContain("sk-secret-bbb");

    // Enumerable property names must NOT include the keys anywhere.
    const keys = Object.keys(p);
    for (const k of keys) {
      const v = (p as unknown as Record<string, unknown>)[k];
      if (typeof v === "string") {
        expect(v).not.toContain("sk-secret-aaa");
        expect(v).not.toContain("sk-secret-bbb");
      }
    }
  });

  it("lastSlot is 1-indexed and starts at 0 before first next()", () => {
    const pool = resolveCredentials({
      provider: "anthropic",
      env: envOf({
        ANTHROPIC_API_KEY_1: "sk-1",
        ANTHROPIC_API_KEY_2: "sk-2",
        ANTHROPIC_API_KEY_3: "sk-3",
      }),
    });
    const p = pool as CredentialPool;
    expect(p.lastSlot).toBe(0);
    p.next();
    expect(p.lastSlot).toBe(1);
    p.next();
    expect(p.lastSlot).toBe(2);
    p.next();
    expect(p.lastSlot).toBe(3);
  });
});
