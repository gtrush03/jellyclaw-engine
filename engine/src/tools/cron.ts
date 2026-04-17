/**
 * Cron tools — CronCreate, CronDelete, CronList (T4-02).
 *
 * Manages recurring scheduled jobs. Each cron job executes on a 5-field
 * cron schedule (`m h dom mon dow`) and spawns a new agent turn.
 *
 * Requires the scheduler daemon to be running (`jellyclaw daemon start`).
 */

import * as os from "node:os";
import * as path from "node:path";

import { z } from "zod";

import { nextFireTime, parseCronExpression } from "../daemon/cron-parser.js";
import { IpcClient } from "../daemon/ipc.js";
import type { Job } from "../daemon/store.js";
import type { JsonSchema, Tool, ToolContext } from "./types.js";
import { ToolError } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateJobId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 10);
  return `cron-${ts}-${rand}`;
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

function createClient(): IpcClient {
  return new IpcClient({ socketPath: getSocketPath(), timeoutMs: 5000 });
}

function handleIpcError(err: unknown, operation: string): never {
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes("ENOENT") || message.includes("ECONNREFUSED")) {
    throw new ToolError(
      "daemon_unreachable",
      "Scheduler daemon is not running. Run `jellyclaw daemon start` or install the launchd/systemd unit. See docs/daemon.md.",
      { socketPath: getSocketPath() },
    );
  }

  if (message.includes("not found") || message.includes("not_found")) {
    throw new ToolError("unknown_job", `Job not found`, {});
  }

  throw new ToolError("cron_failed", `${operation} failed: ${message}`, {});
}

// ---------------------------------------------------------------------------
// CronCreate
// ---------------------------------------------------------------------------

export const cronCreateInputSchema = z.object({
  expression: z.string().regex(/^(\S+\s+){4}\S+$/, "Must be a 5-field cron expression"),
  prompt: z.string().min(1).max(8192),
  reason: z.string().min(1).max(512),
});

export type CronCreateInput = z.infer<typeof cronCreateInputSchema>;

export const cronCreateOutputSchema = z.object({
  job_id: z.string(),
  next_fire_at_unix_ms: z.number(),
});

export type CronCreateOutput = z.infer<typeof cronCreateOutputSchema>;

const cronCreateInputSchemaJson: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    expression: {
      type: "string",
      pattern: "^(\\S+\\s+){4}\\S+$",
      description: "5-field cron expression: minute hour day-of-month month day-of-week",
    },
    prompt: {
      type: "string",
      minLength: 1,
      maxLength: 8192,
      description: "The prompt to execute on each cron fire.",
    },
    reason: {
      type: "string",
      minLength: 1,
      maxLength: 512,
      description: "Human-readable reason for this cron job.",
    },
  },
  required: ["expression", "prompt", "reason"],
};

