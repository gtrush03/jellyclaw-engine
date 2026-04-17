// dispatcher.mjs — main daemon loop.
//
// Every 2s:
//   1. heartbeat → update state.rig_heartbeat
//   2. process inbox commands (pause / resume / halt / abort / approve / skip / rerun)
//   3. if paused / halted / daily budget exceeded → skip
//   4. if any run is non-terminal (working, testing) → wait (MVP = 1 at a time)
//   5. pick next queued prompt respecting tier ordering
//   6. spawn worker (git-warden cuts branch; tmux session created; claude -p)
//   7. watch events.ndjson for {type: "result"} → trigger tester
//   8. tester verdict → state transition to passed / failed
//   9. on passed: append a line to COMPLETION-LOG.md

import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  autobuildDir,
  sessionsDir,
  sessionDir as sessionDirOf,
  stateFile,
  queueFile,
  inboxDir,
  promptPath,
  completionLog,
  repoRoot,
} from "./lib/paths.mjs";
import { initStateIfMissing, readState, updateState, makeRunRecord, nowIso } from "./state.mjs";
import { parsePrompt } from "./lib/prompt-parser.mjs";
import { evolvePrompt } from "./evolver.mjs";
import {
  tmuxSessionName,
  hasTmux,
  ensureTmuxServer,
  newDetachedSession,
  pipePane,
  killSession,
  sessionExists,
} from "./lib/tmux.mjs";
import { ensureBranch, changedFiles, commitSha, checkScope, branchName } from "./git-warden.mjs";
import { runTests } from "./tester.mjs";
import {
  sumCostFromEventsFile,
  rollDailyBudget,
  dailyBudgetExceeded,
  dailyBudgetWouldExceed,
  runSelfCheckGate,
  SOFT_SELF_CHECK_USD,
  HARD_KILL_USD,
} from "./lib/budget.mjs";
import { appendCompletionLogEntry } from "./lib/completion-log.mjs";
import { logger } from "./lib/logger.mjs";

const COST_POLL_INTERVAL_MS = Number(process.env.AUTOBUILD_POLL_MS || 5000);
const AUTOBUILD_PHASE_ID = "99b-unfucking-v2";

const TICK_INTERVAL_MS = 2000;
const TERMINAL_STATUSES = new Set([
  "passed",
  "failed",
  "escalated",
  "complete",
  "aborted",
  "skipped",
]);
const NON_TERMINAL_BUSY = new Set([
  "spawning",
  "prompting",
  "working",
  "completion_detected",
  "testing",
  "retrying",
]);

function readQueueFile() {
  if (!existsSync(queueFile())) return { order: [] };
  const raw = readFileSync(queueFile(), "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return { order: [] };
  }
}

function writeQueueFile(q) {
  mkdirSync(autobuildDir(), { recursive: true });
  writeFileSync(queueFile(), JSON.stringify(q, null, 2));
}

/**
 * Reconcile queue.json → state.queue. For every id in queue.json's `order`
 * that is not already tracked somewhere (state.queue / state.completed /
 * state.escalated) and is not mid-flight in state.runs, push it into
 * state.queue. Idempotent: safe to call every tick.
 *
 * We only READ queue.json here. The reverse direction (state.queue writes
 * back to queue.json) is handled elsewhere (e.g. `autobuild queue remove`).
 */
export function syncQueueFileToState(log) {
  const file = readQueueFile();
  const order = Array.isArray(file.order) ? file.order : [];
  if (order.length === 0) return;
  const enqueued = [];
  updateState((s) => {
    const completed = new Set(s.completed || []);
    const escalated = new Set(s.escalated || []);
    const queue = new Set(s.queue || []);
    const runs = s.runs || {};
    for (const id of order) {
      if (typeof id !== "string" || !id) continue;
      if (queue.has(id)) continue;
      if (completed.has(id)) continue;
      if (escalated.has(id)) continue;
      // If a run record already exists and is in a non-terminal state, it's
      // being processed — don't double-queue.
      const run = runs[id];
      if (run && NON_TERMINAL_BUSY.has(run.status)) continue;
      // If the run exists in a terminal state we haven't already bookkept,
      // also skip — the terminal status is authoritative.
      if (run && TERMINAL_STATUSES.has(run.status)) continue;
      s.queue.push(id);
      queue.add(id);
      enqueued.push(id);
    }
  });
  if (log && enqueued.length > 0) {
    for (const id of enqueued) {
      log.info?.({ id }, "queue: synced from queue.json");
    }
  }
}

