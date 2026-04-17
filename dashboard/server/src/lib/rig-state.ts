import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import {
  RIG_STATE_FILE,
  RIG_SESSIONS_DIR,
  assertInsideRepo,
} from "./paths.js";
import type { RigState, RunRecord } from "../types.js";

/**
 * Rig state library — the dashboard's read-only window into `.autobuild/state.json`.
 *
 * We never write to the rig directory. Every read is defensive:
 *   - missing file → empty state
 *   - partial-write / parse-error → retry once with 100ms delay, then cached last-good
 *   - malformed record → silently dropped (we log and continue)
 *
 * The rig writes state.json atomically (temp-then-rename), so parse errors should be
 * rare. They do happen when a watcher fires between the write syscall and rename
 * on some filesystems; the retry-plus-cache strategy keeps the dashboard stable.
 */

const EMPTY_STATE: RigState = {
  rig_heartbeat: null,
  rig_paused: false,
  runs: {},
};

// Last known-good state. We return this when disk reads fail so downstream
// consumers (routes, SSE diff) can keep going rather than 500'ing.
let cachedState: RigState = EMPTY_STATE;
let cachedAt: number = 0;

function coerceRunRecord(raw: unknown): RunRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Minimal validation — we trust the rig to write a well-formed record. We
  // just check the required discriminator so downstream consumers don't crash
  // on an obviously empty object.
  if (typeof r.status !== "string") return null;
  if (typeof r.session_id !== "string") return null;
  // Everything else is allowed to be wrong — frontend should tolerate nulls.
  return raw as RunRecord;
}

function coerceState(raw: unknown): RigState {
  if (!raw || typeof raw !== "object") return { ...EMPTY_STATE };
  const r = raw as Record<string, unknown>;

  const runsRaw = r.runs;
  const runs: Record<string, RunRecord> = {};
  if (runsRaw && typeof runsRaw === "object" && !Array.isArray(runsRaw)) {
    for (const [id, record] of Object.entries(runsRaw)) {
      const coerced = coerceRunRecord(record);
      if (coerced) runs[id] = coerced;
    }
  }

  const heartbeat =
    typeof r.rig_heartbeat === "string" ? r.rig_heartbeat : null;
  // The rig's README (`.autobuild/README.md`) writes `paused`, but the
  // dashboard brief asked us to surface it as `rig_paused`. Accept either —
  // prefer `rig_paused` if the rig ever adopts that name, fall back to `paused`.
  const paused =
    typeof r.rig_paused === "boolean"
      ? r.rig_paused
      : typeof r.paused === "boolean"
        ? r.paused
        : false;

  // Pass through any extra top-level fields untouched — future-compatible
  // with whatever the rig author bolts on.
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) {
    if (
      k === "runs" ||
      k === "rig_heartbeat" ||
      k === "rig_paused" ||
      k === "paused"
    )
      continue;
    extra[k] = v;
  }

  return {
    rig_heartbeat: heartbeat,
    rig_paused: paused,
    runs,
    ...extra,
  };
}

