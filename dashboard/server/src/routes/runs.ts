import fs from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { createSession } from "better-sse";
import chokidar, { type FSWatcher } from "chokidar";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  ORCHESTRATOR_INBOX,
  RIG_SESSIONS_DIR,
} from "../lib/paths.js";
import {
  loadRigState,
  classifyHeartbeat,
} from "../lib/rig-state.js";
import { getRigProcessInfo } from "./rig-control.js";
import type {
  RigAction,
  RigActionCmd,
  RigProcessInfo,
  RigState,
  RunRecord,
  RunSummary,
} from "../types.js";

/**
 * Factory: returns the /runs route handler mounted on a Hono app.
 *
 * Accepts an override for the orchestrator inbox directory — tests use this
 * to point at a tmpdir so we can assert the written file shape without
 * touching the real `.orchestrator/inbox/`.
 */
export interface RunsRouteOptions {
  /** Override for `.orchestrator/inbox/`. Tests pass a tmpdir here. */
  inboxDir?: string;
  /** Override for `.autobuild/sessions/`. Tests pass a tmpdir. */
  sessionsDir?: string;
  /** Override for the state loader — tests inject a stub. */
  loadState?: () => Promise<RigState>;
  /**
   * Override for the rig process probe. Tests inject a stub so we don't
   * read the real `.orchestrator/dispatcher.pid` during unit runs. When
   * unset we delegate to `getRigProcessInfo()` which reads the default
   * production pid file.
   */
  loadRigProcess?: () => Promise<RigProcessInfo>;
}

const ActionBodySchema = z.object({
  action: z.enum(["abort", "approve", "retry", "reject", "skip"]),
  note: z.string().max(2000).optional(),
});

const RunIdParam = z
  .string()
  .min(1)
  .max(256)
  // Session ids are the rig's choice; keep the filter permissive but block
  // anything that could traverse the sessions dir.
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, {
    message:
      "run id must be alphanumeric with dots / dashes / underscores",
  });

function toRunSummary(id: string, r: RunRecord): RunSummary {
  return { id, ...r };
}

function sortRuns(runs: Record<string, RunRecord>): RunSummary[] {
  return Object.entries(runs)
    .map(([id, r]) => toRunSummary(id, r))
    .sort((a, b) => {
      // Newest first. `updated_at` is always present per the spec — but we
      // defensively fall back to empty-string comparison.
      const aT = a.updated_at ?? "";
      const bT = b.updated_at ?? "";
      if (aT === bT) return 0;
      return aT < bT ? 1 : -1;
    });
}

async function readLastLines(
  absPath: string,
  maxLines: number,
): Promise<string[]> {
  // Caller guarantees the path came from either:
  //   (a) the rig's state.json `log_path` (trusted source), or
  //   (b) `path.join(sessionsDir, <regex-validated session_id>, 'tmux.log')`.
  // Both are structurally safe — we don't apply assertInsideRepo because
  // injected sessionsDirs (from tests) intentionally live outside REPO_ROOT.
  try {
    const raw = await fs.readFile(absPath, "utf8");
    const lines = raw.split("\n");
    // The trailing newline leaves an empty string — drop it.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length <= maxLines) return lines;
    return lines.slice(lines.length - maxLines);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    console.error(`[runs] failed to read ${absPath}:`, err);
    return [];
  }
}

