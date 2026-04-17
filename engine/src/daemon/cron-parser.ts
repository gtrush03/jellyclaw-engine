/**
 * Minimal five-field cron expression parser (T4-01).
 *
 * Supports: `m h dom mon dow` (minute, hour, day-of-month, month, day-of-week).
 * No seconds, no year, no Quartz extensions.
 *
 * Syntax per field:
 *   - `*` - all values
 *   - `N` - specific value
 *   - `N-M` - range
 *   - `N,M,O` - list
 *   - `* /N` - step (every N from min)
 *   - `N-M/S` - step within range
 *
 * Day-of-week: 0 = Sunday, 6 = Saturday (also accepts 7 = Sunday).
 *
 * ~120 lines, no third-party lib.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const CronExpression = z.string().refine(
  (s) => {
    try {
      parseCronExpression(s);
      return true;
    } catch {
      return false;
    }
  },
  { message: "Invalid cron expression" },
);
export type CronExpression = z.infer<typeof CronExpression>;

export interface ParsedCron {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

// ---------------------------------------------------------------------------
// Field bounds
// ---------------------------------------------------------------------------

const BOUNDS: Record<string, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
};

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();

  // Handle comma-separated parts.
  const parts = field.split(",");
  for (const part of parts) {
    // Check for step.
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const base = stepMatch ? stepMatch[1]! : part;
    const step = stepMatch ? parseInt(stepMatch[2]!, 10) : 1;

    if (step < 1) {
      throw new Error(`Invalid step value: ${step}`);
    }

    let rangeMin: number;
    let rangeMax: number;

    if (base === "*") {
      rangeMin = min;
      rangeMax = max;
    } else if (base.includes("-")) {
      const [startStr, endStr] = base.split("-");
      rangeMin = parseInt(startStr!, 10);
      rangeMax = parseInt(endStr!, 10);
      if (Number.isNaN(rangeMin) || Number.isNaN(rangeMax)) {
        throw new Error(`Invalid range: ${base}`);
      }
      if (rangeMin < min || rangeMax > max || rangeMin > rangeMax) {
        throw new Error(`Range out of bounds: ${base} (${min}-${max})`);
      }
    } else {
      const val = parseInt(base, 10);
      if (Number.isNaN(val) || val < min || val > max) {
        throw new Error(`Value out of bounds: ${base} (${min}-${max})`);
      }
      rangeMin = val;
      rangeMax = val;
    }

    // Apply step.
    for (let i = rangeMin; i <= rangeMax; i += step) {
      result.add(i);
    }
  }

  return result;
}

export function parseCronExpression(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  const [minField, hourField, domField, monField, dowField] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];

  // Day-of-week: normalize 7 to 0 (both mean Sunday).
  let normalizedDow = dowField;
  if (normalizedDow === "7") {
    normalizedDow = "0";
  } else if (normalizedDow.includes("7")) {
    normalizedDow = normalizedDow.replace(/\b7\b/g, "0");
  }

  // BOUNDS values are statically defined and always exist.
  const minuteBounds = BOUNDS.minute as [number, number];
  const hourBounds = BOUNDS.hour as [number, number];
  const dayOfMonthBounds = BOUNDS.dayOfMonth as [number, number];
  const monthBounds = BOUNDS.month as [number, number];
  const dayOfWeekBounds = BOUNDS.dayOfWeek as [number, number];

  return {
    minutes: parseField(minField, minuteBounds[0], minuteBounds[1]),
    hours: parseField(hourField, hourBounds[0], hourBounds[1]),
    daysOfMonth: parseField(domField, dayOfMonthBounds[0], dayOfMonthBounds[1]),
    months: parseField(monField, monthBounds[0], monthBounds[1]),
    daysOfWeek: parseField(normalizedDow, dayOfWeekBounds[0], dayOfWeekBounds[1]),
  };
}

// ---------------------------------------------------------------------------
// Next fire time calculation
// ---------------------------------------------------------------------------

/**
 * Compute the next fire time for a cron expression, starting from `afterMs`.
 * Returns Unix ms. Throws if no fire time found within 4 years (infinite loop guard).
 */
export function nextFireTime(expr: string, afterMs: number): number {
  const cron = parseCronExpression(expr);
  const maxIterations = 366 * 24 * 60 * 4; // ~4 years of minutes
  let iterations = 0;

  // Start from the next minute.
  const start = new Date(afterMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  const current = new Date(start);

  while (iterations < maxIterations) {
    iterations++;

    // Check month.
    if (!cron.months.has(current.getMonth() + 1)) {
      // Advance to next month.
      current.setMonth(current.getMonth() + 1);
      current.setDate(1);
      current.setHours(0, 0, 0, 0);
      continue;
    }

    // Check day of month AND day of week.
    // Standard cron: if both DOM and DOW are restricted (not `*`),
    // either match satisfies. If one is `*`, use the other.
    const domMatch = cron.daysOfMonth.has(current.getDate());
    const dowMatch = cron.daysOfWeek.has(current.getDay());

    // Check if DOM or DOW fields were wildcards.
    const domIsWildcard = cron.daysOfMonth.size === 31;
    const dowIsWildcard = cron.daysOfWeek.size === 7;

    let dayMatch: boolean;
    if (domIsWildcard && dowIsWildcard) {
      dayMatch = true;
    } else if (domIsWildcard) {
      dayMatch = dowMatch;
    } else if (dowIsWildcard) {
      dayMatch = domMatch;
    } else {
      // Both restricted — either matches.
      dayMatch = domMatch || dowMatch;
    }

    if (!dayMatch) {
      // Advance to next day.
      current.setDate(current.getDate() + 1);
      current.setHours(0, 0, 0, 0);
      continue;
    }

    // Check hour.
    if (!cron.hours.has(current.getHours())) {
      // Advance to next hour.
      current.setHours(current.getHours() + 1, 0, 0, 0);
      // Could have wrapped to next day.
      continue;
    }

    // Check minute.
    if (!cron.minutes.has(current.getMinutes())) {
      // Advance to next minute.
      current.setMinutes(current.getMinutes() + 1, 0, 0);
      // Could have wrapped to next hour.
      continue;
    }

    // All fields match.
    return current.getTime();
  }

  throw new Error(`No fire time found within 4 years for expression: ${expr}`);
}