export function initAutobuild() {
  mkdirSync(autobuildDir(), { recursive: true });
  mkdirSync(sessionsDir(), { recursive: true });
  mkdirSync(inboxDir(), { recursive: true });
  if (!existsSync(queueFile())) writeQueueFile({ order: [] });
  return initStateIfMissing();
}

function readInboxCommands() {
  if (!existsSync(inboxDir())) return [];
  const files = readdirSync(inboxDir())
    .filter((f) => f.endsWith(".json"))
    .sort();
  const cmds = [];
  for (const f of files) {
    const p = join(inboxDir(), f);
    try {
      const raw = readFileSync(p, "utf8");
      const obj = JSON.parse(raw);
      cmds.push({ file: p, cmd: obj });
    } catch (err) {
      cmds.push({ file: p, cmd: null, parseError: err.message });
    }
  }
  return cmds;
}

function deleteInboxCommand(filePath) {
  try {
    unlinkSync(filePath);
  } catch {}
}

function processInboxCommands(log) {
  const cmds = readInboxCommands();
  for (const entry of cmds) {
    const { file, cmd, parseError } = entry;
    if (parseError || !cmd || typeof cmd.cmd !== "string") {
      log.warn({ file, parseError }, "inbox: malformed command");
      deleteInboxCommand(file);
      continue;
    }
    const { cmd: op, target, payload } = cmd;
    log.info({ file, op, target }, "inbox: processing command");
    switch (op) {
      case "pause":
        updateState((s) => {
          s.paused = true;
        });
        break;
      case "resume":
        updateState((s) => {
          s.paused = false;
        });
        break;
      case "halt":
        updateState((s) => {
          s.halted = true;
        });
        break;
      case "abort":
        updateState((s) => {
          if (target && s.runs[target]) {
            s.runs[target].status = "aborted";
            s.runs[target].ended_at = nowIso();
            s.runs[target].last_error = "aborted via inbox";
          }
        });
        break;
      case "approve":
        updateState((s) => {
          if (target && s.runs[target]) {
            s.runs[target].needs_review = false;
          }
        });
        break;
      case "skip":
        updateState((s) => {
          if (target && s.runs[target]) {
            s.runs[target].status = "skipped";
            s.runs[target].ended_at = nowIso();
          }
          s.queue = s.queue.filter((id) => id !== target);
        });
        break;
      case "rerun":
        updateState((s) => {
          if (target && s.runs[target]) {
            s.runs[target].status = "queued";
            s.runs[target].attempt = (s.runs[target].attempt || 1) + 1;
          }
          if (target && !s.queue.includes(target)) s.queue.push(target);
        });
        break;
      default:
        log.warn({ op }, "inbox: unknown command");
    }
    deleteInboxCommand(file);
  }
}

function anyRunBusy(state) {
  for (const id of Object.keys(state.runs || {})) {
    if (NON_TERMINAL_BUSY.has(state.runs[id].status)) return true;
  }
  return false;
}

/**
 * Return next prompt-id from the queue that respects tier ordering:
 * we only let a Tier-N prompt run if all prompts from Tier-0..N-1 already in
 * state are terminal (passed/complete/escalated/skipped).
 */
