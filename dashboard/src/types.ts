export type PromptStatus = 'not-started' | 'in-progress' | 'complete';
export type PhaseStatus = 'not-started' | 'in-progress' | 'complete';

export interface Prompt {
  id: string;
  phase: number;
  subPrompt: string;
  title: string;
  whenToRun: string;
  duration: string;
  newSession: boolean;
  model: string;
  filePath: string;
  status: PromptStatus;
}

export interface PromptDetail extends Prompt {
  /** Fully-assembled copy-pasteable prompt. Originates from backend `assembled`. */
  body: string;
  rawBody?: string;
}

export interface Phase {
  phase: number;
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
  | 'completion-log-changed'
  | 'status-changed'
  | 'prompt-added'
  | 'prompt-changed'
  | 'heartbeat';

export interface SSEEventPayload {
  name: SSEEventName;
  data?: unknown;
}
