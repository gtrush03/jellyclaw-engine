/**
 * Bash tool — parity with Claude Code's `Bash`.
 *
 * Executes shell commands with pre-exec blocklist, env scrubbing, output
 * truncation, and optional detached background mode.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import bashSchema from "../../../test/fixtures/tools/claude-code-schemas/bash.json" with {
  type: "json",
};

import {
  BlockedCommandError,
  type JsonSchema,
  PermissionDeniedError,
  TimeoutError,
  type Tool,
  type ToolContext,
  ToolError,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;

export const bashInputSchema = z.object({
  command: z.string().min(1, "command must be non-empty"),
  description: z.string().optional(),
  timeout: z.number().int().positive().max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
  run_in_background: z.boolean().optional(),
});

export type BashInput = z.input<typeof bashInputSchema>;

export type BashOutput =
  | { kind: "foreground"; stdout: string; stderr: string; exit_code: number }
  | { kind: "background"; pid: number; tail_url: string };

interface BlockedPattern {
  readonly name: string;
  readonly regex: RegExp;
}

const BLOCKED_PATTERNS: readonly BlockedPattern[] = [
  {
    name: "rm -rf /",
    regex:
      /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+(?:-[a-zA-Z]+\s+)*(?:\/(?:\s|$|\*|['"`])|~\/?|\$HOME\b)/,
  },
  { name: "curl | sh", regex: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash)\b/ },
  { name: "fork bomb", regex: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  { name: "dd raw disk", regex: /\bdd\b[^\n]*\bif=[^\s]+[^\n]*\bof=\/dev\/sd[a-z]/ },
];

const ENV_WHITELIST: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "SHELL",
  "PWD",
];

function scrubEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ENV_WHITELIST) {
    const v = process.env[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const dropped = s.length - MAX_OUTPUT_CHARS;
  return `${s.slice(0, MAX_OUTPUT_CHARS)}\n[truncated ${dropped} chars]`;
}

function checkBlocked(command: string): void {
  for (const p of BLOCKED_PATTERNS) {
    if (p.regex.test(command)) {
      throw new BlockedCommandError(p.name, command);
    }
  }
}

function containsCdEscape(command: string): boolean {
  return /(^|[\s;&|])cd\s+\.\.(\/|\s|$|;|&|\|)/.test(command);
}

function runForeground(command: string, timeoutMs: number, ctx: ToolContext): Promise<BashOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: "/bin/bash",
      cwd: ctx.cwd,
      signal: ctx.abort,
      timeout: timeoutMs,
      env: scrubEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      const e = err as NodeJS.ErrnoException;
      if (e.name === "AbortError") {
        reject(new ToolError("Aborted", "Command aborted", { command }));
        return;
      }
      reject(new ToolError("SpawnFailed", e.message, { command }));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new TimeoutError(timeoutMs, command));
        return;
      }
      if (ctx.abort.aborted || signal === "SIGTERM") {
        reject(new ToolError("Aborted", "Command aborted", { command, signal }));
        return;
      }
      resolve({
        kind: "foreground",
        stdout: truncate(stdout),
        stderr: truncate(stderr),
        exit_code: code ?? 0,
      });
    });
  });
}

function runBackground(command: string, ctx: ToolContext): BashOutput {
  const logDir = join(homedir(), ".jellyclaw", "bash-bg");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  const tmpLog = join(logDir, `pending-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const fd = openSync(tmpLog, "a");

  const child = spawn(command, {
    shell: "/bin/bash",
    cwd: ctx.cwd,
    env: scrubEnv(),
    detached: true,
    stdio: ["ignore", fd, fd],
  });

  const pid = child.pid;
  if (typeof pid !== "number") {
    throw new ToolError("SpawnFailed", "Background process has no pid", { command });
  }
  const finalLog = join(logDir, `${pid}.log`);
  try {
    renameSync(tmpLog, finalLog);
  } catch {
    // Fallback: use temp path.
  }
  child.unref();

  const path = existsSync(finalLog) ? finalLog : tmpLog;
  return { kind: "background", pid, tail_url: `file://${path}` };
}

export const bashTool: Tool<BashInput, BashOutput> = {
  name: "Bash",
  description:
    "Execute a shell command via /bin/bash with a scrubbed environment, output truncation, and a blocklist for destructive patterns. Supports optional detached background mode.",
  inputSchema: bashSchema as JsonSchema,
  zodSchema: bashInputSchema as unknown as z.ZodType<BashInput>,
  overridesOpenCode: true,
  // biome-ignore lint/suspicious/useAwait: Tool.handler contract is async; body delegates to runForeground which is itself async.
  async handler(input, ctx) {
    const parsed = bashInputSchema.parse(input);
    const command = parsed.command;

    checkBlocked(command);

    if (containsCdEscape(command) && !ctx.permissions.isAllowed("bash")) {
      throw new PermissionDeniedError("bash", "cd .. escape requires bash:allow");
    }

    if (parsed.run_in_background) {
      return runBackground(command, ctx);
    }

    return runForeground(command, parsed.timeout, ctx);
  },
};