function pickNextQueued(state) {
  if (!state.queue || state.queue.length === 0) return null;
  // Compute the minimum tier present in queue.
  const queuedRuns = state.queue
    .map((id) => ({ id, run: state.runs[id] }))
    .filter((x) => x.run);
  if (queuedRuns.length === 0) {
    // We have IDs in queue but no run record yet — allow first pick.
    return state.queue[0];
  }
  const minTier = Math.min(...queuedRuns.map((x) => x.run.tier));
  const eligible = queuedRuns.find((x) => x.run.tier === minTier && x.run.status === "queued");
  return eligible ? eligible.id : state.queue.find((id) => !state.runs[id]) || null;
}

function writeSessionArtifact(sdir, name, content) {
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, name), content);
}

function appendTransition(sdir, transition) {
  mkdirSync(sdir, { recursive: true });
  appendFileSync(
    join(sdir, "transitions.ndjson"),
    JSON.stringify({ ts: nowIso(), ...transition }) + "\n",
  );
}

async function spawnWorker(promptId, log) {
  const parsed = parsePrompt(promptPath(promptId));
  const sessionId = randomUUID();
  const sdir = sessionDirOf(sessionId);
  mkdirSync(sdir, { recursive: true });
  const tmux = tmuxSessionName(promptId);
  const branch = branchName(promptId);
  const eventsPath = join(sdir, "events.ndjson");
  const tmuxLog = join(sdir, "tmux.log");
  const stderrLog = join(sdir, "stderr.log");

  // Write prompt + startup-context artifacts.
  writeSessionArtifact(sdir, "prompt.md", readFileSync(parsed.filePath, "utf8"));
  writeSessionArtifact(sdir, "startup-context.md", evolvePrompt(parsed));

  // Register the run in state.
  updateState((s) => {
    s.runs[promptId] = makeRunRecord(parsed, {
      sessionId,
      tmuxSession: tmux,
      branch,
      logPath: tmuxLog,
      eventsPath,
    });
    s.runs[promptId].status = "spawning";
    s.runs[promptId].started_at = nowIso();
  });
  appendTransition(sdir, { from: "queued", to: "spawning", prompt_id: promptId });

  // Cut branch.
  try {
    await ensureBranch(promptId, { cwd: repoRoot() });
  } catch (err) {
    log.error({ err: err.message, promptId }, "git-warden: branch cut failed");
    updateState((s) => {
      s.runs[promptId].status = "escalated";
      s.runs[promptId].last_error = err.message;
      s.runs[promptId].ended_at = nowIso();
      s.queue = s.queue.filter((id) => id !== promptId);
      if (!s.escalated.includes(promptId)) s.escalated.push(promptId);
    });
    appendTransition(sdir, { to: "escalated", reason: "branch_cut_failed", err: err.message });
    return;
  }

  if (process.env.AUTOBUILD_DRY_RUN === "1") {
    // Dry-run fast path: do not spawn claude. Just simulate a worker that
    // emitted a result immediately. The test fixture writes its own
    // events.ndjson and diff.patch; if absent, we fabricate a minimal result
    // line so the tester can be triggered.
    if (!existsSync(eventsPath)) {
      writeFileSync(
        eventsPath,
        JSON.stringify({ type: "result", total_cost_usd: 0.01, success: true }) + "\n",
      );
    }
    updateState((s) => {
      s.runs[promptId].status = "completion_detected";
    });
    appendTransition(sdir, { to: "completion_detected", reason: "dry_run" });
    return { parsed, sessionId, sdir };
  }

  // Real spawn.
  if (!(await hasTmux())) {
    const err = "tmux binary not found on PATH";
    updateState((s) => {
      s.runs[promptId].status = "escalated";
      s.runs[promptId].last_error = err;
      s.runs[promptId].ended_at = nowIso();
    });
    appendTransition(sdir, { to: "escalated", reason: err });
    return;
  }
  const cliCmd =
    `cd ${JSON.stringify(repoRoot())} && ` +
    // --verbose is REQUIRED when combining -p with --output-format=stream-json
    // (Claude CLI rejects the combo otherwise). --dangerously-skip-permissions
    // is also required in non-interactive mode since there's no human to
    // answer permission prompts.
    `claude -p "$(cat ${JSON.stringify(join(sdir, "startup-context.md"))} ${JSON.stringify(join(sdir, "prompt.md"))})" ` +
    `--output-format stream-json --verbose --dangerously-skip-permissions ` +
    `--max-turns ${parsed.max_turns} ` +
    `> ${JSON.stringify(eventsPath)} 2> ${JSON.stringify(stderrLog)}`;
  // Ensure a tmux server is running before we try to create a session or
  // attach a pipe-pane. `pipe-pane` requires an existing server+session; on a
  // fresh macOS login there is no server until something starts one. This
  // block is idempotent — `start-server` on an already-running server is a
  // no-op.
  await ensureTmuxServer();
  await newDetachedSession(tmux, repoRoot(), cliCmd);
  await pipePane(tmux, tmuxLog);
  updateState((s) => {
    s.runs[promptId].status = "working";
  });
  appendTransition(sdir, { to: "working" });
  return { parsed, sessionId, sdir };
}