function isoTsSafe(): string {
  // Replace `:` and `.` with `-` so the file is safe on every FS we care about.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function writeActionToInbox(
  inboxDir: string,
  action: RigAction,
): Promise<string> {
  await fs.mkdir(inboxDir, { recursive: true });
  const filename = `${isoTsSafe()}-${action.cmd}.json`;
  const full = path.join(inboxDir, filename);
  // Atomic-ish: write to .tmp then rename. Keeps the rig from reading a
  // half-written file if it's watching the inbox with chokidar.
  const tmp = `${full}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(action, null, 2), "utf8");
  await fs.rename(tmp, full);
  return filename;
}

export function createRunsRoute(opts: RunsRouteOptions = {}): Hono {
  const app = new Hono();
  const inboxDir = opts.inboxDir ?? ORCHESTRATOR_INBOX;
  const sessionsDir = opts.sessionsDir ?? RIG_SESSIONS_DIR;
  const loadState = opts.loadState ?? loadRigState;
  const loadRigProcess =
    opts.loadRigProcess ?? ((): Promise<RigProcessInfo> => getRigProcessInfo());

  // ---------- GET /api/runs ----------
  // Returns the full RigState envelope the frontend expects (useRuns hook).
  // Includes runs as both a keyed record (for O(1) lookup) and a sorted array
  // (for rendering).
  app.get("/runs", async (c) => {
    try {
      const state = await loadState();
      // Rig process lookup is best-effort: a stuck pid file must never
      // prevent /runs from returning. Swallow errors to an offline shape.
      let rigProcess: RigProcessInfo;
      try {
        rigProcess = await loadRigProcess();
      } catch (err) {
        console.error("[GET /api/runs] rig process probe failed:", err);
        rigProcess = {
          running: false,
          pid: null,
          since: null,
          log_path: null,
        };
      }
      const runsRecord = state.runs ?? {};
      const runsArray = sortRuns(runsRecord);
      return c.json({
        // Full RigState fields for useRuns / AutobuildPanel consumption
        rig_version: state.rig_version ?? "0.0.0",
        rig_heartbeat: state.rig_heartbeat ?? null,
        concurrency: state.concurrency ?? 1,
        paused: state.rig_paused ?? false,
        rig_paused: state.rig_paused ?? false,
        halted: state.halted ?? false,
        daily_budget_usd: state.daily_budget_usd ?? { spent: 0, cap: 25, day: new Date().toISOString().slice(0, 10) },
        runs: runsRecord,
        queue: state.queue ?? [],
        completed: state.completed ?? [],
        escalated: state.escalated ?? [],
        // New: live dispatcher process info so the frontend's "rig running"
        // indicator reflects reality instead of heartbeat-guessing.
        rig_process: rigProcess,
        // Legacy/compat fields
        runs_array: runsArray,
        count: runsArray.length,
      });
    } catch (err) {
      console.error("[GET /api/runs] failed:", err);
      return c.json({ error: "failed to load runs" }, 500);
    }
  });

  // ---------- GET /api/runs/:id ----------
  app.get("/runs/:id", async (c) => {
    const idParse = RunIdParam.safeParse(c.req.param("id"));
    if (!idParse.success) {
      return c.json(
        { error: "invalid run id", issues: idParse.error.issues },
        400,
      );
    }
    const runId = idParse.data;

    try {
      const state = await loadState();
      const record = state.runs?.[runId];
      if (!record) return c.json({ error: "run not found" }, 404);
      // tmux.log path: prefer the record's own `log_path` (rig's source of truth),
      // fall back to `<sessionsDir>/<sid>/tmux.log`.
      const tmuxLogPath =
        record.log_path && record.log_path.length > 0
          ? record.log_path
          : path.join(sessionsDir, record.session_id ?? runId, "tmux.log");
      const logTail = await readLastLines(tmuxLogPath, 500);
      return c.json({
        id: runId,
        ...record,
        log: {
          path: tmuxLogPath,
          lines: logTail,
          lineCount: logTail.length,
        },
      });
    } catch (err) {
      console.error(`[GET /api/runs/${runId}] failed:`, err);
      return c.json({ error: "failed to load run" }, 500);
    }
  });

  // ---------- GET /api/runs/:id/events (SSE) ----------
  //
  // Streams the per-run tmux.log as a live tail. Three invariants below were
  // previously broken and caused the middle-pane log in the UI to sit on
  // "CONNECTING... · 0 LINES" forever:
  //
  //   1. Event name must be `log` — `useRunLog` filters on that. Using
  //      `log-line` worked at the transport level but the client dropped
  //      every frame.
  //   2. We must hold the handler open until the socket closes (mirrors the
  //      `/api/events` fix). If we `return c.body(null)` after wiring the
  //      watcher, Hono's node-server adapter calls `writeHead(200)` on the
  //      already-committed response → `ERR_HTTP_HEADERS_SENT` flood.
  //   3. Chokidar watcher + offset tracker must be per-subscriber so two
  //      tabs watching the same run don't race on a shared offset.
  app.get("/runs/:id/events", async (c) => {
    const idParse = RunIdParam.safeParse(c.req.param("id"));
    if (!idParse.success) {
      return c.json(
        { error: "invalid run id", issues: idParse.error.issues },
        400,
      );
    }
    const runId = idParse.data;
    const env = c.env as {
      incoming?: IncomingMessage;
      outgoing?: ServerResponse;
    };
    const req = env.incoming;
    const res = env.outgoing;
    if (!req || !res) {
      return c.json({ error: "SSE requires Node adapter" }, 500);
    }

    // Resolve run id → tmux.log path. Prefer the rig's own `log_path` (source
    // of truth), fall back to `<sessionsDir>/<session_id>/tmux.log`, fall
    // back again to `<sessionsDir>/<runId>/tmux.log` if state is missing.
    let logPath: string;
    try {
      const state = await loadState();
      const rec = state.runs?.[runId];
      if (rec?.log_path && rec.log_path.length > 0) {
        logPath = rec.log_path;
      } else {
        logPath = path.join(sessionsDir, rec?.session_id ?? runId, "tmux.log");
      }
    } catch {
      logPath = path.join(sessionsDir, runId, "tmux.log");
    }

    let watcher: FSWatcher | null = null;
    try {
      const session = await createSession(req, res, {
        retry: 5_000,
        keepAlive: 15_000,
      });

      const RING_CAP = 500;
      let offset = 0; // byte offset into tmux.log already emitted
      let tailBuffer = ""; // partial-line carry-over between reads

      const emit = (line: string, replay: boolean): void => {
        session.push(
          {
            runId,
            line,
            at: new Date().toISOString(),
            ...(replay ? { replay: true } : {}),
          },
          "log",
        );
      };

      const pushLines = (text: string): void => {
        // Stitch to any carry-over from the previous read so we never split a
        // mid-line on an arbitrary chokidar fire.
        const combined = tailBuffer + text;
        const parts = combined.split("\n");
        // The last piece is either "" (text ended on \n) or a partial line —
        // stash it for the next read.
        tailBuffer = parts.pop() ?? "";
        for (const line of parts) emit(line, false);
      };

      // Seed the session with the current tail so late subscribers see
      // context immediately instead of waiting for the next rig write.
      try {
        const initial = await readLastLines(logPath, RING_CAP);
        for (const line of initial) emit(line, true);
        try {
          const stat = await fs.stat(logPath);
          offset = stat.size;
        } catch {
          offset = 0;
        }
      } catch (err) {
        console.error(`[run-events ${runId}] seed failed:`, err);
      }

      // Per-subscriber chokidar. Closed when the socket closes below.
      try {
        watcher = chokidar.watch(logPath, {
          ignoreInitial: true,
          awaitWriteFinish: false,
          persistent: true,
        });
        // If the file doesn't exist yet (worker hasn't spawned), chokidar
        // will fire `add` when it appears; treat that like a change so we
        // start streaming without requiring a reconnect.
        watcher.on("add", async () => {
          try {
            const stat = await fs.stat(logPath);
            if (stat.size <= offset) {
              offset = stat.size;
              return;
            }
            const fh = await fs.open(logPath, "r");
            try {
              const length = stat.size - offset;
              const buf = Buffer.alloc(length);
              await fh.read(buf, 0, length, offset);
              offset = stat.size;
              pushLines(buf.toString("utf8"));
            } finally {
              await fh.close();
            }
          } catch (err) {
            console.error(`[run-events ${runId}] add read failed:`, err);
          }
        });
        watcher.on("change", async () => {
          try {
            const stat = await fs.stat(logPath);
            if (stat.size <= offset) return;
            const fh = await fs.open(logPath, "r");
            try {
              const length = stat.size - offset;
              const buf = Buffer.alloc(length);
              await fh.read(buf, 0, length, offset);
              offset = stat.size;
              pushLines(buf.toString("utf8"));
            } finally {
              await fh.close();
            }
          } catch (err) {
            console.error(`[run-events ${runId}] tail read failed:`, err);
          }
        });
        watcher.on("error", (err) =>
          console.error(`[run-events ${runId}] watcher error:`, err),
        );
      } catch (err) {
        console.error(`[run-events ${runId}] watch setup failed:`, err);
      }

      // Hold the handler open until the socket closes. Mirrors the fix in
      // `/api/events` — without this Hono's node-adapter calls writeHead(200)
      // on a response we've already committed to SSE framing, producing
      // ERR_HTTP_HEADERS_SENT and killing the stream after the first replay.
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        res.once("close", done);
        res.once("finish", done);
        req.once("aborted", done);
        session.on("disconnected", done);
      });
    } catch (err) {
      console.error(`[GET /api/runs/${runId}/events] failed:`, err);
      if (!res.headersSent) res.statusCode = 500;
      if (res.writable && !res.writableEnded) res.end();
    } finally {
      if (watcher) await watcher.close().catch(() => undefined);
    }

    return c.body(null, 200);
  });

  // ---------- POST /api/runs/:id/action ----------
  app.post("/runs/:id/action", async (c) => {
    const idParse = RunIdParam.safeParse(c.req.param("id"));
    if (!idParse.success) {
      return c.json(
        { error: "invalid run id", issues: idParse.error.issues },
        400,
      );
    }
    const runId = idParse.data;

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const parsed = ActionBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "invalid action body", issues: parsed.error.issues },
        400,
      );
    }

    const cmd: RigActionCmd = parsed.data.action;
    const action: RigAction = {
      cmd,
      target: runId,
      ts: new Date().toISOString(),
      by: "dashboard",
    };
    if (parsed.data.note) action.note = parsed.data.note;

    try {
      const filename = await writeActionToInbox(inboxDir, action);
      return c.json({ queued: true, filename }, 202);
    } catch (err) {
      console.error(`[POST /api/runs/${runId}/action] failed:`, err);
      return c.json({ error: "failed to queue action" }, 500);
    }
  });

  // ---------- GET /api/rig/status ----------
  app.get("/rig/status", async (c) => {
    try {
      const state = await loadState();
      const klass = classifyHeartbeat(state.rig_heartbeat ?? null);
      const runCount = Object.keys(state.runs ?? {}).length;
      return c.json({
        rig_heartbeat: state.rig_heartbeat ?? null,
        rig_paused: state.rig_paused ?? false,
        heartbeat_status: klass, // "never" | "fresh" | "amber" | "red"
        run_count: runCount,
        // Pass through any extra rig-level fields the rig decided to write.
        ...Object.fromEntries(
          Object.entries(state).filter(
            ([k]) =>
              k !== "runs" && k !== "rig_heartbeat" && k !== "rig_paused",
          ),
        ),
      });
    } catch (err) {
      console.error("[GET /api/rig/status] failed:", err);
      return c.json({ error: "failed to load rig status" }, 500);
    }
  });

  return app;
}

/** Default instance with production paths. */
export const runRoutes = createRunsRoute();
