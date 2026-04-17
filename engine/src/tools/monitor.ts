/**
 * Monitor tools — Monitor / MonitorStop / MonitorList (T4-04).
 *
 * Monitor lets an agent tail a long-running signal (a log file, a build
 * output, a polled endpoint) and receive each emitted line as an event
 * without blocking the agent turn.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import type { JsonSchema, Tool, ToolContext } from "./types.js";
import { ToolError } from "./types.js";

// ---------------------------------------------------------------------------
// Input/Output schemas
// ---------------------------------------------------------------------------

export const monitorInputSchema = z.object({
  kind: z.enum(["tail", "watch", "cmd"]),
  target: z.string().min(1),
  pattern: z.string().optional(),
  max_lines: z.number().int().positive().optional(),
  persistent: z.boolean().optional(),
  notify: z.enum(["agent", "user"]).optional(),
});
export type MonitorInput = z.infer<typeof monitorInputSchema>;

export const monitorOutputSchema = z.object({
  monitor_id: z.string(),
  started_at: z.number().int(),
});
export type MonitorOutput = z.infer<typeof monitorOutputSchema>;

export const monitorStopInputSchema = z.object({
  id: z.string().min(1),
});
export type MonitorStopInput = z.infer<typeof monitorStopInputSchema>;

export const monitorStopOutputSchema = z.object({
  id: z.string(),
  stopped_at: z.number().int(),
  total_events: z.number().int().nonnegative(),
});
export type MonitorStopOutput = z.infer<typeof monitorStopOutputSchema>;

export const monitorListOutputSchema = z.array(
  z.object({
    id: z.string(),
    kind: z.string(),
    target: z.string(),
    status: z.string(),
    events_emitted: z.number().int().nonnegative(),
    started_at: z.number().int(),
  }),
);
export type MonitorListOutput = z.infer<typeof monitorListOutputSchema>;

// ---------------------------------------------------------------------------
// JSON Schema for Claude Code compatibility
// ---------------------------------------------------------------------------

const monitorInputSchemaJson: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: ["tail", "watch", "cmd"],
      description: "Type of monitor: tail (file), watch (directory), cmd (shell command).",
    },
    target: {
      type: "string",
      minLength: 1,
      description:
        "Path for tail/watch kinds; shell command for cmd kind. Must be absolute path for tail/watch.",
    },
    pattern: {
      type: "string",
      description: "Optional regex pattern. Only matching lines/events are emitted.",
    },
    max_lines: {
      type: "integer",
      minimum: 1,
      description: "Optional cutoff. Monitor stops after emitting this many events.",
    },
    persistent: {
      type: "boolean",
      description: "If true, monitor survives daemon restart. Default: false.",
    },
    notify: {
      type: "string",
      enum: ["agent", "user"],
      description:
        "Who receives events: 'agent' (injected into next turn) or 'user' (SSE only). Default: 'agent'.",
    },
  },
  required: ["kind", "target"],
};

const monitorStopInputSchemaJson: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      minLength: 1,
      description: "The monitor ID to stop.",
    },
  },
  required: ["id"],
};

const monitorListInputSchemaJson: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

// ---------------------------------------------------------------------------
// Monitor runtime interface (injected via ToolContext)
// ---------------------------------------------------------------------------

export interface MonitorRuntimeInterface {
  createMonitor(
    input: {
      kind: "tail" | "watch" | "cmd";
      target: string;
      pattern?: string | null | undefined;
      max_lines?: number | null | undefined;
      persistent?: boolean | undefined;
      notify?: "agent" | "user" | undefined;
    },
    sessionId: string,
  ): { monitor_id: string; started_at: number };

  stopMonitor(
    id: string,
    sessionId: string,
  ): Promise<{ id: string; stopped_at: number; total_events: number } | undefined>;

  listMonitors(sessionId: string): Array<{
    id: string;
    kind: string;
    target: string;
    status: string;
    events_emitted: number;
    started_at: number;
  }>;

  ownerCheck(id: string, sessionId: string): "ok" | "not_found" | "forbidden";
}

// Global runtime instance (set by daemon on startup).
let globalRuntime: MonitorRuntimeInterface | null = null;

/** Set the global monitor runtime (called by daemon). */
export function setMonitorRuntime(runtime: MonitorRuntimeInterface): void {
  globalRuntime = runtime;
}

/** Get the global monitor runtime. */
export function getMonitorRuntime(): MonitorRuntimeInterface | null {
  return globalRuntime;
}

