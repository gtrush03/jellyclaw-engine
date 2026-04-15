/**
 * Token-bucket rate limiter (Phase 08.03).
 *
 * A single-key leaky/token bucket with:
 *   - Deterministic refill based on an injected monotonic clock (never
 *     `Date.now`/`new Date`).
 *   - Synchronous `tryAcquire` for fast-path checks.
 *   - Async `acquire` that computes wait time deterministically, bounds it
 *     by `maxWaitMs`, and is cancellable via `AbortSignal`.
 *   - FIFO ordering for concurrent waiters (critical for fairness).
 *
 * Each waiter reserves its tokens from a running `reserved` counter so that
 * two concurrent `acquire` calls land after each other rather than both
 * racing the refill. When a waiter times out or aborts, its reservation is
 * returned to the pool and the next queued waiter's timer is recomputed.
 */

export interface TokenBucketOptions {
  /** Max tokens the bucket can hold. Must be > 0. */
  readonly capacity: number;
  /** Refill rate in tokens per second. Must be >= 0. */
  readonly refillPerSecond: number;
  /** Starting tokens. Defaults to `capacity`. Clamped to [0, capacity]. */
  readonly initial?: number;
  /** Monotonic clock in **milliseconds** (e.g. `performance.now`). */
  readonly now: () => number;
}

export interface AcquireOptions {
  readonly tokens?: number;
  readonly maxWaitMs?: number;
  readonly signal?: AbortSignal;
}