function eventsShowResult(eventsPath) {
  if (!existsSync(eventsPath)) return false;
  const raw = readFileSync(eventsPath, "utf8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type === "result") return true;
    } catch {}
  }
  return false;
}

/**
 * Hard kill an in-flight worker and record the termination reason on state.
 * Does not throw — kill is best-effort.
 */
export async function killWorker({ promptId, tmuxSessionName: name, reason, log }) {
  try {
    if (name) await killSession(name);
  } catch (err) {
    (log || console).error?.({ err: err.message, name }, "killWorker: kill-session failed");
  }
  updateState((s) => {
    const run = s.runs?.[promptId];
    if (!run) return;
    run.status = "failed";
    run.ended_at = nowIso();
    run.last_retry_reason = reason;
    run.last_error = run.last_error || `worker killed: ${reason}`;
    if (Array.isArray(s.queue)) s.queue = s.queue.filter((id) => id !== promptId);
    if (!s.escalated.includes(promptId)) s.escalated.push(promptId);
  });
}

/**
 * Poll events.ndjson every N ms while a worker is "working". On each poll:
 *   - update state.runs[id].cost_usd with the current rolling cost
 *   - if cost >= $5 and self_check == null → invoke runSelfCheckGate()
 *       - escalate → killWorker() and return
 *       - continue → record self_check and keep polling
 *   - if cost >= $10 → killWorker() with budget_session_exceeded and return
 *   - if (daily.spent + current) >= daily.cap → set state.paused=true (no new
 *     spawns) and mark last_retry_reason=budget_daily_exceeded (but let this
 *     run finish)
 *   - otherwise if events.ndjson shows {type:"result"} → return "result"
 *
 * Returns one of: "result" | "killed" | "max-iter".
 */
