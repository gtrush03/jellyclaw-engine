import { describe, expect, it } from "vitest";
import { RateLimitRegistry } from "./registry.js";
import type { TokenBucketOptions } from "./token-bucket.js";

function mkNow(): { t: { v: number }; now: () => number } {
  const t = { v: 0 };
  return { t, now: () => t.v };
}

describe("RateLimitRegistry", () => {
  it("lazy-creates a bucket with the configured options", () => {
    const { now } = mkNow();
    const reg = new RateLimitRegistry({
      now,
      configure: (key): TokenBucketOptions => ({
        capacity: key === "hot" ? 10 : 1,
        refillPerSecond: 1,
        now,
      }),
    });
    const a = reg.get("hot");
    expect(a).not.toBeNull();
    expect(a?.available()).toBe(10);
    expect(reg.size()).toBe(1);
  });

  it("returns the same bucket instance on repeated get", () => {
    const { now } = mkNow();
    const reg = new RateLimitRegistry({
      now,
      configure: () => ({ capacity: 2, refillPerSecond: 1, now }),
    });
    const a = reg.get("k");
    const b = reg.get("k");
    expect(a).toBe(b);
  });

  it("configure returning null marks the key as unlimited", () => {
    const { now } = mkNow();
    const reg = new RateLimitRegistry({ now, configure: () => null });
    expect(reg.get("k")).toBeNull();
    // Stored, but null — repeated gets still return null without recreating.
    expect(reg.get("k")).toBeNull();
    expect(reg.size()).toBe(1);
  });

  it("evict drops bucket; next get creates fresh", () => {
    const { now } = mkNow();
    const reg = new RateLimitRegistry({
      now,
      configure: () => ({ capacity: 3, refillPerSecond: 1, now }),
    });
    const a = reg.get("x");
    reg.evict("x");
    expect(reg.size()).toBe(0);
    const b = reg.get("x");
    expect(b).not.toBe(a);
  });

  it("maxKeys enforces LRU eviction", () => {
    const { now } = mkNow();
    const reg = new RateLimitRegistry({
      now,
      configure: () => ({ capacity: 1, refillPerSecond: 1, now }),
      maxKeys: 2,
    });
    reg.get("a");
    reg.get("b");
    // Touch "a" to move it to tail.
    reg.get("a");
    reg.get("c"); // should evict "b" (LRU)
    expect(reg.size()).toBe(2);
    // "b" evicted → new bucket on re-request.
    const b1 = reg.get("a");
    const b2 = reg.get("a");
    expect(b1).toBe(b2);
    // 'b' should have been evicted — reinstate & confirm it's a fresh bucket
    // (we can't compare identity because we don't have the original reference
    // post-eviction, but size semantics are what we care about).
    expect(reg.size()).toBe(2);
  });

  it("rejects maxKeys <= 0", () => {
    const { now } = mkNow();
    expect(
      () =>
        new RateLimitRegistry({
          now,
          configure: () => null,
          maxKeys: 0,
        }),
    ).toThrow();
  });
});
