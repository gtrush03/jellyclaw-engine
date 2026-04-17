/**
 * Resume handler for scheduled jobs (T4-02).
 *
 * When a ScheduleWakeup or Cron job fires, this handler:
 * 1. Reads the stored payload (prompt, reason, owner_session, model_hint)
 * 2. Spawns a fresh agent turn via continueSession
 * 3. Records completion/error in job_events
 * 4. Respects daily budget cap (skips if over budget)
 */

import type { Logger } from "pino";

import { createLogger } from "../../logger.js";
import { nextFireTime } from "../cron-parser.js";
import type { Job, JobStore } from "../store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobPayload {
  readonly prompt: string;
  readonly reason: string;
  readonly owner_session: string;
  readonly model_hint?: string | null;
  readonly scheduled_at?: number;
  readonly expression?: string;
}

export interface ResumeHandlerOptions {
  store: JobStore;
  logger?: Logger;
  /** For testing: override the session continuation function. */
  continueSession?: (sessionId: string, prompt: string, reason: string) => Promise<void>;
  /** For testing: override the budget check. */
  checkBudget?: () => { exceeded: boolean; reason?: string };
  /** Injectable clock for testing. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Budget checking (stub for now - full implementation in future phase)
// ---------------------------------------------------------------------------

function defaultBudgetCheck(): { exceeded: boolean; reason?: string } {
  // TODO: Implement budget checking from ledger.jsonl per DAEMON-DESIGN.md:107-114
  return { exceeded: false };
}

// ---------------------------------------------------------------------------
// Session continuation (stub for now - full implementation needs agent loop)
// ---------------------------------------------------------------------------

function defaultContinueSession(
  sessionId: string,
  prompt: string,
  reason: string,
  logger: Logger,
): Promise<void> {
  // TODO: Wire to actual runAgentLoop when full integration is done.
  // For now, log the resume and return success.
  logger.info(
    {
      sessionId,
      promptLength: prompt.length,
      reason,
    },
    "resume.continue_session (stub)",
  );

  // In real implementation:
  // 1. Check if session transcript exists at ~/.jellyclaw/sessions/<sessionId>/
  // 2. If yes, append new turn to existing transcript
  // 3. If no (session GC'd), start new session with header referencing job
  // 4. Call runAgentLoop with the prompt
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export interface ResumeHandler {
  handleWakeup: (job: Job) => Promise<void>;
  handleCron: (job: Job) => Promise<void>;
}

export function createResumeHandler(options: ResumeHandlerOptions): ResumeHandler {
  const { store, now = Date.now } = options;
  const logger = options.logger ?? createLogger({ name: "resume-handler", destination: "stderr" });
  const checkBudget = options.checkBudget ?? defaultBudgetCheck;
  const continueSession =
    options.continueSession ??
    ((sessionId: string, prompt: string, reason: string) =>
      defaultContinueSession(sessionId, prompt, reason, logger));

  async function handleJob(job: Job, isWakeup: boolean): Promise<void> {
    let payload: JobPayload;

    try {
      payload = JSON.parse(job.payload);
    } catch (err) {
      logger.error({ jobId: job.id, error: err }, "resume: failed to parse payload");
      store.markError(job.id, "Invalid payload JSON", now());
      store.appendEvent(job.id, "error", "Invalid payload JSON");
      return;
    }

    // Check budget.
    const budget = checkBudget();
    if (budget.exceeded) {
      logger.warn({ jobId: job.id, reason: budget.reason }, "resume: budget exceeded");
      store.appendEvent(job.id, "skipped", `budget_exceeded: ${budget.reason ?? "daily cap hit"}`);

      if (isWakeup) {
        // Wakeup jobs are marked failed and NOT re-queued.
        store.markError(job.id, "budget_exceeded", now());
      } else if (job.cron_expr) {
        // Cron jobs advance to next legitimate fire time.
        const nextFire = nextFireTime(job.cron_expr, now());
        store.updateFireAt(job.id, nextFire, now());
        logger.info({ jobId: job.id, nextFire }, "resume: rescheduled cron after budget skip");
      }
      return;
    }

    // Execute the continuation.
    try {
      await continueSession(payload.owner_session, payload.prompt, payload.reason);

      logger.info({ jobId: job.id, sessionId: payload.owner_session }, "resume: completed");
      store.appendEvent(job.id, "completed");

      if (isWakeup) {
        store.markDone(job.id, now());
      }
      // Cron jobs are already handled by the scheduler (reschedule happens in scheduler.ts)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const truncatedStack = err instanceof Error ? (err.stack ?? "").slice(0, 500) : "";

      logger.error({ jobId: job.id, error: message }, "resume: handler error");
      store.appendEvent(job.id, "error", truncatedStack || message);

      if (isWakeup) {
        store.markError(job.id, message, now());
      }
      // Cron jobs still get rescheduled by the scheduler despite the error
    }
  }

  return {
    handleWakeup(job: Job): Promise<void> {
      return handleJob(job, true);
    },

    handleCron(job: Job): Promise<void> {
      return handleJob(job, false);
    },
  };
}

// ---------------------------------------------------------------------------
// Register handlers with scheduler
// ---------------------------------------------------------------------------

export function registerResumeHandlers(
  scheduler: {
    registerHandler: (kind: "wakeup" | "cron", fn: (job: Job) => Promise<void>) => void;
    store: JobStore;
  },
  options: Omit<ResumeHandlerOptions, "store"> = {},
): void {
  const handler = createResumeHandler({ ...options, store: scheduler.store });
  scheduler.registerHandler("wakeup", handler.handleWakeup);
  scheduler.registerHandler("cron", handler.handleCron);
}
