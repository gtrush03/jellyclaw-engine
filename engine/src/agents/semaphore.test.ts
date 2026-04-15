import { describe, expect, it, vi } from "vitest";
import { createSubagentSemaphore } from "./semaphore.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Yield multiple microtask ticks so p-limit can drain its queue. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

describe("createSubagentSemaphore", () => {
  it("caps concurrent execution at `maxConcurrency`", async () => {
    const sem = createSubagentSemaphore({ maxConcurrency: 3 });

    const deferreds: Deferred<void>[] = [];
    const started: number[] = [];

    const runs = Array.from({ length: 5 }, (_, i) => {
      const d = defer<void>();
      deferreds.push(d);
      return sem.run(async () => {
        started.push(i);
        await d.promise;
      });
    });

    await flush();
    expect(started).toEqual([0, 1, 2]);
    expect(sem.activeCount()).toBe(3);
    expect(sem.pendingCount()).toBe(2);

    // Resolve task 0 → task 3 starts.
    deferreds[0]?.resolve();
    await flush();
    expect(started).toEqual([0, 1, 2, 3]);
    expect(sem.activeCount()).toBe(3);
    expect(sem.pendingCount()).toBe(1);

    // Resolve task 1 → task 4 starts.
    deferreds[1]?.resolve();
    await flush();
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(sem.pendingCount()).toBe(0);

    // Drain.
    for (let i = 2; i < 5; i++) deferreds[i]?.resolve();
    await Promise.all(runs);
    expect(sem.activeCount()).toBe(0);
  });

  it("releases the slot when `fn` rejects", async () => {
    const sem = createSubagentSemaphore({ maxConcurrency: 1 });

    const err = new Error("boom");
    const firstDeferred = defer<void>();
    const secondStarted = defer<void>();

    const first = sem.run(async () => {
      await firstDeferred.promise;
      throw err;
    });

    let secondRan = false;
    // biome-ignore lint/suspicious/useAwait: sync fn inside async slot is intentional
    const second = sem.run(async () => {
      secondRan = true;
      secondStarted.resolve();
    });

    await flush();
    expect(secondRan).toBe(false);
    expect(sem.pendingCount()).toBe(1);

    firstDeferred.resolve();
    await expect(first).rejects.toBe(err);

    await secondStarted.promise;
    await second;
    expect(secondRan).toBe(true);
  });

  it("coerces maxConcurrency < 1 to 1 (one-at-a-time)", async () => {
    const sem = createSubagentSemaphore({ maxConcurrency: 0 });
    expect(sem.size).toBe(1);

    const d1 = defer<void>();
    const d2 = defer<void>();
    let secondStarted = false;

    const first = sem.run(async () => {
      await d1.promise;
    });
    const second = sem.run(async () => {
      secondStarted = true;
      await d2.promise;
    });

    await flush();
    expect(sem.activeCount()).toBe(1);
    expect(secondStarted).toBe(false);

    d1.resolve();
    await first;
    await flush();
    expect(secondStarted).toBe(true);

    d2.resolve();
    await second;
  });

  it("clamps maxConcurrency above ceiling and logs warn", () => {
    const warn = vi.fn();
    const fakeLogger = {
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as Parameters<typeof createSubagentSemaphore>[0] extends infer _ ? never : never;

    const sem = createSubagentSemaphore({
      maxConcurrency: 99,
      logger: fakeLogger,
    });

    expect(sem.size).toBe(5);
    expect(warn).toHaveBeenCalledTimes(1);
    const firstCall = warn.mock.calls[0];
    const payload = firstCall ? firstCall[0] : undefined;
    expect(payload).toMatchObject({ requested: 99, ceiling: 5 });
  });

  it("defaults to DEFAULT_MAX_CONCURRENCY (3) when omitted", () => {
    const sem = createSubagentSemaphore();
    expect(sem.size).toBe(3);
  });

  it("reuses the same p-limit instance across run() calls", async () => {
    const sem = createSubagentSemaphore({ maxConcurrency: 2 });

    const d1 = defer<void>();
    const d2 = defer<void>();
    const d3 = defer<void>();

    const r1 = sem.run(() => d1.promise);
    const r2 = sem.run(() => d2.promise);
    const r3 = sem.run(() => d3.promise);

    await flush();
    // Third is queued because the limiter is shared across calls.
    expect(sem.activeCount()).toBe(2);
    expect(sem.pendingCount()).toBe(1);

    d1.resolve();
    d2.resolve();
    d3.resolve();
    await Promise.all([r1, r2, r3]);
  });
});
