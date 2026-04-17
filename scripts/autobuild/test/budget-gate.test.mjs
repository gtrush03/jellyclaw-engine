// budget-gate.test.mjs — self-check gate at $5.
//
// We exercise the dispatcher's `pollCostUntilResult` directly with a
// synthetic events.ndjson whose cumulative token usage crosses $5. The
// `AUTOBUILD_SELF_CHECK_INJECT` env var is the test hook that replaces the
// real `claude -p` call.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "autobuild-budget-gate-"));
process.env.AUTOBUILD_ROOT = root;
// Real mode so gates fire.
delete process.env.AUTOBUILD_DRY_RUN;
// Tight poll so tests run quickly.
process.env.AUTOBUILD_POLL_MS = "10";

const stateMod = await import("../state.mjs");
const dispatcher = await import("../dispatcher.mjs");
const pathsMod = await import("../lib/paths.mjs");

test.after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

function seedRun(promptId, { eventsPath, cost }) {
  mkdirSync(pathsMod.sessionsDir(), { recursive: true });
  // Synthesize events.ndjson with token counts that produce roughly `cost` USD
  // under Opus ($15 / $75 per M).
  const outputTokens = Math.ceil((cost * 1_000_000) / 75);
  const line = JSON.stringify({
    type: "usage.updated",
    model: "claude-opus-4-7",
    usage: { input_tokens: 0, output_tokens: outputTokens },
  });
  writeFileSync(eventsPath, line + "\n");
}

test("self-check at $5: continue verdict keeps run working + records self_check", async () => {
  stateMod.initStateIfMissing();
  const promptId = "T0-gate-continue";
  const sessionId = "sess-continue";
  const sdir = pathsMod.sessionDir(sessionId);
  mkdirSync(sdir, { recursive: true });
  const eventsPath = join(sdir, "events.ndjson");

  stateMod.updateState((s) => {
    s.runs[promptId] = {
      status: "working",
      tier: 0,
      session_id: sessionId,
      tmux_session: null, // null disables sessionExists check
      events_path: eventsPath,
      cost_usd: 0,
      self_check: null,
    };
  });

  seedRun(promptId, { eventsPath, cost: 5.5 });
  process.env.AUTOBUILD_SELF_CHECK_INJECT = JSON.stringify({
    continue: true,
    reason: "looks fine",
  });

  // Add the {type:"result"} line so the poll loop terminates after gating.
  const fs = await import("node:fs");
  fs.appendFileSync(eventsPath, JSON.stringify({ type: "result", total_cost_usd: 5.5 }) + "\n");

  const outcome = await dispatcher.pollCostUntilResult(promptId, {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    maxIterations: 3,
  });

  const s = stateMod.readState();
  const run = s.runs[promptId];
  assert.ok(run.self_check, "self_check should be recorded");
  assert.equal(run.self_check.decision, "continue");
  assert.ok(run.self_check.cost_at_gate >= 5, "cost_at_gate should reflect >=$5");
  assert.equal(run.status, "working", "continue keeps status working");
  assert.ok(outcome === "result" || outcome === "max-iter");

  delete process.env.AUTOBUILD_SELF_CHECK_INJECT;
});

test("self-check at $5: escalate verdict kills worker and marks failed", async () => {
  stateMod.initStateIfMissing();
  const promptId = "T0-gate-escalate";
  const sessionId = "sess-escalate";
  const sdir = pathsMod.sessionDir(sessionId);
  mkdirSync(sdir, { recursive: true });
  const eventsPath = join(sdir, "events.ndjson");

  stateMod.updateState((s) => {
    s.runs[promptId] = {
      status: "working",
      tier: 0,
      session_id: sessionId,
      tmux_session: null,
      events_path: eventsPath,
      cost_usd: 0,
      self_check: null,
    };
    if (!s.queue.includes(promptId)) s.queue.push(promptId);
  });

  seedRun(promptId, { eventsPath, cost: 6.0 });
  process.env.AUTOBUILD_SELF_CHECK_INJECT = JSON.stringify({
    continue: false,
    reason: "runaway",
  });

  const outcome = await dispatcher.pollCostUntilResult(promptId, {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    maxIterations: 3,
  });

  const s = stateMod.readState();
  const run = s.runs[promptId];
  assert.equal(outcome, "killed");
  assert.equal(run.status, "failed");
  assert.equal(run.last_retry_reason, "self_check_escalate");
  assert.ok(run.self_check, "self_check should be recorded even on escalate");
  assert.equal(run.self_check.decision, "escalate");
  assert.ok(!s.queue.includes(promptId), "escalated prompt removed from queue");
  assert.ok(s.escalated.includes(promptId));

  delete process.env.AUTOBUILD_SELF_CHECK_INJECT;
});
