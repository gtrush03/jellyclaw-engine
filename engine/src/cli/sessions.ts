/**
 * `jellyclaw sessions` — Phase 09.02 CLI sub-dispatcher.
 *
 * Subcommands:
 *   list     List sessions (default: current project).
 *   search   FTS over message content.
 *   show     Pretty-print a full session (meta + replay + reduce).
 *   rm       Archive a session (moves files to `.trash/`).
 *   reindex  Placeholder (Phase 09.03+).
 *
 * Exit codes:
 *   0 = success
 *   1 = user error (session not found, bad args)
 *   2 = unknown subcommand
 *
 * Engine code must not call `process.exit`; this module returns numeric
 * exit codes and lets `cli.ts` exit.
 */

import { mkdir, readdir, rename, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Db } from "../session/db.js";
import { openDb } from "../session/db.js";
import { searchMessages } from "../session/fts.js";
import { readSessionMeta } from "../session/meta.js";
import { projectHash as computeProjectHash, SessionPaths } from "../session/paths.js";
import { reduceEvents } from "../session/reduce.js";
import { replayJsonl } from "../session/replay.js";
import {
  type ReplayedMessage,
  type ReplayedToolCall,
  type SessionListRow,
  SessionNotFoundError,
} from "../session/types.js";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface ParsedArgs {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string>>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = "true";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const UTC_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatUtc(ms: number): string {
  // Intl parts so the output is stable: "YYYY-MM-DD HH:MM:SS".
  const parts = UTC_FMT.formatToParts(new Date(ms));
  const pick = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

function write(s: string): void {
  process.stdout.write(s);
}

function writeErr(s: string): void {
  process.stderr.write(s);
}

function renderSnippet(snippet: string): string {
  // FTS returns content with `<b>...</b>` markers.
  const isTty = Boolean(process.stdout.isTTY);
  if (isTty) {
    return snippet.replace(/<b>/g, "\x1b[1m").replace(/<\/b>/g, "\x1b[0m");
  }
  return snippet.replace(/<b>/g, "").replace(/<\/b>/g, "");
}

// ---------------------------------------------------------------------------
// Paths / DB plumbing
// ---------------------------------------------------------------------------

function resolvePaths(): SessionPaths {
  return new SessionPaths();
}

async function withDb<T>(fn: (db: Db, paths: SessionPaths) => T | Promise<T>): Promise<T> {
  const paths = resolvePaths();
  const db = await openDb({ paths });
  try {
    return await fn(db, paths);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

interface SessionRowRaw {
  id: string;
  project_hash: string;
  cwd: string;
  model: string | null;
  status: string;
  created_at: number;
  last_turn_at: number;
  summary: string | null;
}

function queryList(
  db: Db,
  opts: { projectHash: string | null; all: boolean; limit: number },
): SessionListRow[] {
  const clauses: string[] = [];
  const bindings: (string | number)[] = [];

  if (!opts.all) {
    clauses.push("status != 'archived'");
  }
  if (opts.projectHash !== null) {
    clauses.push("project_hash = ?");
    bindings.push(opts.projectHash);
  }
  bindings.push(opts.limit);

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `
    SELECT id, project_hash, cwd, model, status, created_at, last_turn_at, summary
      FROM sessions
      ${where}
     ORDER BY last_turn_at DESC
     LIMIT ?
  `;
  const rows = db.raw.prepare(sql).all(...bindings) as SessionRowRaw[];
  return rows.map((r) => ({
    id: r.id,
    projectHash: r.project_hash,
    cwd: r.cwd,
    model: r.model,
    status: r.status as "active" | "ended" | "archived",
    createdAt: r.created_at,
    lastTurnAt: r.last_turn_at,
    summary: r.summary,
  }));
}

export function listCommand(argv: readonly string[]): Promise<number> {
  const { flags } = parseArgs(argv);
  const all = flags.all === "true";
  const limit = Math.max(1, Math.min(Number.parseInt(flags.limit ?? "20", 10) || 20, 500));

  let projectFilter: string | null;
  if (all) {
    projectFilter = null;
  } else if (flags.project !== undefined && flags.project !== "true") {
    projectFilter = flags.project;
  } else {
    // Default: filter by current-project hash. This matches Claude Code's
    // "show me this project's sessions" default.
    projectFilter = computeProjectHash(process.cwd());
  }

  return withDb((db) => {
    const rows = queryList(db, { projectHash: projectFilter, all, limit });

    const header = `${pad("ID", 14)}${pad("UPDATED", 21)}${pad("MODEL", 15)}${pad("STATUS", 9)}SUMMARY\n`;
    write(header);

    if (rows.length === 0) {
      write('(no sessions — run `jellyclaw run "<wish>"` or use --all to see archived sessions)\n');
      return 0;
    }

    for (const row of rows) {
      const id = truncate(row.id, 13);
      const updated = formatUtc(row.lastTurnAt);
      const model = truncate(row.model ?? "-", 14);
      const status = pad(row.status, 9);
      const summary = truncate(row.summary ?? "", 60);
      write(`${pad(id, 14)}${pad(updated, 21)}${pad(model, 15)}${status}${summary}\n`);
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export function searchCommand(argv: readonly string[]): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const query = positional.join(" ").trim();
  if (query.length === 0) {
    writeErr("jellyclaw sessions search: missing <query>\n");
    return Promise.resolve(2);
  }
  const limit = Math.max(1, Math.min(Number.parseInt(flags.limit ?? "20", 10) || 20, 100));

  return withDb((db) => {
    const hits = searchMessages(db, { query, limit });
    if (hits.length === 0) {
      write("(no matches)\n");
      return 0;
    }
    for (const hit of hits) {
      const snippet = renderSnippet(hit.snippet).replace(/\s+/g, " ").trim();
      write(`${pad(truncate(hit.sessionId, 13), 14)}${pad(hit.role, 11)}${snippet}\n`);
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

function lookupProjectHash(db: Db, sessionId: string): string | null {
  const row = db.raw.prepare("SELECT project_hash FROM sessions WHERE id = ?").get(sessionId) as
    | { project_hash: string }
    | undefined;
  return row?.project_hash ?? null;
}

function formatToolCall(call: ReplayedToolCall): string {
  let inputPreview: string;
  try {
    inputPreview = JSON.stringify(call.input);
  } catch {
    inputPreview = "<unserializable>";
  }
  inputPreview = truncate(inputPreview, 80);

  let resultPreview: string;
  if (call.error !== null) {
    resultPreview = `ERROR ${call.error.code}: ${call.error.message}`;
  } else if (call.result === null) {
    resultPreview = "(no result — interrupted)";
  } else {
    try {
      resultPreview = truncate(JSON.stringify(call.result), 80);
    } catch {
      resultPreview = "<unserializable>";
    }
  }

  const dur = call.durationMs === null ? "?" : `${call.durationMs}ms`;
  return `tool ${call.toolName}(${inputPreview}) -> ${resultPreview} (${dur})`;
}

function formatMessage(msg: ReplayedMessage): string {
  return `[${msg.role}] ${msg.content}\n`;
}

export function showCommand(argv: readonly string[]): Promise<number> {
  const { positional } = parseArgs(argv);
  const sessionId = positional[0];
  if (sessionId === undefined || sessionId.length === 0) {
    writeErr("jellyclaw sessions show: missing <id>\n");
    return Promise.resolve(2);
  }

  return withDb(async (db, paths) => {
    const projectHash = lookupProjectHash(db, sessionId);
    if (projectHash === null) {
      writeErr(`${new SessionNotFoundError(sessionId).message}\n`);
      return 1;
    }

    const meta = await readSessionMeta(paths, projectHash, sessionId);
    const logPath = paths.sessionLog(projectHash, sessionId);

    let exists = true;
    try {
      await stat(logPath);
    } catch {
      exists = false;
    }
    if (!exists && meta === null) {
      writeErr(`${new SessionNotFoundError(sessionId).message}\n`);
      return 1;
    }

    const replay = exists
      ? await replayJsonl(logPath)
      : { events: [], truncatedTail: false, linesRead: 0, bytesRead: 0 };
    const state = reduceEvents(replay.events, { truncatedTail: replay.truncatedTail });

    // Header
    write(`session ${sessionId}\n`);
    write(`  project   ${projectHash}\n`);
    write(`  cwd       ${meta?.cwd ?? state.cwd ?? "-"}\n`);
    write(`  model     ${meta?.model ?? state.model ?? "-"}\n`);
    write(`  status    ${meta?.status ?? (state.ended ? "ended" : "active")}\n`);
    if (meta?.createdAt !== undefined) {
      write(`  created   ${formatUtc(meta.createdAt)}\n`);
    }
    if (meta?.lastTurnAt !== undefined) {
      write(`  lastTurn  ${formatUtc(meta.lastTurnAt)}\n`);
    }
    write("\n");

    // Messages
    if (state.messages.length > 0) {
      write("messages:\n");
      for (const m of state.messages) {
        write(formatMessage(m));
        write("\n");
      }
    }

    // Tool calls
    if (state.toolCalls.length > 0) {
      write("tool calls:\n");
      for (const call of state.toolCalls) {
        write(`  ${formatToolCall(call)}\n`);
      }
      write("\n");
    }

    // Usage summary
    write("usage:\n");
    write(`  input  ${state.usage.inputTokens} tokens\n`);
    write(`  output ${state.usage.outputTokens} tokens\n`);
    write(`  cache  ${state.usage.cacheReadTokens} read / ${state.usage.cacheWriteTokens} write\n`);
    write(`  cost   $${(state.usage.costUsdCents / 100).toFixed(4)}\n`);

    return 0;
  });
}

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

async function moveToTrash(
  paths: SessionPaths,
  projectHash: string,
  sessionId: string,
): Promise<number> {
  const sourceDir = paths.projectDir(projectHash);
  const trashDir = join(paths.sessionsRoot(), ".trash", projectHash, sessionId);
  await mkdir(trashDir, { recursive: true });

  let entries: string[];
  try {
    entries = await readdir(sourceDir);
  } catch {
    return 0;
  }

  let moved = 0;
  for (const entry of entries) {
    // Match `<id>.jsonl`, `<id>.jsonl.N`, `<id>.jsonl.N.gz`, `<id>.meta.json`.
    if (
      entry === `${sessionId}.jsonl` ||
      entry === `${sessionId}.meta.json` ||
      entry.startsWith(`${sessionId}.jsonl.`)
    ) {
      const from = join(sourceDir, entry);
      const to = join(trashDir, entry);
      await mkdir(dirname(to), { recursive: true });
      await rename(from, to);
      moved++;
    }
  }
  return moved;
}

export function rmCommand(argv: readonly string[]): Promise<number> {
  const { positional } = parseArgs(argv);
  const sessionId = positional[0];
  if (sessionId === undefined || sessionId.length === 0) {
    writeErr("jellyclaw sessions rm: missing <id>\n");
    return Promise.resolve(2);
  }

  return withDb(async (db, paths) => {
    const projectHash = lookupProjectHash(db, sessionId);
    if (projectHash === null) {
      writeErr(`${new SessionNotFoundError(sessionId).message}\n`);
      return 1;
    }

    const moved = await moveToTrash(paths, projectHash, sessionId);
    db.raw.prepare("UPDATE sessions SET status = 'archived' WHERE id = ?").run(sessionId);

    write(`archived session ${sessionId} (moved ${moved} file(s) to .trash/)\n`);
    return 0;
  });
}

// ---------------------------------------------------------------------------
// reindex (stub)
// ---------------------------------------------------------------------------

export function reindexCommand(_argv: readonly string[]): Promise<number> {
  write("reindex: not yet implemented (planned for Phase 09.03 or later)\n");
  return Promise.resolve(0);
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

const SUB_USAGE = `jellyclaw sessions <subcommand>

SUBCOMMANDS
  list [--project <h>|--all] [--limit N]   List sessions (default: current project)
  search "<query>" [--limit N]             FTS across message content
  show <id>                                Pretty-print a session (meta + replay)
  rm <id>                                  Archive a session (move files to .trash/)
  reindex                                  (stub) rebuild SQLite from JSONL
`;

export function sessionsCommand(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    write(SUB_USAGE);
    return Promise.resolve(0);
  }

  switch (sub) {
    case "list":
      return listCommand(rest);
    case "search":
      return searchCommand(rest);
    case "show":
      return showCommand(rest);
    case "rm":
      return rmCommand(rest);
    case "reindex":
      return reindexCommand(rest);
    default:
      writeErr(`unknown sessions subcommand: ${sub}\n\n${SUB_USAGE}`);
      return Promise.resolve(2);
  }
}
