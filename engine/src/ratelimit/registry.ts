/**
 * Per-key `TokenBucket` registry (Phase 08.03).
 *
 * Buckets are created lazily the first time a key is requested. The
 * `configure` callback turns a key into a `TokenBucketOptions` (or `null`
 * for "unlimited — do not rate-limit this key"). A soft LRU cap evicts
 * stale buckets so long-running sessions don't leak memory for an
 * ever-growing set of one-off domains.
 */

import { TokenBucket, type TokenBucketOptions } from "./token-bucket.js";

export interface RegistryOptions {
  readonly now: () => number;
  readonly configure: (key: string) => TokenBucketOptions | null;
  /** Soft cap on the Map size; LRU eviction past this. Default 1000. */
  readonly maxKeys?: number;
}

interface Entry {
  readonly bucket: TokenBucket | null;
  lastUsedMs: number;
}

const DEFAULT_MAX_KEYS = 1000;

export class RateLimitRegistry {
  private readonly now: () => number;
  private readonly configure: (key: string) => TokenBucketOptions | null;
  private readonly maxKeys: number;
  private readonly map = new Map<string, Entry>();

  constructor(opts: RegistryOptions) {
    if (typeof opts.now !== "function") {
      throw new Error("RateLimitRegistry: now() clock is required");
    }
    if (typeof opts.configure !== "function") {
      throw new Error("RateLimitRegistry: configure() is required");
    }
    this.now = opts.now;
    this.configure = opts.configure;
    this.maxKeys = opts.maxKeys ?? DEFAULT_MAX_KEYS;
    if (this.maxKeys <= 0) {
      throw new Error("RateLimitRegistry: maxKeys must be > 0");
    }
  }

  /**
   * Fetch or lazily create the bucket for `key`. Returns `null` if the
   * configured policy for this key is "no rate limit".
   */
  get(key: string): TokenBucket | null {
    const existing = this.map.get(key);
    if (existing) {
      existing.lastUsedMs = this.now();
      // Re-insert to bump LRU position.
      this.map.delete(key);
      this.map.set(key, existing);
      return existing.bucket;
    }
    const cfg = this.configure(key);
    const bucket = cfg === null ? null : new TokenBucket(cfg);
    const entry: Entry = { bucket, lastUsedMs: this.now() };
    this.map.set(key, entry);
    this.enforceCap();
    return bucket;
  }

  /** Drop a key's bucket. Next `get` will re-configure. */
  evict(key: string): void {
    this.map.delete(key);
  }

  size(): number {
    return this.map.size;
  }

  private enforceCap(): void {
    while (this.map.size > this.maxKeys) {
      // Map iteration order is insertion order — front = oldest/LRU.
      const oldest = this.map.keys().next();
      if (oldest.done) return;
      this.map.delete(oldest.value);
    }
  }
}
