/**
 * Smoke import — proves `@jellyclaw/shared` resolves from the engine
 * package under our workspace + tsconfig paths setup. The Phase 03
 * Prompt 02 adapter will replace this file with the real translator.
 */

import type { Event, EventType } from "@jellyclaw/shared";
import { EVENT_TYPES, parseEvent } from "@jellyclaw/shared";

export function firstType(): EventType {
  const t = EVENT_TYPES[0];
  if (t === undefined) throw new Error("EVENT_TYPES is empty");
  return t;
}

export function parse(e: unknown): Event {
  return parseEvent(e);
}
