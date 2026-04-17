// state.test.mjs — exercise atomic write + concurrent-write safety.
//
// We drive state.mjs by pointing it at a tmp state.json via AUTOBUILD_ROOT.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The state module reads env AUTOBUILD_ROOT lazily via paths.mjs, so we must
// set it before importing.
const root = mkdtempSync(join(tmpdir(), "autobuild-state-"));
process.env.AUTOBUILD_ROOT = root;

const stateMod = await import("../state.mjs");
const pathsMod = await import("../lib/paths.mjs");

test.after(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
});

test("initStateIfMissing creates default shape", () => {
  const s = stateMod.initStateIfMissing();
  assert.equal(s.rig_version, "0.1.0");
  assert.equal(s.paused, false);
  assert.equal(s.halted, false);
  assert.deepEqual(s.queue, []);
  assert.deepEqual(s.runs, {});
  assert.equal(typeof s.rig_heartbeat, "string");
  assert.equal(s.daily_budget_usd.cap, 25);
  assert.ok(existsSync(pathsMod.stateFile()));
});

test("updateState performs atomic mutate", () => {
  stateMod.updateState((s) => {
    s.queue.push("T0-00-test");
    s.runs["T0-00-test"] = { status: "queued", tier: 0 };
  });
  const s = stateMod.readState();
  assert.deepEqual(s.queue, ["T0-00-test"]);
  assert.equal(s.runs["T0-00-test"].status, "queued");
});

test("concurrent updates do not lose writes", async () => {
  // Reset
  stateMod.writeState(stateMod.defaultState());
  // Fire 20 concurrent increments. With the lock, every one should land.
  const tasks = [];
  for (let i = 0; i < 20; i++) {
    tasks.push(
      Promise.resolve().then(() =>
        stateMod.updateState((s) => {
          s.daily_budget_usd.spent = (s.daily_budget_usd.spent || 0) + 1;
        }),
      ),
    );
  }
  await Promise.all(tasks);
  const s = stateMod.readState();
  assert.equal(s.daily_budget_usd.spent, 20);
});

test("state.json is valid JSON after every write", () => {
  stateMod.updateState((s) => {
    s.paused = true;
  });
  const raw = readFileSync(pathsMod.stateFile(), "utf8");
  // Should parse without throwing.
  const parsed = JSON.parse(raw);
  assert.equal(parsed.paused, true);
});