interface Waiter {
  readonly tokens: number;
  readonly deadline: number;
  readonly resolve: (ok: boolean) => void;
  readonly reject: (err: Error) => void;
  readonly onAbort: (() => void) | null;
  readonly signal: AbortSignal | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_MAX_WAIT_MS = 5_000;

function makeAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Aborted", "AbortError");
  }
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefillMs: number;
  /** Sum of tokens promised to queued waiters but not yet delivered. */
  private reserved = 0;
  private readonly queue: Waiter[] = [];

  constructor(opts: TokenBucketOptions) {
    if (!Number.isFinite(opts.capacity) || opts.capacity <= 0) {
      throw new Error(`TokenBucket: capacity must be > 0 (got ${opts.capacity})`);
    }
    if (!Number.isFinite(opts.refillPerSecond) || opts.refillPerSecond < 0) {
      throw new Error(`TokenBucket: refillPerSecond must be >= 0 (got ${opts.refillPerSecond})`);
    }
    if (typeof opts.now !== "function") {
      throw new Error("TokenBucket: now() clock is required");
    }
    this.capacity = opts.capacity;
    this.refillPerSecond = opts.refillPerSecond;
    this.now = opts.now;
    const initial = opts.initial ?? opts.capacity;
    this.tokens = Math.max(0, Math.min(opts.capacity, initial));
    this.lastRefillMs = opts.now();
  }

  /** Available tokens **excluding** reservations held for queued waiters. */
  available(): number {
    this.refill();
    return Math.max(0, this.tokens - this.reserved);
  }

  /** Synchronous acquire. Returns true on success, false if not enough tokens. */
  tryAcquire(tokens = 1): boolean {
    if (tokens <= 0) return true;
    this.refill();
    // Respect reservations — tryAcquire must not starve queued waiters.
    if (this.tokens - this.reserved >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }

  /**
   * Await until `tokens` tokens are available or timeout/abort. Resolves
   * `true` on success, `false` on timeout. Rejects with `AbortError` on
   * signal abort. On timeout/abort the bucket state is unchanged.
   */
  async acquire(opts: AcquireOptions = {}): Promise<boolean> {
    const tokens = opts.tokens ?? 1;
    const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    const signal = opts.signal;

    // Yield once so callers always observe promise-based (not sync) behavior
    // even on the fast path. This also normalises abort-before-call into a
    // microtask-delayed rejection.
    await Promise.resolve();

    if (tokens <= 0) return true;
    if (tokens > this.capacity) {
      // Can never be satisfied — fail fast rather than hang.
      return false;
    }
    if (signal?.aborted) {
      throw makeAbortError();
    }

    // Fast path: no queue, enough tokens now.
    if (this.queue.length === 0) {
      this.refill();
      if (this.tokens >= tokens) {
        this.tokens -= tokens;
        return true;
      }
    }

    // Compute wait time based on effective shortfall (account for prior reservations).
    const shortfall = tokens + this.reserved - this.tokens;
    const waitMs =
      this.refillPerSecond <= 0
        ? Number.POSITIVE_INFINITY
        : Math.max(0, (shortfall * 1000) / this.refillPerSecond);

    if (waitMs > maxWaitMs) {
      return false;
    }

    // Enqueue.
    this.reserved += tokens;
    const nowMs = this.now();
    const deadline = nowMs + waitMs;

    return new Promise<boolean>((resolve, reject) => {
      const waiter: Waiter = {
        tokens,
        deadline,
        resolve,
        reject,
        onAbort: null,
        signal: signal ?? null,
        timer: null,
      };

      const settle = (ok: boolean, err: Error | null): void => {
        // Remove from queue (idempotent).
        const idx = this.queue.indexOf(waiter);
        if (idx === -1) return;
        this.queue.splice(idx, 1);
        if (waiter.timer !== null) {
          clearTimeout(waiter.timer);
          waiter.timer = null;
        }
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        if (err) {
          // Return the reservation; do not deliver tokens.
          this.reserved -= waiter.tokens;
          this.rescheduleHead();
          reject(err);
          return;
        }
        if (ok) {
          // Deliver tokens: drop from reserved and tokens.
          this.reserved -= waiter.tokens;
          this.refill();
          this.tokens -= waiter.tokens;
          resolve(true);
          // Next waiter may now be deliverable.
          this.drain();
          return;
        }
        // Timeout: return reservation; reschedule head.
        this.reserved -= waiter.tokens;
        this.rescheduleHead();
        resolve(false);
      };

      // Wire abort.
      if (signal) {
        const onAbort = (): void => {
          settle(false, makeAbortError());
        };
        (waiter as { onAbort: (() => void) | null }).onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
      }

      this.queue.push(waiter);

      // Schedule timer for either delivery or timeout — whichever is sooner
      // we always treat as the deadline. Head-of-line fires first.
      if (this.queue.length === 1) {
        this.scheduleHead();
      }

      // In case refill already satisfies the head immediately (shouldn't
      // happen on the fast path, but stay safe).
      this.drain();
    });
  }

  /** Recompute available tokens from the clock. */
  private refill(): void {
    if (this.refillPerSecond <= 0) {
      this.lastRefillMs = this.now();
      return;
    }
    const nowMs = this.now();
    const delta = nowMs - this.lastRefillMs;
    if (delta <= 0) return;
    const added = (delta * this.refillPerSecond) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefillMs = nowMs;
  }

  /** Deliver as many queued waiters as currently possible (FIFO). */
  private drain(): void {
    this.refill();
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (!head) break;
      // The head's reservation is part of `reserved` — compare tokens with
      // that baseline included.
      if (this.tokens >= head.tokens) {
        // Pop and deliver.
        this.queue.shift();
        if (head.timer !== null) {
          clearTimeout(head.timer);
          head.timer = null;
        }
        if (head.signal && head.onAbort) {
          head.signal.removeEventListener("abort", head.onAbort);
        }
        this.reserved -= head.tokens;
        this.tokens -= head.tokens;
        head.resolve(true);
        continue;
      }
      // Head not deliverable — ensure its timer is armed for either refill
      // or timeout deadline.
      this.scheduleHead();
      break;
    }
  }

  /** (Re)arm the timer for the head waiter. */
  private scheduleHead(): void {
    const head = this.queue[0];
    if (!head) return;
    if (head.timer !== null) {
      clearTimeout(head.timer);
      head.timer = null;
    }
    const nowMs = this.now();
    // Compute shortfall for the head, considering ONLY its own reservation
    // (earlier waiters have been drained by now).
    const shortfall = head.tokens - this.tokens;
    let refillWaitMs: number;
    if (shortfall <= 0) {
      refillWaitMs = 0;
    } else if (this.refillPerSecond <= 0) {
      refillWaitMs = Number.POSITIVE_INFINITY;
    } else {
      refillWaitMs = (shortfall * 1000) / this.refillPerSecond;
    }
    const timeoutMs = head.deadline - nowMs;
    // Fire whichever is sooner.
    const fireInMs = Math.max(0, Math.min(refillWaitMs, timeoutMs));
    if (!Number.isFinite(fireInMs)) {
      // Pure timeout path.
      if (Number.isFinite(timeoutMs)) {
        head.timer = setTimeout(() => this.onHeadTimer(), Math.max(0, timeoutMs));
      }
      return;
    }
    head.timer = setTimeout(() => this.onHeadTimer(), fireInMs);
  }

  private onHeadTimer(): void {
    const head = this.queue[0];
    if (!head) return;
    head.timer = null;
    this.refill();
    const nowMs = this.now();
    if (this.tokens >= head.tokens) {
      this.drain();
      return;
    }
    if (nowMs >= head.deadline) {
      // Timed out.
      this.queue.shift();
      if (head.signal && head.onAbort) {
        head.signal.removeEventListener("abort", head.onAbort);
      }
      this.reserved -= head.tokens;
      head.resolve(false);
      this.rescheduleHead();
      return;
    }
    // Still waiting — re-arm.
    this.scheduleHead();
  }

  private rescheduleHead(): void {
    const head = this.queue[0];
    if (!head) return;
    this.scheduleHead();
    // Also attempt an immediate drain in case head is now satisfiable.
    this.drain();
  }
}
