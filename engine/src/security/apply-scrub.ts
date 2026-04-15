/**
 * JSON-tree secret scrubber (Phase 08.03).
 *
 * Walks any JSON-shaped value and scrubs every string leaf using the shared
 * `scrubString` implementation. Returns a *new* value — input is never
 * mutated. Cycles are replaced with a `"[CYCLE]"` sentinel. A depth cap and
 * a soft time-budget guard protect against pathological payloads (the budget
 * only emits a warn log — we still finish the walk so the caller gets a full
 * scrub rather than a half-scrubbed payload being leaked onward).
 *
 * Object keys are NOT scrubbed (they're structural / not tool output). Only
 * string *values* flow through the scrubber.
 */

import { createLogger, type Logger } from "../logger.js";
import { type ScrubOptions, scrubString } from "./scrub.js";
import type { SecretPattern } from "./secret-patterns.js";

const log: Logger = createLogger({ name: "security.scrub" });

export interface ApplyScrubResult {
  readonly value: unknown;
  readonly hits: number;
  readonly byName: Record<string, number>;
  readonly truncated: boolean;
}

export interface ApplyScrubOptions extends ScrubOptions {
  /** Max recursion depth. Default 32. */
  readonly maxDepth?: number;
  /** Time budget in milliseconds. Default 100. Exceeding only warns. */
  readonly budgetMs?: number;
  /** Injected clock; default performance.now. */
  readonly now?: () => number;
}

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_BUDGET_MS = 100;
const CYCLE_SENTINEL = "[CYCLE]";
const TRUNCATED_SENTINEL = "[TRUNCATED]";

function defaultNow(): number {
  return performance.now();
}

interface WalkState {
  readonly patterns: readonly SecretPattern[];
  readonly scrubOpts: ScrubOptions;
  readonly maxDepth: number;
  readonly budgetMs: number;
  readonly now: () => number;
  readonly startedAt: number;
  readonly seen: WeakSet<object>;
  hits: number;
  byName: Record<string, number>;
  truncated: boolean;
  cycles: number;
  budgetWarned: boolean;
}

function walk(value: unknown, depth: number, state: WalkState): unknown {
  if (depth > state.maxDepth) {
    state.truncated = true;
    return TRUNCATED_SENTINEL;
  }

  if (typeof value === "string") {
    if (!state.budgetWarned) {
      const elapsed = state.now() - state.startedAt;
      if (elapsed > state.budgetMs) {
        state.budgetWarned = true;
        log.warn({ elapsedMs: elapsed, budgetMs: state.budgetMs }, "scrub budget exceeded");
      }
    }
    const res = scrubString(value, state.patterns, state.scrubOpts);
    state.hits += res.hits;
    for (const key of Object.keys(res.byName)) {
      const v = res.byName[key] ?? 0;
      state.byName[key] = (state.byName[key] ?? 0) + v;
    }
    return res.scrubbed;
  }

  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;

  const obj = value as object;
  if (state.seen.has(obj)) {
    state.cycles += 1;
    log.warn({ depth }, "cycle detected during scrub walk");
    return CYCLE_SENTINEL;
  }
  state.seen.add(obj);

  if (Array.isArray(value)) {
    const arr = value as readonly unknown[];
    const out: unknown[] = new Array(arr.length);
    for (let i = 0; i < arr.length; i += 1) {
      out[i] = walk(arr[i], depth + 1, state);
    }
    state.seen.delete(obj);
    return out;
  }

  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src)) {
    out[key] = walk(src[key], depth + 1, state);
  }
  state.seen.delete(obj);
  return out;
}

/**
 * Walk a JSON value and scrub every string leaf. Returns a new value; the
 * input is not mutated. Cycles replaced with `"[CYCLE]"`. Depth cap
 * replaces deeper values with `"[TRUNCATED]"` and sets `truncated: true`.
 */
export function applyScrub(
  value: unknown,
  patterns: readonly SecretPattern[],
  opts?: ApplyScrubOptions,
): ApplyScrubResult {
  const now = opts?.now ?? defaultNow;
  const scrubOpts: ScrubOptions = {
    ...(opts?.minLength !== undefined ? { minLength: opts.minLength } : {}),
    ...(opts?.fast !== undefined ? { fast: opts.fast } : {}),
  };
  const state: WalkState = {
    patterns,
    scrubOpts,
    maxDepth: opts?.maxDepth ?? DEFAULT_MAX_DEPTH,
    budgetMs: opts?.budgetMs ?? DEFAULT_BUDGET_MS,
    now,
    startedAt: now(),
    seen: new WeakSet<object>(),
    hits: 0,
    byName: {},
    truncated: false,
    cycles: 0,
    budgetWarned: false,
  };

  const walked = walk(value, 0, state);

  return {
    value: walked,
    hits: state.hits,
    byName: state.byName,
    truncated: state.truncated,
  };
}
