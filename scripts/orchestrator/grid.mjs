// grid.mjs — live-updating TUI table for the jc-orchestrator tmux session.
//
// Reads .autobuild/state.json every 2 seconds and redraws. No blessed, no
// ncurses — just clear-screen + ANSI. Handles SIGWINCH to recompute column
// widths, handles absent state.json gracefully, truncates tail to terminal
// width.
//
// Export `render(state, { columns })` for tests — it returns the string that
// would be written to stdout.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = resolve(HERE, "..", "..");

function repoRoot() {
  return process.env.AUTOBUILD_ROOT
    ? resolve(process.env.AUTOBUILD_ROOT)
    : DEFAULT_REPO_ROOT;
}
function stateFile() {
  return join(repoRoot(), ".autobuild", "state.json");
}

const useColor =
  process.stdout.isTTY && process.env.NO_COLOR == null && !process.env.JC_NO_COLOR;
const C = {
  reset: useColor ? "\x1b[0m" : "",
  bold: useColor ? "\x1b[1m" : "",
  dim: useColor ? "\x1b[2m" : "",
  gold: useColor ? "\x1b[38;5;179m" : "",
  green: useColor ? "\x1b[32m" : "",
  amber: useColor ? "\x1b[33m" : "",
  red: useColor ? "\x1b[31m" : "",
  grey: useColor ? "\x1b[38;5;244m" : "",
  cyan: useColor ? "\x1b[36m" : "",
};
const paint = (color, s) => `${C[color] || ""}${s}${C.reset}`;

