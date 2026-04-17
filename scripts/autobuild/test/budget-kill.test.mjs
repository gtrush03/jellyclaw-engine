// budget-kill.test.mjs — hard kill at $10.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "autobuild-budget-kill-"));
process.env.AUTOBUILD_ROOT = root;
delete process.env.AUTOBUILD_DRY_RUN;
process.env.AUTOBUILD_POLL_MS = "10";

const stateMod = await import("../state.mjs");
const dispatcher = await import("../dispatcher.mjs");
const pathsMod = await import("../lib/paths.mjs");

test.after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

test("hard-kill at $10: worker transitions to failed with budget_session_exceeded", async () => {
  stateMod.initStateIfMissing();
  const promptId = "T0-kill-hard";
  const sessionId = "sess-kill";
  const sdir = pathsMod.sessionDir(sessionId);
  mkdirSync(sdir, { recursive: true });
  const eventsPath = join(sdir, "events.ndjson");

  // Synthesize usage that yields ~$11 (above the $10 cap) under Opus rates.
  const outputTokens = Math.ceil((11 * 1_000_000) / 75);
  writeFileSync(
    eventsPath,
    JSON.stringify({
      type: "usage.updated",
      model: "claude-opus-4-7",
      usage: { input_tokens: 0, output_tokens: outputTokens },
    }) + "\n",
  );

  stateMod.updateState((s) => {
    s.runs[promptId] = {
      status: "working",
      tier: 0,
      session_id: sessionId,
      tmux_session: null, // tmux noop in test
      events_path: eventsPath,
      cost_usd: 0,
      self_check: null,
    };
    if (!s.queue.includes(promptId)) s.queue.push(promptId);
  });

  const outcome = await dispatcher.pollCostUntilResult(promptId, {
    log: { info() {}, warn() {}, error() {}, debug() {} },
    maxIterations: 3,
  });

  const s = stateMod.readState();
  const run = s.runs[promptId];
  assert.equal(outcome, "killed");
  assert.equal(run.status, "failed");
  assert.equal(run.last_retry_reason, "budget_session_exceeded");
  assert.ok(!s.queue.includes(promptId));
  assert.ok(s.escalated.includes(promptId));
});

test("killWorker helper is exported and idempotent", async () => {
  assert.equal(typeof dispatcher.killWorker, "function");
  // Calling killWorker on a non-existent run must not throw.
  await dispatcher.killWorker({
    promptId: "nope-does-not-exist",
    tmuxSessionName: null,
    reason: "test",
    log: { error() {}, warn() {} },
  });
});