export async function pollCostUntilResult(promptId, { log = logger(), maxIterations = Infinity } = {}) {
  if (process.env.AUTOBUILD_DRY_RUN === "1") {
    // Dry-run: synthesize a tiny cost and skip gating. Existing dry-run tests
    // expect this path.
    updateState((s) => {
      if (s.runs?.[promptId]) s.runs[promptId].cost_usd = 0.01;
    });
    return "dry-run";
  }
  const state0 = readState();
  const run0 = state0.runs?.[promptId];
  if (!run0) return "result";
  const eventsPath = run0.events_path;
  const tmuxName = run0.tmux_session;
  let dailyPauseRecorded = false;

  for (let i = 0; i < maxIterations; i++) {
    // 1. Update rolling cost.
    const { cost_usd } = sumCostFromEventsFile(eventsPath);
    updateState((s) => {
      if (s.runs?.[promptId]) s.runs[promptId].cost_usd = cost_usd;
    });

    // 2. Hard-kill at $10.
    if (cost_usd >= HARD_KILL_USD) {
      log.warn?.({ promptId, cost_usd }, "budget: hard-kill threshold reached");
      await killWorker({
        promptId,
        tmuxSessionName: tmuxName,
        reason: "budget_session_exceeded",
        log,
      });
      return "killed";
    }

    // 3. Self-check at $5 (one-shot).
    const stateNow = readState();
    const runNow = stateNow.runs?.[promptId];
    if (cost_usd >= SOFT_SELF_CHECK_USD && runNow && runNow.self_check == null) {
      log.warn?.({ promptId, cost_usd }, "budget: self-check threshold reached");
      const verdict = await runSelfCheckGate({
        sessionDir: sessionDirOf(runNow.session_id),
        currentCost: cost_usd,
        promptId,
      });
      updateState((s) => {
        if (s.runs?.[promptId]) {
          s.runs[promptId].self_check = {
            ts: verdict.ts,
            decision: verdict.decision,
            reason: verdict.reason,
            cost_at_gate: verdict.cost_at_gate,
          };
        }
      });
      if (verdict.decision === "escalate") {
        await killWorker({
          promptId,
          tmuxSessionName: tmuxName,
          reason: "self_check_escalate",
          log,
        });
        return "killed";
      }
    }

    // 4. Daily pause (in-flight runs finish; no new spawns).
    const stateAfter = readState();
    if (!dailyPauseRecorded && dailyBudgetWouldExceed(stateAfter, cost_usd)) {
      log.warn?.({ promptId, cost_usd }, "budget: daily cap would be exceeded; pausing rig");
      updateState((s) => {
        s.paused = true;
        if (s.runs?.[promptId]) s.runs[promptId].last_retry_reason = "budget_daily_exceeded";
      });
      dailyPauseRecorded = true;
    }

    // 5. Has the worker finished?
    if (eventsShowResult(eventsPath)) return "result";

    // 6. Has the tmux session died unexpectedly?
    if (tmuxName && !(await sessionExists(tmuxName))) {
      // The session is gone but no result was emitted. Either the worker is
      // still inside the tick loop and just raced us, or it died silently.
      // Wait one more interval then re-check result.
      await sleep(COST_POLL_INTERVAL_MS);
      if (eventsShowResult(eventsPath)) return "result";
      return "killed";
    }

    await sleep(COST_POLL_INTERVAL_MS);
  }
  return "max-iter";
}

