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
  /** Autobuild rig fields (optional — only present on new-format prompts) */
  tier?: 0 | 1 | 2 | 3 | 4;
  scope?: string[];
  depends_on_fix?: string[];
  tests?: unknown[];
  human_gate?: boolean;
  max_turns?: number;
  max_cost_usd?: number;
  max_retries?: number;
  estimated_duration_min?: number;
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
  | "heartbeat"
  // Autobuild-rig observer events — the dashboard never writes to
  // `.autobuild/` or `.orchestrator/`; it only watches + broadcasts.
  | "rig-state-changed"
  | "run-log-appended"
  | "rig-heartbeat-lost"
  | "rig-heartbeat-recovered"
  // Rig fresh-start — emitted by POST /api/rig/reset so open dashboards
  // auto-clear without needing a reload.
  | "reset";

export interface ServerEventPayload {
  event: ServerEventName;
  path?: string;
  at: string; // ISO
  // Optional per-event details. Keep loose — we serialize as JSON and
  // the frontend picks what it needs per-event. Using a narrow union would
  // force the broadcast helper to know every event's payload shape up front.
  data?: Record<string, unknown>;
}

// ----------------------------------------------------------------------
// Autobuild-rig shapes — authoritative source is `.autobuild/state.json`,
// owned by the rig. We mirror the fields here so the dashboard can type-check
// everything it surfaces. Never write these back to disk from the server.
// ----------------------------------------------------------------------

export type RunStatus =
  | "queued"
  | "spawning"
  | "prompting"
  | "working"
  | "completion_detected"
  | "testing"
  | "passed"
  | "failed"
  | "retrying"
  | "escalated"
  | "complete";

export type RunTier = 0 | 1 | 2 | 3 | 4;

export interface RetryHistoryEntry {
  attempt: number;
  ts: string;
  reason_code: string;
  reason_detail: string;
  cost_at_retry: number;
  elapsed_at_retry_sec: number;
  hint_injected: string | null;
}

export interface TestResult {
  name: string;
  kind: "jellyclaw-run" | "smoke-suite" | "http-roundtrip" | "shell";
  status: "pending" | "passed" | "failed";
  detail?: string;
}

export interface RunRecord {
  status: RunStatus;
  tier: RunTier;
  session_id: string;
  tmux_session: string;
  branch: string;
  started_at: string | null;
  updated_at: string;
  ended_at: string | null;
  attempt: number;
  max_retries: number;
  turns_used: number;
  cost_usd: number;
  self_check: null | {
    ts: string;
    decision: "continue" | "escalate";
    reason: string;
    cost_at_gate: number;
  };
  log_path: string;
  events_path: string;
  tests: { total: number; passed: number; failed: number; pending: number };
  commit_sha: string | null;
  last_error: string | null;
  last_retry_reason: string | null;
  needs_review: boolean;
  retry_history: RetryHistoryEntry[];
}

/**
 * A flattened view of RunRecord for list endpoints — all fields from
 * RunRecord plus an `id` we derive from the state.json key.
 */
export interface RunSummary extends RunRecord {
  id: string;
}

export interface RigState {
  /** ISO timestamp. Null if the rig hasn't written a heartbeat yet. */
  rig_heartbeat: string | null;
  rig_paused: boolean;
  /** Map of runId → RunRecord. */
  runs: Record<string, RunRecord>;
  /** Any extra top-level the rig writes passes through untouched. */
  [k: string]: unknown;
}

export type RigActionCmd = "abort" | "approve" | "retry" | "reject" | "skip";

export interface RigAction {
  cmd: RigActionCmd;
  target: string;
  payload?: Record<string, unknown>;
  ts: string;
  by: "dashboard";
  note?: string;
}

/**
 * Runtime info about the dispatcher daemon that the dashboard started.
 * Populated by reading `.orchestrator/dispatcher.pid` and probing the PID.
 */
export interface RigProcessInfo {
  running: boolean;
  pid: number | null;
  since: string | null;
  log_path: string | null;
}
