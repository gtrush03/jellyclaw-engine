// smoke-dispatch.test.mjs — end-to-end tick in a tmp repo.
//
// We set AUTOBUILD_ROOT + AUTOBUILD_DRY_RUN=1 so no real tmux/claude/git is
// touched. The rig should:
//   1. queue the fake prompt
//   2. spawn (dry-run, which writes a synthetic events.ndjson with
//      {type:"result"})
//   3. run the frontmatter shell test (echo ok)
//   4. transition state: queued → passed/complete

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "autobuild-smoke-"));
process.env.AUTOBUILD_ROOT = root;
process.env.AUTOBUILD_DRY_RUN = "1";

// Scaffold: create a fake prompts/phase-99b-unfucking-v2/ dir with one prompt.
const promptsDir = join(root, "prompts", "phase-99b-unfucking-v2");
mkdirSync(promptsDir, { recursive: true });
const FAKE_ID = "T0-99-smoke";
writeFileSync(
  join(promptsDir, `${FAKE_ID}.md`),
  `---
id: ${FAKE_ID}
tier: 0
title: "Smoke test prompt — no-op"
scope:
  - "engine/**/*"
depends_on_fix: []
tests:
  - name: echo-ok
    kind: shell
    command: "echo ok"
    expect_exit: 0
    expect_stdout: "ok"
human_gate: false
max_turns: 3
max_cost_usd: 1
max_retries: 1
estimated_duration_min: 1
---

# Smoke test prompt.
`,
);

const stateMod = await import("../state.mjs");
const dispatcher = await import("../dispatcher.mjs");
const pathsMod = await import("../lib/paths.mjs");

test.after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

test("autobuild tick processes queued prompt end-to-end in dry-run", async () => {
  dispatcher.initAutobuild();

  // Queue the prompt.
  stateMod.updateState((s) => {
    s.queue.push(FAKE_ID);
  });

  // First tick: spawns worker (dry-run), driver writes synthetic events,
  // then runs tests in the same tick.
  const report1 = await dispatcher.tickOnce({
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });

  const s = stateMod.readState();
  const run = s.runs[FAKE_ID];
  assert.ok(run, "run record should exist");
  assert.equal(
    run.status,
    "complete",
    `expected 'complete', got '${run.status}' (last_error=${run.last_error})`,
  );
  assert.equal(run.tests.total, 1);
  assert.equal(run.tests.passed, 1);
  assert.equal(run.tests.failed, 0);
  assert.ok(s.completed.includes(FAKE_ID), "should be in completed[]");
  assert.ok(!s.queue.includes(FAKE_ID), "should be removed from queue[]");

  // Session artifacts on disk.
  const sdir = pathsMod.sessionDir(run.session_id);
  assert.ok(existsSync(join(sdir, "prompt.md")));
  assert.ok(existsSync(join(sdir, "startup-context.md")));
  assert.ok(existsSync(join(sdir, "events.ndjson")));
  assert.ok(existsSync(join(sdir, "test-results.json")));
  assert.ok(existsSync(join(sdir, "transitions.ndjson")));

  // Ignore report1; keep the var for introspection when the test fails.
  void report1;
});