async function runTestsForPrompt(promptId, log) {
  const state = readState();
  const run = state.runs[promptId];
  if (!run) return;
  const parsed = parsePrompt(promptPath(promptId));
  const sdir = sessionDirOf(run.session_id);
  updateState((s) => {
    s.runs[promptId].status = "testing";
  });
  appendTransition(sdir, { to: "testing" });

  // Update cost from events.
  const { cost_usd, turns_used } = sumCostFromEventsFile(run.events_path);
  updateState((s) => {
    s.runs[promptId].cost_usd = cost_usd;
    s.runs[promptId].turns_used = turns_used;
    rollDailyBudget(s);
    s.daily_budget_usd.spent += cost_usd;
  });

  // Scope enforcement.
  const paths = await changedFiles({ cwd: repoRoot() });
  const scopeCheck = checkScope(paths, parsed.scope);
  if (!scopeCheck.ok) {
    log.warn({ violations: scopeCheck.violations, promptId }, "scope violation — escalating");
    updateState((s) => {
      s.runs[promptId].status = "escalated";
      s.runs[promptId].last_retry_reason = "scope_violation";
      s.runs[promptId].last_error = `scope violation: ${scopeCheck.violations.join(", ")}`;
      s.runs[promptId].ended_at = nowIso();
      s.queue = s.queue.filter((id) => id !== promptId);
      if (!s.escalated.includes(promptId)) s.escalated.push(promptId);
    });
    appendTransition(sdir, { to: "escalated", reason: "scope_violation", violations: scopeCheck.violations });
    return;
  }

  // Rebuild engine/dist before running tests. Every acceptance test invokes
  // compiled entry points (`node engine/bin/jellyclaw` / `jellyclaw-serve`)
  // that load `engine/dist/cli/main.js`. Without this step, tests run against
  // the stale bundle — Claude's src edits are invisible, so every test fails
  // with the pre-edit behavior. Agent 5 identified this as the critical
  // systemic rig bug after T0-02..T0-04 all failed with stale-dist errors.
  try {
    const { execa } = await import("execa");
    log.info({ promptId }, "rebuilding engine/dist before tests");
    await execa("bun", ["run", "build"], {
      cwd: repoRoot(),
      timeout: 180_000,
      stderr: "pipe",
      stdout: "pipe",
    });
  } catch (err) {
    log.warn({ promptId, err: err?.message ?? String(err) }, "engine rebuild failed — proceeding anyway");
  }

  // Tests.
  const { overall, summary } = await runTests(parsed, { sessionDir: sdir, cwd: repoRoot() });
  const sha = await commitSha({ cwd: repoRoot() });

  if (overall) {
    updateState((s) => {
      s.runs[promptId].status = "passed";
      s.runs[promptId].ended_at = nowIso();
      s.runs[promptId].tests = {
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        pending: summary.pending,
      };
      s.runs[promptId].commit_sha = sha;
      s.queue = s.queue.filter((id) => id !== promptId);
      if (!s.completed.includes(promptId)) s.completed.push(promptId);
      s.runs[promptId].status = "complete";
    });
    appendTransition(sdir, { to: "passed" });
    appendCompletionLogLine(promptId, parsed, sha, summary, run);
  } else {
    updateState((s) => {
      s.runs[promptId].status = "failed";
      s.runs[promptId].ended_at = nowIso();
      s.runs[promptId].tests = {
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        pending: summary.pending,
      };
      s.runs[promptId].last_error = summary.by_test
        .filter((t) => !t.passed)
        .map((t) => `${t.name}: ${t.error || "failed"}`)
        .join("; ");
      s.queue = s.queue.filter((id) => id !== promptId);
      if (!s.escalated.includes(promptId)) s.escalated.push(promptId);
    });
    appendTransition(sdir, { to: "failed", summary });
  }
}

function appendCompletionLogLine(promptId, parsed, sha, summary, run) {
  const path = completionLog();
  if (!existsSync(path)) return; // don't create it if the repo doesn't have it
  try {
    appendCompletionLogEntry({
      logPath: path,
      phaseId: AUTOBUILD_PHASE_ID,
      phaseName: "Unfucking v2 (autobuild-driven)",
      promptId,
      promptTitle: parsed.title,
      endedAtIso: nowIso(),
      startedAtIso: run?.started_at || null,
      commits: sha ? [sha.slice(0, 7)] : [],
      tests: { passed: summary.passed, total: summary.total },
      phaseComplete: false,
    });
  } catch (err) {
    // Never fail a run because we could not update the log.
    try {
      appendFileSync(
        path,
        `\n- autobuild: ${promptId} — ${parsed.title} — ${summary.passed}/${summary.total} tests — ${sha || "(no-sha)"} — ${nowIso()}  <!-- fallback: ${err.message} -->\n`,
      );
    } catch {}
  }
}

/**
 * Run ONE iteration of the dispatcher loop. Returns a small report for the
 * CLI to print in `autobuild tick` mode.
 */
