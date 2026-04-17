// queue-sync.test.mjs — verify that tickOnce reconciles queue.json into
// state.queue via syncQueueFileToState.
//
// Scenarios:
//   1. A bootstrapped queue.json with 3 ids and an empty state.json → after
//      one dry-run tick, state.queue contains all 3.
//   2. queue.json has 3 ids, one is already in state.completed → only the
//      other 2 land in state.queue.
//   3. Idempotence — calling the sync twice does not duplicate entries.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set AUTOBUILD_ROOT before any of our modules import paths.mjs.
const root = mkdtempSync(join(tmpdir(), "autobuild-queuesync-"));
process.env.AUTOBUILD_ROOT = root;
process.env.AUTOBUILD_DRY_RUN = "1";

// Scaffold a phase-99b-unfucking-v2/ dir with three minimal prompts so that
// anything downstream that touches parsePrompt doesn't explode. The sync
// logic itself doesn't parse prompts — it only pushes ids — but tickOnce may
// try to spawn the first queued prompt afterwards, so give it something real.
const promptsDir = join(root, "prompts", "phase-99b-unfucking-v2");
mkdirSync(promptsDir, { recursive: true });
const IDS = ["T0-90-alpha", "T0-91-beta", "T0-92-gamma"];
for (const id of IDS) {
  writeFileSync(
    join(promptsDir, `${id}.md`),
    `---
id: ${id}
tier: 0
title: "queue sync fixture — ${id}"
scope:
  - "engine/**/*"
depends_on_fix: []
tests:
  - name: noop
    kind: shell
    command: "true"
    expect_exit: 0
human_gate: false
max_turns: 3
max_cost_usd: 1
max_retries: 1
estimated_duration_min: 1
---

# ${id}
`,
  );
}

const stateMod = await import("../state.mjs");
const dispatcher = await import("../dispatcher.mjs");
const pathsMod = await import("../lib/paths.mjs");

// Ensure .autobuild/ exists before we write queue.json.
mkdirSync(join(root, ".autobuild"), { recursive: true });

function writeQueueJson(order) {
  writeFileSync(
    join(root, ".autobuild", "queue.json"),
    JSON.stringify({ order }, null, 2),
  );
}

function resetState(mutator) {
  const s = stateMod.defaultState();
  if (mutator) mutator(s);
  stateMod.writeState(s);
}

const nullLog = { info() {}, warn() {}, error() {}, debug() {} };

test.after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

test("syncQueueFileToState enqueues all fresh ids into empty state.queue", async () => {
  resetState();
  writeQueueJson(IDS);
  dispatcher.syncQueueFileToState(nullLog);
  const s = stateMod.readState();
  assert.deepEqual(s.queue, IDS);
  // Sanity: queue.json unchanged on disk (sync only reads it).
  const raw = readFileSync(pathsMod.queueFile(), "utf8");
  assert.deepEqual(JSON.parse(raw).order, IDS);
});

test("syncQueueFileToState skips ids already in state.completed", async () => {
  resetState((s) => {
    s.completed.push("T0-90-alpha");
  });
  writeQueueJson(IDS);
  dispatcher.syncQueueFileToState(nullLog);
  const s = stateMod.readState();
  assert.deepEqual(s.queue, ["T0-91-beta", "T0-92-gamma"]);
});

test("syncQueueFileToState skips ids already in state.escalated", async () => {
  resetState((s) => {
    s.escalated.push("T0-91-beta");
  });
  writeQueueJson(IDS);
  dispatcher.syncQueueFileToState(nullLog);
  const s = stateMod.readState();
  assert.deepEqual(s.queue, ["T0-90-alpha", "T0-92-gamma"]);
});

test("syncQueueFileToState is idempotent — two calls, no duplicates", async () => {
  resetState();
  writeQueueJson(IDS);
  dispatcher.syncQueueFileToState(nullLog);
  dispatcher.syncQueueFileToState(nullLog);
  const s = stateMod.readState();
  assert.deepEqual(s.queue, IDS);
  // Ensure no accidental duplicates.
  const set = new Set(s.queue);
  assert.equal(set.size, s.queue.length);
});

test("syncQueueFileToState does nothing when queue.json is absent", async () => {
  resetState();
  // Remove queue.json if it exists (prior tests will have written it).
  const qf = pathsMod.queueFile();
  if (existsSync(qf)) {
    try {
      unlinkSync(qf);
    } catch {}
  }
  dispatcher.syncQueueFileToState(nullLog);
  const s = stateMod.readState();
  assert.deepEqual(s.queue, []);
});

test("tickOnce wires sync → pick → spawn end-to-end in dry-run", async () => {
  // Full integration: empty state, queue.json has one id. One tick should
  // move the id through queue → spawn → test pass.
  resetState();
  writeQueueJson(["T0-90-alpha"]);
  await dispatcher.tickOnce({ log: nullLog });
  const s = stateMod.readState();
  // Dry-run spawns, runs the trivial `true` test, and lands on complete.
  const run = s.runs["T0-90-alpha"];
  assert.ok(run, "run record should exist after tickOnce");
  assert.equal(
    run.status,
    "complete",
    `expected status=complete, got ${run.status} (err=${run.last_error})`,
  );
  assert.ok(s.completed.includes("T0-90-alpha"));
  assert.ok(!s.queue.includes("T0-90-alpha"));
});
