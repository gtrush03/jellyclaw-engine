/**
 * Shared types between the dashboard server and the frontend React SPA.
 * The frontend agent re-declares these (solo-repo convention).
 */

export type PhaseStatus = "not-started" | "in-progress" | "complete";

export interface PromptSummary {
  /** Stable URL-safe id, e.g. `phase-01/02-implement` */
  id: string;
  /** Zero-padded phase number as string, e.g. "01" */
  phase: string;
  /** Sub-prompt slug (filename without .md), e.g. "02-implement" */
  subPrompt: string;
  /** H1 title from the markdown */
  title: string;
  /** "**When to run:** …" line value */
  whenToRun: string | null;
  /** "**Estimated duration:** …" */
  duration: string | null;
  /** "**New session?** …" */
  newSession: string | null;
  /** "**Model:** …" */
  model: string | null;
  /** Absolute path on disk */
  filePath: string;
  /** Derived from COMPLETION-LOG — whether its phase is complete */
  status: PhaseStatus;
}

export interface PromptDetail extends PromptSummary {
  /** Fully-assembled copy-pasteable prompt (startup + body + closeout, substituted) */
  assembled: string;
}

export interface PromptRaw {
  id: string;
  filePath: string;
  raw: string;
}

export interface PhaseFrontmatter {
  phase: number;
  name: string;
  duration: string;
  depends_on: number[];
  blocks: number[];
}

export interface PhaseSummary {
  phase: string; // zero-padded
  name: string;
  duration: string;
  depends_on: number[];
  blocks: number[];
  promptCount: number;
  promptsCompleted: number;
  status: PhaseStatus;
}

export interface PhaseDetail extends PhaseSummary {
  /** Raw frontmatter + markdown body rendered as string */
  body: string;
  prompts: PromptSummary[];
}

export interface SessionLogRow {
  date: string;
  sessionNumber: string;
  phase: string;
  subPrompt: string;
  outcome: string;
}

export interface StatusSnapshot {
  lastUpdated: string | null;
  currentPhase: string | null;
  progressPercent: number;
  testsPassing: number;
  testsFailing: number;
  burnRateTotal: string | null;
  blockers: string[];
  phaseStatus: Record<string, PhaseStatus>;
  sessionLog: SessionLogRow[];
}

export type ServerEventName =
  | "completion-log-changed"
  | "status-changed"
  | "prompt-added"
  | "prompt-changed"
  | "heartbeat";

export interface ServerEventPayload {
  event: ServerEventName;
  path?: string;
  at: string; // ISO
}
