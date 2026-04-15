/**
 * Credential pool — round-robin over multiple API keys for a single provider.
 *
 * See `engine/provider-research-notes.md` §9 for the spec.
 *
 * Security contract:
 *  - Raw keys are held inside a closure; they are NEVER placed on enumerable
 *    fields of the returned object. `JSON.stringify(pool)` MUST NOT leak them.
 *  - `AllKeysDeadError` and all other error messages reference only the
 *    provider name and counts — never the key material.
 *  - Callers receive keys from `next()` / `rotateOnRateLimit()` and are
 *    contractually forbidden from logging them (the pino logger's redact
 *    list is the second line of defence — see `engine/src/logger.ts`).
 */

export type ProviderName = "anthropic" | "openrouter";

export interface CredentialPool {
  /** Human-readable identifier for logs; NEVER the key. */
  readonly provider: ProviderName;
  readonly size: number;
  /** 1-indexed slot of the last returned key (for telemetry tagging). */
  readonly lastSlot: number;
  /** Returns the next key in round-robin order. */
  next(): string;
  /** Called after a 429; advances past the current key immediately. */
  rotateOnRateLimit(): string;
  /** Called after a 401; marks the current key dead for process lifetime. */
  markCurrentDead(reason?: string): void;
}

export interface ResolveCredentialsOptions {
  provider: ProviderName;
  env?: NodeJS.ProcessEnv;
  /** Single explicit key from config (takes precedence over env pooling). */
  configKey?: string;
}

export class AllKeysDeadError extends Error {
  public override readonly name = "AllKeysDeadError";
}

const PREFIX: Record<ProviderName, string> = {
  anthropic: "ANTHROPIC",
  openrouter: "OPENROUTER",
};

/**
 * Factory for a `CredentialPool` that keeps raw key material inside a closure.
 * The returned object exposes only metadata on enumerable fields; the keys
 * live in the captured `keys` array and are reachable only through the method
 * closures.
 */
function makePool(provider: ProviderName, keys: readonly string[]): CredentialPool {
  if (keys.length === 0) {
    throw new Error(`makePool called with empty key list for ${provider}`);
  }

  // Closure state — not reachable via property access on the returned object.
  const alive: boolean[] = keys.map(() => true);
  // `cursor` points at the slot that will be returned by the NEXT call to
  // `next()`. `lastSlot` (0 before first call) tracks the slot just returned.
  let cursor = 0;
  let lastSlot = 0;

  const size = keys.length;

  const aliveCount = (): number => {
    let n = 0;
    for (const a of alive) {
      if (a) n++;
    }
    return n;
  };

  const advanceToNextLive = (): number => {
    // Find the next alive slot starting at `cursor`, wrapping around.
    // Throws AllKeysDeadError if none are alive.
    if (aliveCount() === 0) {
      throw new AllKeysDeadError(`All ${size} credentials for ${provider} are marked dead.`);
    }
    let idx = cursor;
    for (let i = 0; i < size; i++) {
      if (alive[idx] === true) return idx;
      idx = (idx + 1) % size;
    }
    // Unreachable given aliveCount() > 0 above.
    throw new AllKeysDeadError(`All ${size} credentials for ${provider} are marked dead.`);
  };

  const nextImpl = (): string => {
    const idx = advanceToNextLive();
    const key = keys[idx];
    if (key === undefined) {
      // Defensive — should never happen; `idx` is always in range.
      throw new AllKeysDeadError(`All ${size} credentials for ${provider} are marked dead.`);
    }
    lastSlot = idx + 1;
    cursor = (idx + 1) % size;
    return key;
  };

  const rotateOnRateLimit = (): string => {
    // Single-slot pool: nothing to rotate to.
    if (size === 1) {
      throw new AllKeysDeadError(`All ${size} credentials for ${provider} are marked dead.`);
    }
    // Force-advance: if `lastSlot` is set, start searching AFTER it so we
    // always move past the current key. If no call has happened yet,
    // behave like `next()`.
    if (lastSlot > 0) {
      cursor = lastSlot % size;
    }
    // Guard: if the only alive slot is the one we just used, nothing to
    // rotate to — treat as exhausted.
    if (aliveCount() === 0) {
      throw new AllKeysDeadError(`All ${size} credentials for ${provider} are marked dead.`);
    }
    if (aliveCount() === 1 && lastSlot > 0 && alive[lastSlot - 1] === true) {
      throw new AllKeysDeadError(`All ${size} credentials for ${provider} are marked dead.`);
    }
    return nextImpl();
  };

  const markCurrentDead = (_reason?: string): void => {
    if (lastSlot === 0) return; // No current slot yet; no-op.
    const idx = lastSlot - 1;
    if (idx >= 0 && idx < size) {
      alive[idx] = false;
    }
  };

  // Define metadata getters as non-enumerable where possible, and ensure
  // the object's enumerable footprint contains NO key material.
  const pool: CredentialPool = Object.create(null) as CredentialPool;
  Object.defineProperties(pool, {
    provider: { value: provider, enumerable: true, writable: false },
    size: { value: size, enumerable: true, writable: false },
    lastSlot: {
      enumerable: true,
      get(): number {
        return lastSlot;
      },
    },
    next: { value: nextImpl, enumerable: false, writable: false },
    rotateOnRateLimit: {
      value: rotateOnRateLimit,
      enumerable: false,
      writable: false,
    },
    markCurrentDead: {
      value: markCurrentDead,
      enumerable: false,
      writable: false,
    },
  });
  return pool;
}

