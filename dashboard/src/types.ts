export type PromptStatus = "not-started" | "in-progress" | "complete";
export type PhaseStatus = "not-started" | "in-progress" | "complete";

/**
 * Autobuild tier — 0 is the "first things first" batch (typecheck gate, etc.),
 * 4 is the riskiest. `FixPackProgressBar` and `TierStrip` render strips of
 * five cells corresponding to T0 … T4.
 */
export type Tier = 0 | 1 | 2 | 3 | 4;

/**
 * Optional per-prompt autobuild test spec. Emitted by the prompt front-matter
 * parser on the backend; rendered by `TestResultBadge`.
 */
export interface PromptTestSpec {
  name: string;
  kind?: string;
  /** Filled in by the runner for completed runs. */
  status?: "passed" | "failed" | "pending";
}

/**
 * Optional human-gate annotation — when set the run pauses in REVIEW state
 * until the user clicks Approve/Reject on the `ApprovalGate` widget.
 */
export interface PromptHumanGate {
  required: boolean;
  reason?: string;
}

export interface Prompt {
  id: string;
  /**
   * Numeric phase — parsed via `parseInt(p.phaseId, 10)` on the client.
   * Collides for non-numeric phases like `99b-unfucking-v2` (→ 99) and `10.5`
   * (→ 10). Use `phaseId` for unique keys / comparisons.
   */
  phase: number;
  /** Full raw phase identifier from the backend. Unique per phase directory. */
  phaseId: string;
  subPrompt: string;
  title: string;
  whenToRun: string;
  duration: string;
  newSession: boolean;
  model: string;
  filePath: string;
  status: PromptStatus;
  // ---- Extended autobuild frontmatter (all optional, backend-populated) ----
  tier?: Tier;
  scope?: string[];
  tests?: PromptTestSpec[];
  depends_on_fix?: string[];
  human_gate?: PromptHumanGate | boolean;
  max_turns?: number;
  max_cost_usd?: number;
  max_retries?: number;
  estimated_duration_min?: number;
}

export interface PromptDetail extends Prompt {
  /** Fully-assembled copy-pasteable prompt. Originates from backend `assembled`. */
  body: string;
  rawBody?: string;
}

/** Summary envelope shape — alias of `Prompt` for readability. */
export type PromptSummary = Prompt;

export interface Phase {
  /** Numeric phase. Non-unique when both "10" and "10.5" exist — use `phaseId`. */
  phase: number;
  /** Raw phase identifier from backend (e.g. "10", "10.5", "99b-unfucking-v2"). Unique. */
  phaseId: string;
  name: string;
  duration: string;
  dependsOn: number[];
  blocks: number[];
  promptCount: number;
  promptsCompleted: number;
  status: PhaseStatus;
}

export interface SessionLogEntry {
  date: string;
  session: number;
  phase: number;
  subPrompt: string;
  outcome: string;
}

/**
 * Canonical status snapshot for the UI. Field names mirror the backend's
 * `StatusSnapshot` (progressPercent / testsPassing / testsFailing /
 * burnRateTotal / phaseStatus) with the following normalizations applied
 * by `api.ts` before it reaches components:
 *   - `currentPhase`:   string → number (e.g. "01" → 1, null → 0)
 *   - `burnRateTotal`:  string like "$42.10" → number 42.10
 *   - `phaseStatus`:    keys parsed as numbers, values kept as 3-state enum
 *   - `sessionLog`:     sessionNumber string → session number
 */
export interface Status {
  lastUpdated: string;
  currentPhase: number;
  progressPercent: number;
  testsPassing: number;
  testsFailing: number;
  burnRateTotal: number;
  blockers: string[];
  phaseStatus: Record<number, PhaseStatus>;
  sessionLog: SessionLogEntry[];
}

/**
 * Backend SSE event names. The dashboard server emits these exactly.
 * See `dashboard/server/src/routes/events.ts`.
 */
export type SSEEventName =
  | "completion-log-changed"
  | "status-changed"
  | "prompt-added"
  | "prompt-changed"
  | "heartbeat";

export interface SSEEventPayload {
  name: SSEEventName;
  data?: unknown;
}

// ---------------------------------------------------------------------------
// Autobuild / rig state (matches the sibling backend spec, kept in sync)
// ---------------------------------------------------------------------------

/**
 * Lifecycle states for a single autobuild run. This mirrors the backend
 * `RunRecord.status` field 1:1 — do not rename without updating the server.
 *
 *   queued              – scheduled, no tmux yet
 *   spawning            – tmux session being created
 *   prompting           – claude-code session opening, prompt paste in flight
 *   working             – claude-code is actively chewing through the prompt
 *   completion_detected – heuristic matched completion marker in the log
 *   testing             – test harness is executing
 *   passed              – tests green
 *   failed              – tests red (will retry unless max_retries exceeded)
 *   retrying            – preparing to retry after a recoverable failure
 *   escalated           – hit max_retries or a non-retryable reason
 *   complete            – terminal success
 */
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

export interface RetryHistoryEntry {
  attempt: number;
  ts: string;
  reason_code: string;
  reason_detail: string;
  cost_at_retry: number;
  elapsed_at_retry_sec: number;
  hint_injected: string | null;
}

export interface RunRecord {
  status: RunStatus;
  tier: Tier;
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
  tests: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
  };
  commit_sha: string | null;
  last_error: string | null;
  last_retry_reason: string | null;
  needs_review: boolean;
  retry_history: RetryHistoryEntry[];
}

/** Compact row the runs-list endpoint may return; prefer `RunRecord`. */
export type RunSummary = Pick<
  RunRecord,
  | "status"
  | "tier"
  | "session_id"
  | "branch"
  | "attempt"
  | "max_retries"
  | "cost_usd"
  | "needs_review"
  | "commit_sha"
> & { updated_at: string };

/**
 * Rig process supervision snapshot — what `GET /api/rig/running` returns
 * and what `GET /api/runs` optionally embeds under `rig_process`.
 *   - running:  true when the autobuild daemon PID is alive
 *   - pid:      os pid, null when not running
 *   - since:    ISO timestamp of last transition to running
 *   - log_path: path of the daemon's stdout log (tail-able by the operator)
 */
export interface RigProcessStatus {
  running: boolean;
  pid: number | null;
  since: string | null;
  log_path?: string | null;
}

/**
 * Aggregate state for the whole rig — top-level payload of `GET /api/runs`.
 * `runs` is keyed by `prompt.id` (e.g. `phase-99b-unfucking-v2/02-extract`)
 * so the enrichment helper can look up by prompt id without re-scanning.
 */
export interface RigState {
  rig_version: string;
  rig_heartbeat: string | null;
  concurrency: 1 | 2;
  paused: boolean;
  halted: boolean;
  daily_budget_usd: {
    spent: number;
    cap: number;
    day: string;
  };
  runs: Record<string, RunRecord>;
  queue: string[];
  completed: string[];
  escalated: string[];
  /** Present when the sibling rig-control route has been rolled out. */
  rig_process?: RigProcessStatus;
}
