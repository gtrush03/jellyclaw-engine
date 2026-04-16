/**
 * Slash-command registry.
 *
 * Each entry is a pure descriptor + async handler. Handlers receive a
 * `CommandContext` (see `./dispatch.ts`) and mutate state only via the
 * provided callbacks (`pushSystem`, `dispatchAction`, `dispatchEvent`,
 * `exit`). They must NOT call React, Ink, or the reducer directly.
 */

import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { CommandContext, ParsedCommand } from "./dispatch.js";

export interface CommandDefinition {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly usage?: string;
  readonly handler: (cmd: ParsedCommand, ctx: CommandContext) => Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleHelp(_cmd: ParsedCommand, ctx: CommandContext): void {
  const lines: string[] = ["Available commands:"];
  for (const c of COMMANDS) {
    const usage = c.usage !== undefined ? ` ${c.usage}` : "";
    lines.push(`  /${c.name}${usage}  —  ${c.description}`);
  }
  ctx.pushSystem(lines.join("\n"));
}

function handleModel(cmd: ParsedCommand, ctx: CommandContext): void {
  const requested = cmd.argString.trim();
  if (requested.length === 0) {
    const shown = ctx.currentModel.length > 0 ? ctx.currentModel : "(server default)";
    ctx.pushSystem(`current model: ${shown}`);
    return;
  }
  ctx.dispatchAction({ kind: "set-model", model: requested });
  ctx.pushSystem(`model switched to ${requested} for subsequent runs`);
}

function handleClear(_cmd: ParsedCommand, ctx: CommandContext): void {
  ctx.dispatchAction({ kind: "clear-transcript" });
}

function handleNew(_cmd: ParsedCommand, ctx: CommandContext): void {
  ctx.dispatchAction({ kind: "new-session" });
  ctx.pushSystem("started a fresh session");
}

async function handleSessions(_cmd: ParsedCommand, ctx: CommandContext): Promise<void> {
  const root = join(homedir(), ".jellyclaw", "sessions");
  let projectDirs: string[];
  try {
    projectDirs = await readdir(root);
  } catch {
    ctx.pushSystem("no sessions found (no ~/.jellyclaw/sessions/ directory)");
    return;
  }

  interface Row {
    readonly id: string;
    readonly mtime: number;
  }
  const rows: Row[] = [];

  for (const project of projectDirs) {
    if (project.startsWith(".")) continue;
    const projectDir = join(root, project);
    let entries: string[];
    try {
      entries = await readdir(projectDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const full = join(projectDir, entry);
      try {
        const s = await stat(full);
        rows.push({ id: entry.replace(/\.jsonl$/, ""), mtime: s.mtimeMs });
      } catch {
        /* skip */
      }
    }
  }

  if (rows.length === 0) {
    ctx.pushSystem("no prior sessions found");
    return;
  }

  rows.sort((a, b) => b.mtime - a.mtime);
  const top = rows.slice(0, 25);
  const lines = ["prior sessions (most recent first):"];
  for (const r of top) {
    const when = new Date(r.mtime).toISOString().slice(0, 19).replace("T", " ");
    lines.push(`  ${r.id}  (${when} UTC)`);
  }
  lines.push("", `resume with: /resume <id>`);
  ctx.pushSystem(lines.join("\n"));
}

async function handleResume(cmd: ParsedCommand, ctx: CommandContext): Promise<void> {
  const id = cmd.args[0];
  if (id === undefined || id.length === 0) {
    ctx.pushSystem("usage: /resume <session-id>");
    return;
  }
  ctx.pushSystem(`resuming session ${id}…`);
  try {
    for await (const ev of ctx.client.resumeSession(id)) {
      ctx.dispatchEvent(ev);
    }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    ctx.pushSystem(`/resume failed: ${m}`);
  }
}

function handleCwd(_cmd: ParsedCommand, ctx: CommandContext): void {
  ctx.pushSystem(`cwd: ${ctx.cwd}`);
}

function handleKey(_cmd: ParsedCommand, ctx: CommandContext): void {
  // The API-key rotation flow lives in `engine/src/cli/credentials-prompt.ts`
  // and drives raw stdio — we can't run it while Ink owns the terminal. Exit
  // with a hint so the user can run `jellyclaw key` and come back.
  ctx.pushSystem(
    "API-key rotation requires a non-TUI terminal — exiting.\n" +
      "Run `jellyclaw key` to rotate, then start the TUI again.",
  );
  ctx.exit(0);
}

function handleEnd(_cmd: ParsedCommand, ctx: CommandContext): void {
  ctx.pushSystem("goodbye");
  ctx.exit(0);
}

function handleCost(_cmd: ParsedCommand, ctx: CommandContext): void {
  const u = ctx.usage;
  const total = u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
  const lines = [
    "session usage:",
    `  input    ${u.inputTokens} tokens`,
    `  output   ${u.outputTokens} tokens`,
    `  cache    ${u.cacheReadTokens} read / ${u.cacheWriteTokens} write`,
    `  total    ${total} tokens`,
    `  cost     $${u.costUsd.toFixed(4)}`,
  ];
  ctx.pushSystem(lines.join("\n"));
}

async function handleCancel(_cmd: ParsedCommand, ctx: CommandContext): Promise<void> {
  if (ctx.runId === null) {
    ctx.pushSystem("no active run to cancel");
    return;
  }
  const runId = ctx.runId;
  try {
    await ctx.client.cancel(runId);
    ctx.dispatchAction({ kind: "run-cancelled" });
    ctx.pushSystem(`cancelled run ${runId}`);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    ctx.pushSystem(`/cancel failed: ${m}`);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const COMMANDS: readonly CommandDefinition[] = [
  { name: "help", description: "list available commands", handler: handleHelp },
  {
    name: "model",
    description: "switch model for subsequent runs (no arg = show current)",
    usage: "[name]",
    handler: handleModel,
  },
  { name: "clear", description: "clear the transcript (keep session)", handler: handleClear },
  { name: "new", description: "start a fresh session", handler: handleNew },
  { name: "sessions", description: "list prior sessions", handler: handleSessions },
  {
    name: "resume",
    description: "resume a prior session by id",
    usage: "<id>",
    handler: handleResume,
  },
  { name: "cwd", description: "print the current working directory", handler: handleCwd },
  { name: "key", description: "rotate API key (exits TUI)", handler: handleKey },
  {
    name: "end",
    aliases: ["exit", "quit"],
    description: "exit the TUI",
    handler: handleEnd,
  },
  { name: "cost", description: "show session usage + cost", handler: handleCost },
  { name: "cancel", description: "cancel the active run (if any)", handler: handleCancel },
];