/**
 * Resolve the credential strategy:
 *   - If `configKey` is set → single-slot "pool" with just that key
 *     (pooling off, per research §9.1 rule 1).
 *   - Else scan env for `<PREFIX>_API_KEY_1..N` **contiguously** from 1.
 *     If `_1` is missing, the numbered scan is abandoned entirely even
 *     when later indices like `_2` exist (research §9.1 resolution order).
 *     If ≥2 numbered keys found → pool with those keys.
 *   - Else if `<PREFIX>_API_KEY` (unnumbered) is set → single-slot pool.
 *   - Else if only `<PREFIX>_API_KEY_1` is set without `_2` → fall through
 *     to the unnumbered check, then single-slot on `_1` (§9.1 rule 4).
 *   - Else return `null`. Caller decides whether null is fatal.
 */
export function resolveCredentials(opts: ResolveCredentialsOptions): CredentialPool | null {
  const { provider, configKey } = opts;
  const env = opts.env ?? process.env;
  const prefix = PREFIX[provider];

  // 1. Config key takes precedence — single-slot pool.
  if (typeof configKey === "string" && configKey.length > 0) {
    return makePool(provider, [configKey]);
  }

  // 2. Contiguous numbered scan starting at _1. If _1 is missing, bail out
  //    of the numbered strategy entirely (even if _2+ are set).
  const numbered: string[] = [];
  const firstKey = env[`${prefix}_API_KEY_1`];
  if (typeof firstKey === "string" && firstKey.length > 0) {
    numbered.push(firstKey);
    for (let i = 2; ; i++) {
      const v = env[`${prefix}_API_KEY_${i}`];
      if (typeof v !== "string" || v.length === 0) break;
      numbered.push(v);
    }
  }
  // Only a real pool (≥2) activates numbered pooling. A lone _1 falls
  // through to the single-key path per §9.1 rule 4.
  if (numbered.length >= 2) {
    return makePool(provider, numbered);
  }

  // 3. Unnumbered single key.
  const single = env[`${prefix}_API_KEY`];
  if (typeof single === "string" && single.length > 0) {
    return makePool(provider, [single]);
  }

  // 4. Fall back: lone _1 with no unnumbered → still a single-slot pool.
  if (numbered.length === 1) {
    const only = numbered[0];
    if (typeof only === "string" && only.length > 0) {
      return makePool(provider, [only]);
    }
  }

  return null;
}
