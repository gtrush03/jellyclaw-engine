// jc-commands.test.mjs — node:test coverage for the `jc` CLI.
//
// Each test isolates state in a temp AUTOBUILD_ROOT so there's no
// cross-contamination.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const JC = resolve(HERE, "..", "jc");

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "jc-test-"));
}

function seedState(root, state) {
  mkdirSync(join(root, ".autobuild"), { recursive: true });
  writeFileSync(join(root, ".autobuild", "state.json"), JSON.stringify(state, null, 2));
}

function run(args, env = {}) {
  const res = spawnSync(process.execPath, [JC, ...args], {
    env: { ...process.env, NO_COLOR: "1", ...env },
    encoding: "utf8",
  });
  return res;
}

test("`jc help` exits 0 and lists status", () => {
  const res = run(["help"]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  assert.match(res.stdout, /status/);
  assert.match(res.stdout, /pause/);
  assert.match(res.stdout, /abort/);
});

test("`jc` with no args prints help and exits 0", () => {
  const res = run([]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /status/);
});

test("`jc status` on valid state.json prints summary", () => {
  const root = tmpRoot();
  try {
    seedState(root, {
      rig_version: "0.1.0",
      rig_heartbeat: new Date().toISOString(),
      concurrency: 2,
      paused: false,
      halted: false,
      daily_budget_usd: { spent: 1.5, cap: 25, day: new Date().toISOString().slice(0, 10) },
      runs: {
        "T0-01-example": {
          status: "running",
          tier: 0,
          attempt: 1,
          max_retries: 5,
          started_at: new Date(Date.now() - 120_000).toISOString(),
          updated_at: new Date().toISOString(),
          tests: { total: 5, passed: 3, failed: 0 },
        },
      },
      queue: ["T0-02-next"],
      completed: [],
      escalated: [],
    });
    const res = run(["status"], { AUTOBUILD_ROOT: root });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /jc-rig/);
    assert.match(res.stdout, /OK/);
    assert.match(res.stdout, /\$1\.50\/25/);
    assert.match(res.stdout, /queue\s+1/);
    assert.match(res.stdout, /running\s+1\/2/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`jc status --line` prints compact summary", () => {
  const root = tmpRoot();
  try {
    seedState(root, {
      rig_version: "0.1.0",
      rig_heartbeat: new Date().toISOString(),
      concurrency: 3,
      paused: false,
      halted: false,
      daily_budget_usd: { spent: 4.2, cap: 25, day: new Date().toISOString().slice(0, 10) },
      runs: {
        a: { status: "running" },
        b: { status: "testing" },
      },
      queue: [1, 2, 3, 4, 5, 6, 7],
    });
    const res = run(["status", "--line"], { AUTOBUILD_ROOT: root });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /q=7 run=2\/3 today=\$4\.20\/25 OK/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`jc pause` writes an inbox file with cmd:pause", () => {
  const root = tmpRoot();
  try {
    seedState(root, { rig_version: "0.1.0", runs: {}, queue: [] });
    const res = run(["pause"], { AUTOBUILD_ROOT: root });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const inboxDir = join(root, ".orchestrator", "inbox");
    const files = readdirSync(inboxDir);
    assert.equal(files.length, 1);
    const payload = JSON.parse(readFileSync(join(inboxDir, files[0]), "utf8"));
    assert.equal(payload.cmd, "pause");
    assert.ok(payload.issued_at);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`jc abort T0-01` writes inbox with cmd:abort, target:T0-01", () => {
  const root = tmpRoot();
  try {
    seedState(root, { rig_version: "0.1.0", runs: {}, queue: [] });
    const res = run(["abort", "T0-01"], { AUTOBUILD_ROOT: root });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const files = readdirSync(join(root, ".orchestrator", "inbox"));
    assert.equal(files.length, 1);
    const payload = JSON.parse(readFileSync(join(root, ".orchestrator", "inbox", files[0]), "utf8"));
    assert.equal(payload.cmd, "abort");
    assert.equal(payload.target, "T0-01");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`jc tell <id> \"hint\"` writes inbox with payload", () => {
  const root = tmpRoot();
  try {
    seedState(root, { rig_version: "0.1.0", runs: {}, queue: [] });
    const res = run(["tell", "T0-05", "check the env var TEST_SHIM"], { AUTOBUILD_ROOT: root });
    assert.equal(res.status, 0);
    const files = readdirSync(join(root, ".orchestrator", "inbox"));
    assert.equal(files.length, 1);
    const payload = JSON.parse(readFileSync(join(root, ".orchestrator", "inbox", files[0]), "utf8"));
    assert.equal(payload.cmd, "tell");
    assert.equal(payload.target, "T0-05");
    assert.equal(payload.payload, "check the env var TEST_SHIM");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`jc concurrency 4` writes inbox with numeric payload", () => {
  const root = tmpRoot();
  try {
    seedState(root, { rig_version: "0.1.0", runs: {}, queue: [] });
    const res = run(["concurrency", "4"], { AUTOBUILD_ROOT: root });
    assert.equal(res.status, 0);
    const files = readdirSync(join(root, ".orchestrator", "inbox"));
    const payload = JSON.parse(readFileSync(join(root, ".orchestrator", "inbox", files[0]), "utf8"));
    assert.equal(payload.cmd, "concurrency");
    assert.equal(payload.payload, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`jc concurrency auto` writes the string 'auto'", () => {
  const root = tmpRoot();
  try {
    seedState(root, { rig_version: "0.1.0", runs: {}, queue: [] });
    const res = run(["concurrency", "auto"], { AUTOBUILD_ROOT: root });
    assert.equal(res.status, 0);
    const files = readdirSync(join(root, ".orchestrator", "inbox"));
    const payload = JSON.parse(readFileSync(join(root, ".orchestrator", "inbox", files[0]), "utf8"));
    assert.equal(payload.cmd, "concurrency");
    assert.equal(payload.payload, "auto");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`jc concurrency bogus` exits nonzero", () => {
  const root = tmpRoot();
  try {
    seedState(root, { rig_version: "0.1.0", runs: {}, queue: [] });
    const res = run(["concurrency", "bogus"], { AUTOBUILD_ROOT: root });
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /concurrency/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`jc pause-until 09:30` writes inbox + sentinel file", () => {
  const root = tmpRoot();
  try {
    seedState(root, { rig_version: "0.1.0", runs: {}, queue: [] });
    const res = run(["pause-until", "09:30"], { AUTOBUILD_ROOT: root });
    assert.equal(res.status, 0);
    const sentinel = readFileSync(join(root, ".orchestrator", "paused-until"), "utf8");
    assert.equal(sentinel, "09:30");
    const files = readdirSync(join(root, ".orchestrator", "inbox"));
    const payload = JSON.parse(readFileSync(join(root, ".orchestrator", "inbox", files[0]), "utf8"));
    assert.equal(payload.cmd, "pause-until");
    assert.equal(payload.payload, "09:30");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`jc status` with no state.json exits 2 with graceful message", () => {
  const root = tmpRoot();
  try {
    // Note: no .autobuild dir at all.
    const res = run(["status"], { AUTOBUILD_ROOT: root });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /rig state dir missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`jc ps` with no runs prints graceful message", () => {
  const root = tmpRoot();
  try {
    seedState(root, { rig_version: "0.1.0", runs: {}, queue: [] });
    const res = run(["ps"], { AUTOBUILD_ROOT: root });
    assert.equal(res.status, 0);
    assert.match(res.stdout, /no runs/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`jc ps` with runs prints a table including the ID", () => {
  const root = tmpRoot();
  try {
    seedState(root, {
      rig_version: "0.1.0",
      runs: {
        "T0-01-fix-serve-shim": {
          status: "testing",
          tier: 0,
          attempt: 1,
          max_retries: 5,
          started_at: new Date(Date.now() - 192_000).toISOString(),
          updated_at: new Date(Date.now() - 2000).toISOString(),
          tests: { total: 5, passed: 3, failed: 0 },
        },
      },
      queue: [],
    });
    const res = run(["ps"], { AUTOBUILD_ROOT: root });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /T0-01-fix-serve-shim/);
    assert.match(res.stdout, /testing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("`jc hint` with no args prints the M13 placeholder", () => {
  const res = run(["hint"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /M13 not yet/);
});

test("`jc abort` with no target exits nonzero", () => {
  const res = run(["abort"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /usage: jc abort/);
});

test("`jc budget` on valid state prints bar + forecast", () => {
  const root = tmpRoot();
  try {
    seedState(root, {
      rig_version: "0.1.0",
      runs: {
        x: { cost_usd: 2.1, status: "running" },
        y: { cost_usd: 0.5, status: "testing" },
      },
      queue: [],
      daily_budget_usd: { spent: 2.6, cap: 25, day: new Date().toISOString().slice(0, 10) },
    });
    const res = run(["budget"], { AUTOBUILD_ROOT: root });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /\$2\.60/);
    assert.match(res.stdout, /forecast/);
    assert.match(res.stdout, /gates/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown command exits 2 with an error message", () => {
  const res = run(["nonexistent"]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown command/);
});
