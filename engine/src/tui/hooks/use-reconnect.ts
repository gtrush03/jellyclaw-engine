/**
 * Exponential-backoff reconnect hook (T3-09).
 *
 * Schedules retries with capped exponential backoff when a connection is lost.
 * Formula: delay = min(capMs, baseMs * 2^(attempt-1)) * (1 + jitter)
 */

import { useEffect, useRef } from "react";

export interface UseReconnectArgs {
  /** Called before each retry attempt with the attempt number and delay. */
  readonly onAttempt: (attempt: number, delayMs: number) => void;
  /** Called if maxAttempts is reached without success. */
  readonly onGiveUp?: (attempts: number) => void;
  /** Performs the reconnect; resolves on success, throws on fail. */
  readonly trigger: () => Promise<void>;
  /** Maximum number of attempts before giving up. Default: Infinity. */
  readonly maxAttempts?: number;
  /** Base delay in ms. Default: 1000. */
  readonly baseMs?: number;
  /** Maximum delay cap in ms. Default: 30000. */
  readonly capMs?: number;
  /** Jitter ratio (±). Default: 0.2. */
  readonly jitterRatio?: number;
  /** Whether reconnect is active. When false, no retries are scheduled. */
  readonly active: boolean;
}

/**
 * Calculate delay with exponential backoff and jitter.
 */
export function calculateDelay(
  attempt: number,
  baseMs: number,
  capMs: number,
  jitterRatio: number,
): number {
  // Base delay with exponential growth: baseMs * 2^(attempt-1)
  const exponentialDelay = baseMs * 2 ** (attempt - 1);
  // Cap the delay
  const cappedDelay = Math.min(capMs, exponentialDelay);
  // Apply jitter: ±jitterRatio
  const jitter = 1 + (Math.random() * 2 - 1) * jitterRatio;
  return Math.round(cappedDelay * jitter);
}

/**
 * Hook that manages exponential-backoff reconnection attempts.
 */
export function useReconnect(args: UseReconnectArgs): void {
  const {
    onAttempt,
    onGiveUp,
    trigger,
    maxAttempts = Infinity,
    baseMs = 1000,
    capMs = 30_000,
    jitterRatio = 0.2,
    active,
  } = args;

  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    // Clear any existing timer when active state changes
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (!active) {
      // Reset attempt counter when we become inactive (i.e., connected)
      attemptRef.current = 0;
      return;
    }

    const scheduleAttempt = (): void => {
      if (!mountedRef.current) return;

      attemptRef.current += 1;
      const attempt = attemptRef.current;

      if (attempt > maxAttempts) {
        if (onGiveUp !== undefined) {
          onGiveUp(attempt - 1);
        }
        return;
      }

      const delay = calculateDelay(attempt, baseMs, capMs, jitterRatio);
      onAttempt(attempt, delay);

      timerRef.current = setTimeout(() => {
        if (!mountedRef.current) return;

        void (async () => {
          try {
            await trigger();
            // Success — the parent will set active to false, which resets the counter
          } catch {
            // Failed — schedule another attempt
            if (mountedRef.current && active) {
              scheduleAttempt();
            }
          }
        })();
      }, delay);
    };

    // Start the first attempt
    scheduleAttempt();

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [active, baseMs, capMs, jitterRatio, maxAttempts, onAttempt, onGiveUp, trigger]);
}
