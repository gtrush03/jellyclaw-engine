/**
 * Per-event Zod schemas + payload helpers (Phase 08.02).
 *
 * Every hook event kind in `HookEventKind` has a corresponding `.strict()`
 * Zod schema here. The runner uses these to validate hook stdout when a hook
 * returns a `modified` payload, and the registry uses
 * `truncateToolResultForHook` to cap the size of `toolResult` before it is
 * serialized into a PostToolUse stdin blob.
 *
 * These schemas intentionally mirror the interfaces in `./types.ts` shape for
 * shape. Types flow out of Zod (`.output<T>`) in places where we need them,
 * but the canonical source is `types.ts` — we use `z.ZodType<Interface>` so
 * any drift is caught at type-check time.
 */
import { z } from "zod";
import type {
  HookEvent,
  HookEventKind,
  HookEventMap,
  HookPayloadSchemas,
  InstructionsLoadedPayload,
  NotificationPayload,
  PostToolUsePayload,
  PreCompactPayload,
  PreToolUsePayload,
  SessionStartPayload,
  StopPayload,
  SubagentStartPayload,
  SubagentStopPayload,
  UserPromptSubmitPayload,
} from "./types.js";
import { ALL_HOOK_EVENTS, MODIFIABLE_EVENTS } from "./types.js";

// ---------------------------------------------------------------------------
// Reusable fragments
// ---------------------------------------------------------------------------

const recordOfUnknown = z.record(z.string(), z.unknown());
const recordOfString = z.record(z.string(), z.string());

// ---------------------------------------------------------------------------
// Per-event schemas
// ---------------------------------------------------------------------------

export const SessionStartPayloadSchema: z.ZodType<SessionStartPayload> = z
  .object({
    sessionId: z.string(),
    cwd: z.string(),
    config: recordOfUnknown,
  })
  .strict();

export const InstructionsLoadedPayloadSchema: z.ZodType<InstructionsLoadedPayload> = z
  .object({
    sessionId: z.string(),
    claudeMd: z.union([z.string(), z.null()]),
    systemPromptBytes: z.number().int().nonnegative(),
  })
  .strict();

export const UserPromptSubmitPayloadSchema: z.ZodType<UserPromptSubmitPayload> = z
  .object({
    sessionId: z.string(),
    prompt: z.string(),
  })
  .strict();

export const PreToolUsePayloadSchema: z.ZodType<PreToolUsePayload> = z
  .object({
    sessionId: z.string(),
    toolName: z.string(),
    toolInput: recordOfUnknown,
    callId: z.string(),
  })
  .strict();