async function readStateOnce(): Promise<RigState | null> {
  try {
    const raw = await fs.readFile(RIG_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return coerceState(parsed);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Missing file is a valid state — the rig simply hasn't booted yet.
      return { ...EMPTY_STATE };
    }
    // JSON parse errors & transient IO errors — caller will retry.
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Atomic-ish read of `.autobuild/state.json`.
 * Returns:
 *   - the parsed state on success
 *   - the empty state if the file is missing
 *   - the last-good cached state if the read fails twice in a row
 *
 * Never throws.
 */
export async function loadRigState(): Promise<RigState> {
  assertInsideRepo(RIG_STATE_FILE);
  const first = await readStateOnce();
  if (first) {
    cachedState = first;
    cachedAt = Date.now();
    return first;
  }
  // Parse failure → sleep 100ms and retry (rename race with the rig's write).
  await sleep(100);
  const second = await readStateOnce();
  if (second) {
    cachedState = second;
    cachedAt = Date.now();
    return second;
  }
  // Both reads failed — return whatever we had last.
  return cachedState;
}

export function lastLoadedAt(): number {
  return cachedAt;
}

/**
 * Watch `.autobuild/state.json` and every `.autobuild/sessions/<sid>/tmux.log`.
 * Calls `onUpdate` with the *kind* of change so callers can emit different
 * SSE events. Debounced at 100ms to collapse the flurry of writes the rig
 * produces during a status transition.
 *
 * Returns an async close function.
 */
export type RigWatchKind =
  | { kind: "state" }
  | { kind: "log"; runId: string; path: string };

export function watchRigState(
  onUpdate: (ev: RigWatchKind) => void,
): () => Promise<void> {
  const watchers: FSWatcher[] = [];

  // --- state.json ---
  // chokidar tolerates the file not existing at start-up; it picks it up
  // once the rig creates it.
  // `usePolling` — the rig writes state.json via atomic rename (tmp + mv).
  // macOS fsevents frequently drops those as unlink+add, and when the inode
  // changes the watcher can silently detach. Polling every 250ms is
  // negligible overhead and guarantees the UI sees every status transition.
  const stateWatcher = chokidar.watch(RIG_STATE_FILE, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    persistent: true,
    usePolling: true,
    interval: 250,
  });

  let stateDebounce: NodeJS.Timeout | null = null;
  const fireState = (): void => {
    if (stateDebounce) return;
    stateDebounce = setTimeout(() => {
      stateDebounce = null;
      try {
        onUpdate({ kind: "state" });
      } catch (err) {
        console.error("[rig-state] onUpdate threw:", err);
      }
    }, 100);
  };

  stateWatcher.on("add", fireState);
  stateWatcher.on("change", fireState);
  stateWatcher.on("unlink", fireState);
  stateWatcher.on("error", (err) => {
    console.error("[rig-state] state watcher error:", err);
  });
  watchers.push(stateWatcher);

  // --- per-session tmux.log ---
  // Glob matches any session directory the rig creates under
  // `.autobuild/sessions/`. chokidar handles newly-added sessions too.
  const logGlob = path.join(RIG_SESSIONS_DIR, "*", "tmux.log");
  const logWatcher = chokidar.watch(logGlob, {
    ignoreInitial: true,
    awaitWriteFinish: false, // logs grow line-by-line; we want every append
    persistent: true,
  });

  // Debounce *per log file* — 100ms collapse window. Using a Map keeps
  // concurrent runs independent.
  const logDebounces = new Map<string, NodeJS.Timeout>();
  const fireLog = (p: string): void => {
    const existing = logDebounces.get(p);
    if (existing) return;
    const t = setTimeout(() => {
      logDebounces.delete(p);
      // Derive the run id from the path: .../sessions/<sid>/tmux.log
      const runId = path.basename(path.dirname(p));
      try {
        onUpdate({ kind: "log", runId, path: p });
      } catch (err) {
        console.error("[rig-state] onUpdate threw:", err);
      }
    }, 100);
    logDebounces.set(p, t);
  };

  logWatcher.on("add", fireLog);
  logWatcher.on("change", fireLog);
  logWatcher.on("error", (err) => {
    console.error("[rig-state] log watcher error:", err);
  });
  watchers.push(logWatcher);

  return async (): Promise<void> => {
    if (stateDebounce) {
      clearTimeout(stateDebounce);
      stateDebounce = null;
    }
    for (const t of logDebounces.values()) clearTimeout(t);
    logDebounces.clear();
    await Promise.all(watchers.map((w) => w.close()));
  };
}

/**
 * Convenience: shallow diff between two states for SSE payloads.
 * Returns the run ids whose status changed, plus their new statuses.
 */
export function diffRigState(
  prev: RigState,
  next: RigState,
): { changed_run_ids: string[]; new_statuses: Record<string, string> } {
  const changed: string[] = [];
  const newStatuses: Record<string, string> = {};
  const prevRuns = prev.runs ?? {};
  const nextRuns = next.runs ?? {};
  const allIds = new Set([
    ...Object.keys(prevRuns),
    ...Object.keys(nextRuns),
  ]);
  for (const id of allIds) {
    const p = prevRuns[id];
    const n = nextRuns[id];
    if (!p && n) {
      changed.push(id);
      newStatuses[id] = n.status;
      continue;
    }
    if (p && !n) {
      // Run removed — report but no status to put.
      changed.push(id);
      continue;
    }
    if (p && n && p.status !== n.status) {
      changed.push(id);
      newStatuses[id] = n.status;
    }
  }
  return { changed_run_ids: changed, new_statuses: newStatuses };
}

/**
 * Heartbeat staleness classification. `null` if no heartbeat yet.
 * Thresholds: >30s = amber, >300s (5min) = red.
 */
export function classifyHeartbeat(
  hb: string | null,
  now: number = Date.now(),
): "never" | "fresh" | "amber" | "red" {
  if (!hb) return "never";
  const t = Date.parse(hb);
  if (Number.isNaN(t)) return "never";
  const ageSec = (now - t) / 1000;
  if (ageSec > 300) return "red";
  if (ageSec > 30) return "amber";
  return "fresh";
}
