/**
 * Subagent concurrency gate (Phase 06 Prompt 02).
 *
 * Thin wrapper around `p-limit` that:
 *   - Clamps `maxConcurrency` into `[1, MAX_CONCURRENCY_CEILING]`.
 *   - Defaults to `DEFAULT_MAX_CONCURRENCY` when unset.
 *   - Exposes `activeCount()` / `pendingCount()` / `size` for observability.
 *   - Is created once per dispatcher and reused for every `run()` call.
 */

import pLimit, { type LimitFunction } from "p-limit";
import { logger as defaultLogger, type Logger } from "../logger.js";
import { DEFAULT_MAX_CONCURRENCY, MAX_CONCURRENCY_CEILING } from "./dispatch-types.js";

export interface Semaphore {
  run<T>(fn: () => Promise<T>): Promise<T>;
  activeCount(): number;
  pendingCount(): number;
  readonly size: number;
}

export interface CreateSubagentSemaphoreOptions {
  maxConcurrency?: number;
  logger?: Logger;
}

export function createSubagentSemaphore(config: CreateSubagentSemaphoreOptions = {}): Semaphore {
  const log = config.logger ?? defaultLogger;
  const requested = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

  let size: number;
  if (requested < 1) {
    size = 1;
  } else if (requested > MAX_CONCURRENCY_CEILING) {
    log.warn(
      {
        requested,
        ceiling: MAX_CONCURRENCY_CEILING,
      },
      "subagent maxConcurrency exceeds ceiling; clamping",
    );
    size = MAX_CONCURRENCY_CEILING;
  } else {
    size = requested;
  }

  const limit: LimitFunction = pLimit(size);

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return limit(fn);
    },
    activeCount(): number {
      return limit.activeCount;
    },
    pendingCount(): number {
      return limit.pendingCount;
    },
    size,
  };
}
