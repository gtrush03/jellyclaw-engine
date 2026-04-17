// state.mjs — read + atomically write .autobuild/state.json.
//
// Atomicity: we write to `<path>.tmp.<pid>.<ts>` then rename over the target.
// Concurrency: we take an exclusive lock via open(<path>.lock, 'wx'). If the
// lock is held we poll briefly, then fail-fast with a clear error. The rig is
// single-process in the MVP, so contention only happens when the CLI races the
// daemon for a quick status update.

import {
  openSync,
  closeSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import { stateFile, autobuildDir } from "./lib/paths.mjs";

const RIG_VERSION = "0.1.0";
const LOCK_RETRIES = 50;
const LOCK_DELAY_MS = 20;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

export function defaultState() {
  return {
    rig_version: RIG_VERSION,
    rig_heartbeat: nowIso(),
    concurrency: 1,
    paused: false,
    halted: false,
    daily_budget_usd: { spent: 0, cap: 25, day: today() },
    runs: {},
    queue: [],
    completed: [],
    escalated: [],
  };
}

export function readState(path = stateFile()) {
  if (!existsSync(path)) return defaultState();
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`state.json is corrupt at ${path}: ${err.message}`);
  }
}

function sleepMs(ms) {
  const end = Date.now() + ms;
  // Busy-wait for very short intervals to avoid requiring async plumbing
  // inside synchronous tick callers.
  while (Date.now() < end) {
    /* spin */
  }
}

function acquireLock(path) {
  const lockPath = `${path}.lock`;
  let lastErr = null;
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      const fd = openSync(lockPath, "wx");
      return () => {
        try {
          closeSync(fd);
        } catch {}
        try {
          unlinkSync(lockPath);
        } catch {}
      };
    } catch (err) {
      lastErr = err;
      if (err.code !== "EEXIST") throw err;
      sleepMs(LOCK_DELAY_MS);
    }
  }
  throw new Error(
    `could not acquire lock on ${lockPath} after ${LOCK_RETRIES} tries: ${lastErr?.message || "?"}`,
  );
}

export function writeState(nextState, path = stateFile()) {
  mkdirSync(dirname(path), { recursive: true });
  const release = acquireLock(path);
  try {
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(nextState, null, 2));
    renameSync(tmp, path);
  } finally {
    release();
  }
}

/**
 * Atomic read-modify-write. The mutator receives a deep copy and may mutate
 * it in-place (or return a new object). Returns the written state.
 */
export function updateState(mutator, path = stateFile()) {
  mkdirSync(dirname(path), { recursive: true });
  const release = acquireLock(path);
  try {
    const current = existsSync(path)
      ? JSON.parse(readFileSync(path, "utf8"))
      : defaultState();
    const copy = JSON.parse(JSON.stringify(current));
    const produced = mutator(copy);
    const next = produced || copy;
    const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, path);
    return next;
  } finally {
    release();
  }
}

export function initStateIfMissing(path = stateFile()) {
  mkdirSync(autobuildDir(), { recursive: true });
  if (!existsSync(path)) writeState(defaultState(), path);
  return readState(path);
}

/** Build the initial record for a freshly-queued run. */
export function makeRunRecord(prompt, { sessionId, tmuxSession, branch, logPath, eventsPath }) {
  return {
    status: "queued",
    tier: prompt.tier,
    session_id: sessionId,
    tmux_session: tmuxSession,
    branch,
    started_at: null,
    updated_at: nowIso(),
    ended_at: null,
    attempt: 1,
    max_retries: prompt.max_retries ?? 5,
    turns_used: 0,
    cost_usd: 0,
    self_check: null,
    log_path: logPath,
    events_path: eventsPath,
    tests: { total: 0, passed: 0, failed: 0, pending: 0 },
    commit_sha: null,
    last_error: null,
    last_retry_reason: null,
    needs_review: false,
    retry_history: [],
  };
}

export { nowIso };