function ago(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 0) return "—";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function humanDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}m ${String(rs).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${String(rm).padStart(2, "0")}m`;
}

function runtimeSeconds(run) {
  if (!run?.started_at) return null;
  const start = Date.parse(run.started_at);
  if (!Number.isFinite(start)) return null;
  const end = run.ended_at ? Date.parse(run.ended_at) : Date.now();
  return Math.max(0, Math.floor((end - start) / 1000));
}

function stateColor(s) {
  if (s === "running" || s === "healthy") return "green";
  if (s === "testing" || s === "starting") return "cyan";
  if (s === "stalled" || s === "needs_review") return "amber";
  if (s === "escalated" || s === "crashed" || s === "failed") return "red";
  if (s === "queued" || s === "done" || s === "passed" || s === "completed")
    return "grey";
  return "grey";
}

function readState() {
  const p = stateFile();
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { _corrupt: true };
  }
}

function truncate(s, w) {
  const str = String(s);
  if (str.length <= w) return str;
  if (w <= 1) return str.slice(0, w);
  return str.slice(0, w - 1) + "…";
}

/**
 * Render the grid to a string.
 * @param {object|null} state  state.json contents, or null.
 * @param {{ columns?: number, showHint?: boolean }} opts
 */
export function render(state, opts = {}) {
  const cols = Math.max(60, opts.columns ?? process.stdout.columns ?? 120);
  const out = [];

  if (state == null) {
    out.push(paint("amber", "rig not running"));
    out.push(
      paint(
        "dim",
        "  no state.json — run `scripts/autobuild/bin/autobuild run`",
      ),
    );
    return out.join("\n") + "\n";
  }
  if (state._corrupt) {
    out.push(paint("red", "state.json is corrupt — cannot render"));
    return out.join("\n") + "\n";
  }

  // Header
  const runs = state.runs || {};
  const running = Object.values(runs).filter((r) =>
    ["running", "testing", "starting", "healthy"].includes(r?.status),
  ).length;
  const q = Array.isArray(state.queue) ? state.queue.length : 0;
  const cap = state.concurrency ?? 1;
  const spent = state.daily_budget_usd?.spent ?? 0;
  const budgetCap = state.daily_budget_usd?.cap ?? 25;
  const hb = ago(state.rig_heartbeat);
  const statusLabel = state.halted ? "HALT" : state.paused ? "PAUSED" : "OK";
  const statusColor = state.halted ? "red" : state.paused ? "amber" : "green";

  out.push(
    ` ${paint("gold", "jc-rig")} ${paint("dim", `v${state.rig_version || "?"}`)} | q=${q} run=${running}/${cap} | today=$${spent.toFixed(2)}/${budgetCap} | heartbeat=${hb} | ${paint(statusColor, statusLabel)}`,
  );
  out.push(" " + paint("dim", "─".repeat(Math.max(10, cols - 2))));

  // Column widths tuned for a typical 120-col terminal; we recompute the
  // trailing TAIL column based on remaining width.
  const fixed = [
    { key: "id", label: "ID", w: 26 },
    { key: "tier", label: "TIER", w: 4 },
    { key: "state", label: "STATE", w: 12 },
    { key: "runtime", label: "RUNTIME", w: 9 },
    { key: "att", label: "ATT/MAX", w: 8 },
    { key: "tests", label: "TESTS", w: 7 },
    { key: "last", label: "LAST-OUTPUT", w: 13 },
  ];
  const fixedSum = fixed.reduce((a, c) => a + c.w + 2, 0);
  const tailW = Math.max(8, cols - 1 - fixedSum - 2);

  // Header row
  const header =
    " " +
    fixed.map((c) => c.label.padEnd(c.w)).join("  ") +
    "  " +
    "TAIL".padEnd(tailW);
  out.push(paint("dim", header));

  // Sort: running first (by started_at asc), then queued, then escalated, then done
  const order = { running: 0, testing: 0, healthy: 0, starting: 1, stalled: 2, escalated: 3, needs_review: 3, queued: 4, done: 5, completed: 5, passed: 5, failed: 5, crashed: 6 };
  const ids = Object.keys(runs).sort((a, b) => {
    const ra = runs[a];
    const rb = runs[b];
    const oa = order[ra?.status] ?? 9;
    const ob = order[rb?.status] ?? 9;
    if (oa !== ob) return oa - ob;
    return String(a).localeCompare(String(b));
  });

  if (ids.length === 0) {
    out.push(" " + paint("dim", "(no runs — queue is cold)"));
    return out.join("\n") + "\n";
  }

  for (const id of ids) {
    const r = runs[id];
    const s = r?.status || "unknown";
    const color = stateColor(s);
    const rt = humanDuration(runtimeSeconds(r));
    const att = `${r.attempt ?? 0}/${r.max_retries ?? 0}`;
    const t = r.tests || { total: 0, passed: 0, failed: 0 };
    const tests = t.total ? `${t.passed}/${t.total}` : "—";
    const last = ago(r.updated_at);
    const tail = r.last_output || r.last_error || r.last_retry_reason || "—";
    const row =
      " " +
      truncate(id, fixed[0].w).padEnd(fixed[0].w) +
      "  " +
      String(r.tier ?? "?").padEnd(fixed[1].w) +
      "  " +
      paint(color, truncate(s, fixed[2].w).padEnd(fixed[2].w)) +
      "  " +
      rt.padEnd(fixed[3].w) +
      "  " +
      att.padEnd(fixed[4].w) +
      "  " +
      tests.padEnd(fixed[5].w) +
      "  " +
      last.padEnd(fixed[6].w) +
      "  " +
      truncate(tail, tailW);
    out.push(row);
  }

  // Trailing hint
  if (opts.showHint !== false) {
    out.push("");
    out.push(
      " " +
        paint(
          "dim",
          "keys: prefix-G grid · prefix-L logs · prefix-R repl · prefix-P pause · Ctrl-C detach",
        ),
    );
  }

  return out.join("\n") + "\n";
}

function clear() {
  // Cursor home + clear display
  process.stdout.write("\x1b[H\x1b[2J");
}

function tick() {
  const state = readState();
  clear();
  process.stdout.write(render(state, { columns: process.stdout.columns }));
}

function main() {
  // Hide cursor while we own the TTY, restore on exit.
  if (process.stdout.isTTY) process.stdout.write("\x1b[?25l");
  const onExit = () => {
    if (process.stdout.isTTY) process.stdout.write("\x1b[?25h\n");
  };
  process.on("SIGINT", () => {
    onExit();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    onExit();
    process.exit(0);
  });
  process.on("exit", onExit);

  tick();
  const iv = setInterval(tick, 2000);
  // Redraw promptly on resize.
  process.stdout.on("resize", tick);
  // Don't keep the process alive if stdin closes (e.g. tmux pane killed).
  process.stdin.on("close", () => {
    clearInterval(iv);
    onExit();
    process.exit(0);
  });
}

// Only run the loop when invoked as a script (not when imported by tests).
const isMainModule =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/grid.mjs");
if (isMainModule) main();