export async function tickOnce({ log = logger() } = {}) {
  initAutobuild();
  // Reconcile queue.json → state.queue before doing anything else. If the
  // operator (or a bootstrap script) wrote ids into queue.json, we want the
  // rig to see them this tick, not next reboot.
  syncQueueFileToState(log);
  const report = { heartbeat: null, actions: [] };

  // 1. heartbeat
  updateState((s) => {
    s.rig_heartbeat = nowIso();
    rollDailyBudget(s);
  });
  report.heartbeat = nowIso();

  // 2. inbox
  processInboxCommands(log);

  const state = readState();

  // 3. pause / halt / budget gates
  if (state.paused) {
    report.actions.push({ kind: "skip", reason: "paused" });
    return report;
  }
  if (state.halted) {
    report.actions.push({ kind: "skip", reason: "halted" });
    return report;
  }
  if (dailyBudgetExceeded(state)) {
    updateState((s) => {
      s.halted = true;
    });
    report.actions.push({ kind: "halt", reason: "daily_budget_exceeded" });
    return report;
  }

  // Drive any run in "completion_detected" through testing immediately.
  for (const id of Object.keys(state.runs)) {
    if (state.runs[id].status === "completion_detected") {
      await runTestsForPrompt(id, log);
      report.actions.push({ kind: "ran_tests", id });
    }
  }

  // Watch for {type:"result"} in working runs → transition to completion_detected.
  // In real mode, inline-poll events.ndjson every ~5s and enforce budget gates.
  const state2 = readState();
  for (const id of Object.keys(state2.runs)) {
    const run = state2.runs[id];
    if (run.status !== "working") continue;
    let outcome = "result";
    if (process.env.AUTOBUILD_DRY_RUN !== "1") {
      outcome = await pollCostUntilResult(id, { log });
    }
    // Re-read the run state after polling — it may have been marked failed.
    const refreshed = readState().runs[id];
    if (refreshed && refreshed.status === "failed") {
      // Gate tripped during poll; no result. Move on.
      appendTransition(sessionDirOf(run.session_id), {
        to: "failed",
        reason: refreshed.last_retry_reason,
      });
      report.actions.push({ kind: "killed", id, reason: refreshed.last_retry_reason });
      continue;
    }
    if (outcome === "result" || eventsShowResult(run.events_path)) {
      updateState((s) => {
        s.runs[id].status = "completion_detected";
      });
      appendTransition(sessionDirOf(run.session_id), { to: "completion_detected" });
      await runTestsForPrompt(id, log);
      report.actions.push({ kind: "ran_tests", id });
    }
  }

  // 4. busy? skip.
  const state3 = readState();
  if (anyRunBusy(state3)) {
    report.actions.push({ kind: "wait", reason: "run_busy" });
    return report;
  }

  // 5. pick next queued.
  const nextId = pickNextQueued(state3);
  if (!nextId) {
    report.actions.push({ kind: "idle", reason: "no_queued" });
    return report;
  }

  // Verify queue.json and state.queue stay in sync.
  updateState((s) => {
    if (!s.queue.includes(nextId)) s.queue.push(nextId);
  });

  // 6. spawn
  try {
    await spawnWorker(nextId, log);
    report.actions.push({ kind: "spawned", id: nextId });
  } catch (err) {
    log.error({ err: err.message, id: nextId }, "spawn failed");
    updateState((s) => {
      if (s.runs[nextId]) {
        s.runs[nextId].status = "escalated";
        s.runs[nextId].last_error = err.message;
      }
      s.queue = s.queue.filter((x) => x !== nextId);
      if (!s.escalated.includes(nextId)) s.escalated.push(nextId);
    });
    report.actions.push({ kind: "spawn_failed", id: nextId, err: err.message });
    return report;
  }

  // In dry-run mode, spawnWorker marks the run "completion_detected" — drive
  // tests right now so the smoke test gets a terminal state in one tick.
  const state4 = readState();
  if (state4.runs[nextId]?.status === "completion_detected") {
    await runTestsForPrompt(nextId, log);
    report.actions.push({ kind: "ran_tests", id: nextId });
  }

  return report;
}

export async function runForever({ log = logger() } = {}) {
  log.info({ pid: process.pid }, "autobuild dispatcher starting");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await tickOnce({ log });
    } catch (err) {
      log.error({ err: err.message, stack: err.stack }, "tick failed");
    }
    await sleep(TICK_INTERVAL_MS);
  }
}
