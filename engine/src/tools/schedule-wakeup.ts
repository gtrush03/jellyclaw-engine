/**
 * ScheduleWakeup tool — one-shot delayed resume (T4-02).
 *
 * Schedules a job to fire after `delaySeconds` (60-3600). When the job fires,
 * the daemon's resume handler spawns a new agent turn with the attached prompt.
 *
 * Requires the scheduler daemon to be running (`jellyclaw daemon start`).
 */

import * as os from "node:os";
import * as path from "node:path";

import { z } from "zod";

import { IpcClient } from "../daemon/ipc.js";
import type { JsonSchema, Tool, ToolContext } from "./types.js";
import { ToolError } from "./types.js";

// ---------------------------------------------------------------------------
// Input/Output schemas
// ---------------------------------------------------------------------------

export const scheduleWakeupInputSchema = z.object({
  delaySeconds: z.number().int().min(60).max(3600),
  prompt: z.string().min(1).max(8192),
  reason: z.string().min(1).max(512),
});

export type ScheduleWakeupInput = z.infer<typeof scheduleWakeupInputSchema>;

export const scheduleWakeupOutputSchema = z.object({
  job_id: z.string(),
  fire_at_unix_ms: z.number(),
});

export type ScheduleWakeupOutput = z.infer<typeof scheduleWakeupOutputSchema>;

// ---------------------------------------------------------------------------
// JSON Schema for Claude Code compatibility
// ---------------------------------------------------------------------------

const inputSchemaJson: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    delaySeconds: {
      type: "integer",
      minimum: 60,
      maximum: 3600,
      description: "Delay in seconds before the scheduled prompt fires (60-3600).",
    },
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: 8192,
      description: "The prompt to execute when the job fires.",
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description: "Human-readable reason for scheduling this wakeup.",
    },
  },
  required: ["delaySeconds", "prompt", "reason"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateJobId(): string {
  // Simple ULID-like ID: timestamp + random.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 10);
  return `wakeup-${ts}-${rand}`;
}

function defaultStateDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) {
    return path.join(xdg, "jellyclaw");
  }
  return path.join(os.homedir(), ".jellyclaw");
}

function getSocketPath(): string {
  const override = process.env.JELLYCLAW_SCHEDULER_SOCKET;
  if (override && override.length > 0) {
    return override;
  }
  return path.join(defaultStateDir(), "scheduler.sock");
}

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

async function handler(
  input: ScheduleWakeupInput,
  ctx: ToolContext,
): Promise<ScheduleWakeupOutput> {
  const { delaySeconds, prompt, reason } = input;

  const socketPath = getSocketPath();
  const client = new IpcClient({ socketPath, timeoutMs: 5000 });

  const jobId = generateJobId();
  const now = Date.now();
  const fireAt = now + delaySeconds * 1000;

  const payload = JSON.stringify({
    prompt,
    reason,
    owner_session: ctx.sessionId,
    model_hint: null, // Could be extended later to pass model preference.
    scheduled_at: now,
  });

  try {
    await client.enqueue({
      id: jobId,
      kind: "wakeup",
      fire_at: fireAt,
      payload,
      owner: ctx.sessionId,
    });

    ctx.logger.info({ jobId, fireAt, delaySeconds }, "ScheduleWakeup: job enqueued");

    return {
      job_id: jobId,
      fire_at_unix_ms: fireAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Check for common socket errors.
    if (message.includes("ENOENT") || message.includes("ECONNREFUSED")) {
      throw new ToolError(
        "daemon_unreachable",
        "Scheduler daemon is not running. Run `jellyclaw daemon start` or install the launchd/systemd unit. See docs/daemon.md.",
        { socketPath },
      );
    }

    throw new ToolError("schedule_failed", `Failed to schedule wakeup: ${message}`, {
      jobId,
      delaySeconds,
    });
  }
}

// ---------------------------------------------------------------------------
// Tool export
// ---------------------------------------------------------------------------

export const scheduleWakeupTool: Tool<ScheduleWakeupInput, ScheduleWakeupOutput> = {
  name: "ScheduleWakeup",
  description:
    "Schedule a one-shot delayed resume. The prompt will be executed after the specified delay (60-3600 seconds). Requires the scheduler daemon to be running.",
  inputSchema: inputSchemaJson,
  zodSchema: scheduleWakeupInputSchema,
  overridesOpenCode: false,
  handler,
};
