/**
 * Runtime schema validation for every API response the dashboard fetches.
 *
 * The frontend and backend are owned by different agents and evolve independently.
 * Parsing every response with Zod means a schema drift blows up loudly with a
 * field-level error message, instead of rendering a blank card or crashing
 * somewhere deep in a memoised selector.
 *
 * Usage:
 *
 *   const res = await fetch('/api/prompts');
 *   const data = PromptsListResponseSchema.parse(await res.json());
 *   // `data` is now strongly typed AND validated.
 *
 * If the backend ever changes shape, these schemas are the single place to update.
 */
import { z } from 'zod';

export const PhaseStatusSchema = z.enum(['not-started', 'in-progress', 'complete']);
export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

/**
 * Matches backend `PromptSummary` exactly (see `dashboard/server/src/types.ts`).
 * Backend emits `phase` as a zero-padded string ("01"), not a number.
 */
export const PromptSchema = z.object({
  id: z.string().regex(/^phase-[a-z0-9][a-z0-9.\-]*\/[a-z0-9][a-z0-9.\-]*$/i),
  phase: z.string().regex(/^[a-z0-9][a-z0-9.\-]*$/i),
  subPrompt: z.string(),
  title: z.string(),
  whenToRun: z.string().nullable(),
  duration: z.string().nullable(),
  newSession: z.string().nullable(),
  model: z.string().nullable(),
  filePath: z.string(),
  status: PhaseStatusSchema,
  // Autobuild-rig fields (optional — present only on phase-99b-unfucking-v2 prompts)
  tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  scope: z.array(z.string()).optional(),
  depends_on_fix: z.array(z.string()).optional(),
  tests: z.array(z.unknown()).optional(),
  human_gate: z.boolean().optional(),
  max_turns: z.number().optional(),
  max_cost_usd: z.number().optional(),
  max_retries: z.number().optional(),
  estimated_duration_min: z.number().optional(),
});
export type Prompt = z.infer<typeof PromptSchema>;

export const PromptDetailSchema = PromptSchema.extend({
  assembled: z.string().min(1),
});
export type PromptDetail = z.infer<typeof PromptDetailSchema>;

/** Envelope shape returned by `GET /api/prompts`. */
export const PromptsListResponseSchema = z.object({
  prompts: z.array(PromptSchema),
  count: z.number().int().nonnegative(),
});
export type PromptsListResponse = z.infer<typeof PromptsListResponseSchema>;

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

export const PhaseSchema = z.object({
  phase: z.string().regex(/^\d{1,2}(?:\.\d+)?$/),
  name: z.string(),
  duration: z.string(),
  depends_on: z.array(z.number().int().nonnegative()),
  blocks: z.array(z.number().int().nonnegative()),
  promptCount: z.number().int().nonnegative(),
  promptsCompleted: z.number().int().nonnegative(),
  status: PhaseStatusSchema,
});
export type Phase = z.infer<typeof PhaseSchema>;

export const PhaseDetailSchema = PhaseSchema.extend({
  body: z.string(),
  prompts: z.array(PromptSchema),
});
export type PhaseDetail = z.infer<typeof PhaseDetailSchema>;

export const PhasesListResponseSchema = z.object({
  phases: z.array(PhaseSchema),
  count: z.number().int().nonnegative(),
});
export type PhasesListResponse = z.infer<typeof PhasesListResponseSchema>;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const SessionLogRowSchema = z.object({
  date: z.string(),
  sessionNumber: z.string(),
  phase: z.string(),
  subPrompt: z.string(),
  outcome: z.string(),
});

export const StatusSchema = z.object({
  lastUpdated: z.string().nullable(),
  currentPhase: z.string().nullable(),
  progressPercent: z.number().min(0).max(100),
  testsPassing: z.number().int().nonnegative(),
  testsFailing: z.number().int().nonnegative(),
  burnRateTotal: z.string().nullable(),
  blockers: z.array(z.string()),
  phaseStatus: z.record(z.string(), PhaseStatusSchema),
  sessionLog: z.array(SessionLogRowSchema),
});
export type Status = z.infer<typeof StatusSchema>;

// ---------------------------------------------------------------------------
// Events (SSE)
// ---------------------------------------------------------------------------

export const ServerEventNameSchema = z.enum([
  'completion-log-changed',
  'status-changed',
  'prompt-added',
  'prompt-changed',
  'heartbeat',
]);
export type ServerEventName = z.infer<typeof ServerEventNameSchema>;

export const EventSchema = z.object({
  event: ServerEventNameSchema,
  path: z.string().optional(),
  at: z.string().datetime(),
});
export type ServerEvent = z.infer<typeof EventSchema>;

// ---------------------------------------------------------------------------
// Typed mismatch error
// ---------------------------------------------------------------------------

export class ApiSchemaError extends Error {
  readonly endpoint: string;
  readonly issues: z.ZodIssue[];

  constructor(endpoint: string, issues: z.ZodIssue[]) {
    super(
      `API schema mismatch at ${endpoint}: ${issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`,
    );
    this.name = 'ApiSchemaError';
    this.endpoint = endpoint;
    this.issues = issues;
  }
}

/**
 * Parses `data` with `schema`, throwing `ApiSchemaError` with a useful message on failure.
 * Keeps Zod errors from leaking into UI components.
 */
export function parseApi<T>(
  schema: z.ZodType<T>,
  endpoint: string,
  data: unknown,
): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ApiSchemaError(endpoint, parsed.error.issues);
  }
  return parsed.data;
}
