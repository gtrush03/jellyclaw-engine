/**
 * `useAnimationTick` — shared animation clock.
 *
 * Returns a monotonically-incrementing integer that advances every `interval`
 * ms. Callers mod by their frame array length. When `reducedMotion` is true
 * or `active` is false, the hook returns 0 and schedules nothing — callers
 * should paint their static frame.
 *
 * All animation components in the TUI share this single hook so we don't end
 * up with half a dozen independent intervals racing each other on every
 * re-render.
 */

import { useEffect, useState } from "react";

export interface UseAnimationTickOptions {
  readonly interval: number;
  readonly active?: boolean;
  readonly reducedMotion?: boolean;
}

export function useAnimationTick(options: UseAnimationTickOptions): number {
  const { interval, active = true, reducedMotion = false } = options;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (reducedMotion) return undefined;
    if (!active) return undefined;
    const handle = setInterval(() => {
      setTick((t) => (t + 1) % 1_000_000);
    }, Math.max(16, interval));
    return (): void => {
      clearInterval(handle);
    };
  }, [interval, active, reducedMotion]);

  return tick;
}
