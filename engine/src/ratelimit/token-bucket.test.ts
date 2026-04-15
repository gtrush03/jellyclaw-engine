import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenBucket } from "./token-bucket.js";

interface Clock {
  t: number;
}

function mkClock(): { clock: Clock; now: () => number } {
  const clock: Clock = { t: 0 };
  return { clock, now: () => clock.t };
}

async function advance(clock: Clock, ms: number): Promise<void> {
  clock.t += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

describe("TokenBucket — construction", () => {
  it("rejects capacity <= 0", () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1, now: () => 0 })).toThrow();
    expect(() => new TokenBucket({ capacity: -1, refillPerSecond: 1, now: () => 0 })).toThrow();
  });

  it("rejects negative refillPerSecond", () => {
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: -1, now: () => 0 })).toThrow();
  });

  it("initial defaults to capacity", () => {
    const { now } = mkClock();
    const b = new TokenBucket({ capacity: 5, refillPerSecond: 1, now });
    expect(b.available()).toBe(5);
  });

  it("initial respected and clamped", () => {
    const { now } = mkClock();
    const b = new TokenBucket({ capacity: 5, refillPerSecond: 1, initial: 2, now });
    expect(b.available()).toBe(2);
    const b2 = new TokenBucket({ capacity: 5, refillPerSecond: 1, initial: 99, now });
    expect(b2.available()).toBe(5);
    const b3 = new TokenBucket({ capacity: 5, refillPerSecond: 1, initial: -3, now });
    expect(b3.available()).toBe(0);
  });
});

describe("TokenBucket — tryAcquire", () => {
  it("drains tokens and returns false when empty", () => {
    const { now } = mkClock();
    const b = new TokenBucket({ capacity: 3, refillPerSecond: 0, now });
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(true);
    expect(b.tryAcquire()).toBe(false);
    expect(b.available()).toBe(0);
  });

  it("tryAcquire(n) consumes n tokens at once", () => {
    const { now } = mkClock();
    const b = new TokenBucket({ capacity: 5, refillPerSecond: 0, now });
    expect(b.tryAcquire(3)).toBe(true);
    expect(b.available()).toBe(2);
    expect(b.tryAcquire(3)).toBe(false);
    expect(b.available()).toBe(2);
  });
});

describe("TokenBucket — refill", () => {
  it("refills based on elapsed clock time", () => {
    const { clock, now } = mkClock();
    const b = new TokenBucket({ capacity: 10, refillPerSecond: 2, initial: 0, now });
    expect(b.available()).toBe(0);
    clock.t += 1_000; // 1s at 2/s → +2
    expect(b.available()).toBeCloseTo(2, 5);
    clock.t += 500; // +1
    expect(b.available()).toBeCloseTo(3, 5);
  });

  it("refill respects capacity cap", () => {
    const { clock, now } = mkClock();
    const b = new TokenBucket({ capacity: 5, refillPerSecond: 1, initial: 0, now });
    clock.t += 10_000; // would give 10 tokens, cap at 5
    expect(b.available()).toBe(5);
  });
});

describe("TokenBucket — acquire (async)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when tokens available", async () => {
    const { now } = mkClock();
    const b = new TokenBucket({ capacity: 3, refillPerSecond: 1, now });
    await expect(b.acquire()).resolves.toBe(true);
    expect(b.available()).toBe(2);
  });

  it("waits for refill then resolves true", async () => {
    const { clock, now } = mkClock();
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1, initial: 0, now });
    const p = b.acquire({ maxWaitMs: 5000 });
    await advance(clock, 1000);
    await expect(p).resolves.toBe(true);
    expect(b.available()).toBeCloseTo(0, 5);
  });

  it("times out and resolves false when wait exceeds maxWaitMs", async () => {
    const { now } = mkClock();
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1, initial: 0, now });
    // need 1 token at 1/s = 1000ms wait; maxWaitMs 500 → false, no consumption
    const p = b.acquire({ maxWaitMs: 500 });
    await expect(p).resolves.toBe(false);
  });

  it("refillPerSecond=0 causes acquire to time out", async () => {
    const { clock, now } = mkClock();
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 0, initial: 0, now });
    const p = b.acquire({ maxWaitMs: 1000 });
    // 0 refill means shortfall*inf → exceeds any maxWait → resolves false immediately
    await advance(clock, 0);
    await expect(p).resolves.toBe(false);
  });

  it("AbortSignal already-aborted rejects synchronously with AbortError", async () => {
    const { now } = mkClock();
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 1, now });
    const ac = new AbortController();
    ac.abort();
    await expect(b.acquire({ signal: ac.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(b.available()).toBe(1);
  });

  it("AbortSignal mid-wait rejects with AbortError; bucket unchanged", async () => {
    const { clock, now } = mkClock();
    const b = new TokenBucket({ capacity: 1, refillPerSecond: 1, initial: 0, now });
    const ac = new AbortController();
    const p = b.acquire({ maxWaitMs: 5000, signal: ac.signal });
    await advance(clock, 200);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    // No refill happened yet beyond what the clock shows.
    clock.t += 1000;
    expect(b.available()).toBeCloseTo(1, 5);
  });

  it("concurrent acquirers resolve in FIFO order", async () => {
    const { clock, now } = mkClock();
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1, initial: 0, now });
    const order: number[] = [];
    const p1 = b.acquire({ maxWaitMs: 10_000 }).then((ok) => {
      if (ok) order.push(1);
    });
    const p2 = b.acquire({ maxWaitMs: 10_000 }).then((ok) => {
      if (ok) order.push(2);
    });
    await advance(clock, 1000); // +1 token → first delivered
    await Promise.resolve();
    await advance(clock, 1000); // +1 more → second delivered
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("acquire(tokens>capacity) returns false without blocking", async () => {
    const { now } = mkClock();
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1, now });
    await expect(b.acquire({ tokens: 10 })).resolves.toBe(false);
  });

  it("failed acquire does not consume tokens", async () => {
    const { now } = mkClock();
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1, initial: 0, now });
    await expect(b.acquire({ maxWaitMs: 50 })).resolves.toBe(false);
    expect(b.available()).toBe(0);
  });
});