export const PostToolUsePayloadSchema: z.ZodType<PostToolUsePayload> = z
  .object({
    sessionId: z.string(),
    toolName: z.string(),
    toolInput: recordOfUnknown,
    // `toolResult` is `unknown` in the interface — always present but may be
    // `undefined`. We model it as a required field that accepts any value
    // (including undefined) so `exactOptionalPropertyTypes` doesn't flag it
    // as an optional property.
    toolResult: z.unknown().transform((v) => v),
    callId: z.string(),
    durationMs: z.number().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict() as unknown as z.ZodType<PostToolUsePayload>;

export const SubagentStartPayloadSchema: z.ZodType<SubagentStartPayload> = z
  .object({
    parentSessionId: z.string(),
    subagentSessionId: z.string(),
    agentName: z.string(),
  })
  .strict();

export const SubagentStopPayloadSchema: z.ZodType<SubagentStopPayload> = z
  .object({
    parentSessionId: z.string(),
    subagentSessionId: z.string(),
    reason: z.string(),
    usage: recordOfUnknown,
  })
  .strict();

export const PreCompactPayloadSchema: z.ZodType<PreCompactPayload> = z
  .object({
    sessionId: z.string(),
    tokenCount: z.number().int().nonnegative(),
    threshold: z.number().int().nonnegative(),
  })
  .strict();

export const StopPayloadSchema: z.ZodType<StopPayload> = z
  .object({
    sessionId: z.string(),
    reason: z.string(),
    usage: recordOfUnknown,
  })
  .strict();

export const NotificationPayloadSchema: z.ZodType<NotificationPayload> = z
  .object({
    sessionId: z.string(),
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
  })
  .strict();

// Silence "unused" lint for `recordOfString` — kept as a convenience export.
void recordOfString;

// ---------------------------------------------------------------------------
// Registry — keyed by HookEventKind
// ---------------------------------------------------------------------------

export const HOOK_PAYLOAD_SCHEMAS: HookPayloadSchemas = {
  SessionStart: SessionStartPayloadSchema,
  InstructionsLoaded: InstructionsLoadedPayloadSchema,
  UserPromptSubmit: UserPromptSubmitPayloadSchema,
  PreToolUse: PreToolUsePayloadSchema,
  PostToolUse: PostToolUsePayloadSchema,
  SubagentStart: SubagentStartPayloadSchema,
  SubagentStop: SubagentStopPayloadSchema,
  PreCompact: PreCompactPayloadSchema,
  Stop: StopPayloadSchema,
  Notification: NotificationPayloadSchema,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a hook-supplied `modified` payload against the schema for its
 * event kind. Returns the parsed payload or `null` if validation fails OR if
 * the event is not modifiable (non-modifiable events may never mutate
 * payloads — the runner should treat a non-null `modified` on such events as
 * a protocol error, handled upstream).
 */
export function validateModifiedPayload<K extends HookEventKind>(
  kind: K,
  value: unknown,
): HookEventMap[K] | null {
  if (!MODIFIABLE_EVENTS.has(kind)) return null;
  const schema = HOOK_PAYLOAD_SCHEMAS[kind];
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  return parsed.data as HookEventMap[K];
}

/**
 * JSON-stringify-size-check helper. If the serialized representation of
 * `result` exceeds `maxBytes`, replace it with a small envelope so the hook
 * stdin payload never blows past the cap.
 *
 * Returns `{ value, truncated: false }` unchanged on happy path.
 */
export function truncateToolResultForHook(
  result: unknown,
  maxBytes: number,
): { value: unknown; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify(result ?? null) ?? "null";
  } catch {
    // Circular / non-serializable: definitely too large to pass through.
    return {
      value: {
        truncated: true,
        sizeBytes: -1,
        preview: "[unserializable]",
      },
      truncated: true,
    };
  }

  const sizeBytes = Buffer.byteLength(serialized, "utf8");
  if (sizeBytes <= maxBytes) {
    return { value: result, truncated: false };
  }

  const preview = serialized.slice(0, 512);
  return {
    value: { truncated: true, sizeBytes, preview },
    truncated: true,
  };
}

// ---------------------------------------------------------------------------
// Event factory helpers — ten tiny typed constructors.
// ---------------------------------------------------------------------------

export function makeSessionStartEvent(
  payload: SessionStartPayload,
): Extract<HookEvent, { kind: "SessionStart" }> {
  return { kind: "SessionStart", payload };
}

export function makeInstructionsLoadedEvent(
  payload: InstructionsLoadedPayload,
): Extract<HookEvent, { kind: "InstructionsLoaded" }> {
  return { kind: "InstructionsLoaded", payload };
}

export function makeUserPromptSubmitEvent(
  payload: UserPromptSubmitPayload,
): Extract<HookEvent, { kind: "UserPromptSubmit" }> {
  return { kind: "UserPromptSubmit", payload };
}

export function makePreToolUseEvent(
  payload: PreToolUsePayload,
): Extract<HookEvent, { kind: "PreToolUse" }> {
  return { kind: "PreToolUse", payload };
}

export function makePostToolUseEvent(
  payload: PostToolUsePayload,
): Extract<HookEvent, { kind: "PostToolUse" }> {
  return { kind: "PostToolUse", payload };
}

export function makeSubagentStartEvent(
  payload: SubagentStartPayload,
): Extract<HookEvent, { kind: "SubagentStart" }> {
  return { kind: "SubagentStart", payload };
}

export function makeSubagentStopEvent(
  payload: SubagentStopPayload,
): Extract<HookEvent, { kind: "SubagentStop" }> {
  return { kind: "SubagentStop", payload };
}

export function makePreCompactEvent(
  payload: PreCompactPayload,
): Extract<HookEvent, { kind: "PreCompact" }> {
  return { kind: "PreCompact", payload };
}

export function makeStopEvent(payload: StopPayload): Extract<HookEvent, { kind: "Stop" }> {
  return { kind: "Stop", payload };
}

export function makeNotificationEvent(
  payload: NotificationPayload,
): Extract<HookEvent, { kind: "Notification" }> {
  return { kind: "Notification", payload };
}

// Re-export for downstream convenience.
export { ALL_HOOK_EVENTS };