/** For testing: reset the global runtime. */
export function _resetMonitorRuntime(runtime?: MonitorRuntimeInterface): void {
  globalRuntime = runtime ?? null;
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/useAwait: Tool handler interface requires Promise return type.
async function monitorHandler(input: MonitorInput, ctx: ToolContext): Promise<MonitorOutput> {
  const runtime = globalRuntime;
  if (!runtime) {
    throw new ToolError(
      "daemon_unavailable",
      "Monitor daemon is not running. Start the daemon with `jellyclaw daemon start`.",
      {},
    );
  }

  // Validate target for tail/watch kinds.
  if (input.kind === "tail" || input.kind === "watch") {
    // Canonicalize path.
    const absolutePath = path.isAbsolute(input.target)
      ? input.target
      : path.resolve(ctx.cwd, input.target);

    // Check existence.
    try {
      const stat = fs.statSync(absolutePath);
      if (input.kind === "tail" && !stat.isFile()) {
        throw new ToolError("invalid_target", `Target must be a file for tail: ${absolutePath}`, {
          target: absolutePath,
        });
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ToolError("target_not_found", `Target does not exist: ${absolutePath}`, {
          target: absolutePath,
        });
      }
      throw err;
    }

    // Use absolute path.
    input = { ...input, target: absolutePath };
  }

  // Validate pattern if provided.
  if (input.pattern) {
    // Reject dangerous patterns.
    if (/\(\?<[!=]/.test(input.pattern) || /\(\?\(/.test(input.pattern)) {
      throw new ToolError(
        "invalid_pattern",
        "Pattern contains unsupported features (lookbehind/recursive)",
        { pattern: input.pattern },
      );
    }

    try {
      new RegExp(input.pattern);
    } catch {
      throw new ToolError("invalid_pattern", `Invalid regex pattern: ${input.pattern}`, {
        pattern: input.pattern,
      });
    }
  }

  const result = runtime.createMonitor(
    {
      kind: input.kind,
      target: input.target,
      pattern: input.pattern ?? null,
      max_lines: input.max_lines ?? null,
      persistent: input.persistent,
      notify: input.notify,
    },
    ctx.sessionId,
  );

  ctx.logger.info(
    { monitorId: result.monitor_id, kind: input.kind, target: input.target },
    "Monitor: created",
  );

  return result;
}

async function monitorStopHandler(
  input: MonitorStopInput,
  ctx: ToolContext,
): Promise<MonitorStopOutput> {
  const runtime = globalRuntime;
  if (!runtime) {
    throw new ToolError(
      "daemon_unavailable",
      "Monitor daemon is not running. Start the daemon with `jellyclaw daemon start`.",
      {},
    );
  }

  // Check ownership.
  const check = runtime.ownerCheck(input.id, ctx.sessionId);
  if (check === "not_found") {
    throw new ToolError("unknown_monitor", `Monitor ${input.id} not found`, { id: input.id });
  }
  if (check === "forbidden") {
    throw new ToolError("forbidden", `Monitor ${input.id} belongs to another session`, {
      id: input.id,
    });
  }

  const result = await runtime.stopMonitor(input.id, ctx.sessionId);
  if (!result) {
    throw new ToolError("unknown_monitor", `Monitor ${input.id} not found`, { id: input.id });
  }

  ctx.logger.info(
    { monitorId: input.id, totalEvents: result.total_events },
    "MonitorStop: stopped",
  );

  return result;
}

// biome-ignore lint/suspicious/useAwait: Tool handler interface requires Promise return type.
async function monitorListHandler(
  _input: Record<string, never>,
  ctx: ToolContext,
): Promise<MonitorListOutput> {
  const runtime = globalRuntime;
  if (!runtime) {
    throw new ToolError(
      "daemon_unavailable",
      "Monitor daemon is not running. Start the daemon with `jellyclaw daemon start`.",
      {},
    );
  }

  return runtime.listMonitors(ctx.sessionId);
}

// ---------------------------------------------------------------------------
// Tool exports
// ---------------------------------------------------------------------------

export const monitorTool: Tool<MonitorInput, MonitorOutput> = {
  name: "Monitor",
  description:
    "Start a background monitor that tails a file, watches a directory, or runs a shell command. Events are streamed to the agent without blocking.",
  inputSchema: monitorInputSchemaJson,
  zodSchema: monitorInputSchema,
  overridesOpenCode: false,
  handler: monitorHandler,
};

export const monitorStopTool: Tool<MonitorStopInput, MonitorStopOutput> = {
  name: "MonitorStop",
  description: "Stop a running monitor and clean up resources.",
  inputSchema: monitorStopInputSchemaJson,
  zodSchema: monitorStopInputSchema,
  overridesOpenCode: false,
  handler: monitorStopHandler,
};

export const monitorListTool: Tool<Record<string, never>, MonitorListOutput> = {
  name: "MonitorList",
  description: "List all monitors for the current session with their status and event counts.",
  inputSchema: monitorListInputSchemaJson,
  zodSchema: z.object({}),
  overridesOpenCode: false,
  handler: monitorListHandler,
};