async function cronCreateHandler(
  input: CronCreateInput,
  ctx: ToolContext,
): Promise<CronCreateOutput> {
  const { expression, prompt, reason } = input;

  // Validate cron expression.
  try {
    parseCronExpression(expression);
  } catch (err) {
    throw new ToolError("invalid_expression", `Invalid cron expression: ${expression}`, {
      expression,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const client = createClient();
  const jobId = generateJobId();
  const now = Date.now();

  // Compute next fire time.
  let fireAt: number;
  try {
    fireAt = nextFireTime(expression, now);
  } catch (err) {
    throw new ToolError("invalid_expression", `Cannot compute next fire time: ${expression}`, {
      expression,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const payload = JSON.stringify({
    prompt,
    reason,
    owner_session: ctx.sessionId,
    model_hint: null,
    scheduled_at: now,
    expression,
  });

  try {
    await client.enqueue({
      id: jobId,
      kind: "cron",
      fire_at: fireAt,
      cron_expr: expression,
      payload,
      owner: ctx.sessionId,
    });

    ctx.logger.info({ jobId, expression, fireAt }, "CronCreate: job created");

    return {
      job_id: jobId,
      next_fire_at_unix_ms: fireAt,
    };
  } catch (err) {
    handleIpcError(err, "CronCreate");
  }
}

export const cronCreateTool: Tool<CronCreateInput, CronCreateOutput> = {
  name: "CronCreate",
  description:
    "Create a recurring cron job. The prompt will be executed on the specified schedule (5-field cron: minute hour day-of-month month day-of-week). Requires the scheduler daemon.",
  inputSchema: cronCreateInputSchemaJson,
  zodSchema: cronCreateInputSchema,
  overridesOpenCode: false,
  handler: cronCreateHandler,
};

// ---------------------------------------------------------------------------
// CronDelete
// ---------------------------------------------------------------------------

export const cronDeleteInputSchema = z.object({
  id: z.string().min(1),
});

export type CronDeleteInput = z.infer<typeof cronDeleteInputSchema>;

export const cronDeleteOutputSchema = z.object({
  deleted: z.boolean(),
});

export type CronDeleteOutput = z.infer<typeof cronDeleteOutputSchema>;

const cronDeleteInputSchemaJson: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      minLength: 1,
      description: "The job ID to delete (from CronCreate or CronList).",
    },
  },
  required: ["id"],
};

async function cronDeleteHandler(
  input: CronDeleteInput,
  ctx: ToolContext,
): Promise<CronDeleteOutput> {
  const { id } = input;
  const client = createClient();

  try {
    // First get the job to check ownership.
    const job = await client.get(id);

    if (job.owner !== ctx.sessionId) {
      throw new ToolError("forbidden", "Cannot delete job owned by another session", {
        jobId: id,
        owner: job.owner,
        session: ctx.sessionId,
      });
    }

    const cancelled = await client.cancel(id);

    ctx.logger.info({ jobId: id, cancelled }, "CronDelete: job cancelled");

    return { deleted: cancelled };
  } catch (err) {
    if (err instanceof ToolError) throw err;
    handleIpcError(err, "CronDelete");
  }
}

export const cronDeleteTool: Tool<CronDeleteInput, CronDeleteOutput> = {
  name: "CronDelete",
  description:
    "Delete a cron job by ID. Only jobs owned by the current session can be deleted. Requires the scheduler daemon.",
  inputSchema: cronDeleteInputSchemaJson,
  zodSchema: cronDeleteInputSchema,
  overridesOpenCode: false,
  handler: cronDeleteHandler,
};

// ---------------------------------------------------------------------------
// CronList
// ---------------------------------------------------------------------------

export const cronListInputSchema = z.object({});

export type CronListInput = z.infer<typeof cronListInputSchema>;

export const CronListItemSchema = z.object({
  id: z.string(),
  expression: z.string().nullable(),
  prompt: z.string(),
  reason: z.string(),
  next_fire_at_unix_ms: z.number(),
  fire_count: z.number(),
  last_fired_at_unix_ms: z.number().nullable(),
  status: z.string(),
});

export const cronListOutputSchema = z.array(CronListItemSchema).max(500);

export type CronListItem = z.infer<typeof CronListItemSchema>;
export type CronListOutput = z.infer<typeof cronListOutputSchema>;

const cronListInputSchemaJson: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
  required: [],
};

async function cronListHandler(_input: CronListInput, ctx: ToolContext): Promise<CronListOutput> {
  const client = createClient();

  try {
    // List only pending cron jobs owned by this session.
    const jobs = await client.list({ owner: ctx.sessionId, kind: "cron", status: "pending" });

    const result: CronListItem[] = jobs.map((job: Job) => {
      let parsedPayload: { prompt?: string; reason?: string } = {};
      try {
        parsedPayload = JSON.parse(job.payload);
      } catch {
        // Ignore parse errors.
      }

      return {
        id: job.id,
        expression: job.cron_expr,
        prompt: parsedPayload.prompt ?? "",
        reason: parsedPayload.reason ?? "",
        next_fire_at_unix_ms: job.fire_at,
        fire_count: job.fire_count,
        last_fired_at_unix_ms: job.last_fired_at,
        status: job.status,
      };
    });

    ctx.logger.debug({ count: result.length }, "CronList: returned jobs");

    return result;
  } catch (err) {
    if (err instanceof ToolError) throw err;
    handleIpcError(err, "CronList");
  }
}

export const cronListTool: Tool<CronListInput, CronListOutput> = {
  name: "CronList",
  description:
    "List all cron jobs owned by the current session. Returns job details including ID, expression, next fire time, and fire count. Requires the scheduler daemon.",
  inputSchema: cronListInputSchemaJson,
  zodSchema: cronListInputSchema,
  overridesOpenCode: false,
  handler: cronListHandler,
};
