// grid-render.test.mjs — unit tests for grid.mjs render() output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { render } from "../grid.mjs";

// Force no-color so assertions can match plain text.
process.env.JC_NO_COLOR = "1";

test("render handles null state gracefully", () => {
  const out = render(null, { columns: 120 });
  assert.match(out, /rig not running/);
  assert.match(out, /autobuild run/);
});

test("render flags corrupt state", () => {
  const out = render({ _corrupt: true }, { columns: 120 });
  assert.match(out, /corrupt/);
});

test("render prints header + runs with expected IDs", () => {
  const state = {
    rig_version: "0.1.0",
    rig_heartbeat: new Date().toISOString(),
    concurrency: 2,
    paused: false,
    halted: false,
    daily_budget_usd: {
      spent: 4.2,
      cap: 25,
      day: new Date().toISOString().slice(0, 10),
    },
    queue: [1, 2, 3, 4, 5, 6, 7],
    runs: {
      "T0-01-fix-serve-shim": {
        status: "testing",
        tier: 0,
        attempt: 1,
        max_retries: 5,
        started_at: new Date(Date.now() - 192_000).toISOString(),
        updated_at: new Date(Date.now() - 2000).toISOString(),
        tests: { total: 5, passed: 3, failed: 0 },
        last_output: "running shim test...",
      },
      "T0-02-serve-reads-creds": {
        status: "queued",
        tier: 0,
        attempt: 0,
        max_retries: 5,
        started_at: null,
        updated_at: null,
        tests: { total: 0, passed: 0, failed: 0 },
      },
      "T1-04-cap-stringify": {
        status: "escalated",
        tier: 1,
        attempt: 5,
        max_retries: 5,
        started_at: new Date(Date.now() - 330_000).toISOString(),
        updated_at: new Date(Date.now() - 60_000).toISOString(),
        tests: { total: 5, passed: 2, failed: 3 },
        last_error: "scope_violation",
      },
    },
  };

  const out = render(state, { columns: 140 });

  // Header
  assert.match(out, /jc-rig/);
  assert.match(out, /v0\.1\.0/);
  assert.match(out, /q=7 run=1\/2/);
  assert.match(out, /today=\$4\.20\/25/);
  assert.match(out, /OK/);

  // Every run id present
  assert.match(out, /T0-01-fix-serve-shim/);
  assert.match(out, /T0-02-serve-reads-creds/);
  assert.match(out, /T1-04-cap-stringify/);

  // States
  assert.match(out, /testing/);
  assert.match(out, /queued/);
  assert.match(out, /escalated/);

  // Tail of runs (last_output / last_error)
  assert.match(out, /running shim test/);
  assert.match(out, /scope_violation/);
});

test("render shows PAUSED when state.paused is true", () => {
  const out = render(
    {
      rig_version: "0.1.0",
      rig_heartbeat: new Date().toISOString(),
      concurrency: 1,
      paused: true,
      halted: false,
      daily_budget_usd: { spent: 0, cap: 25 },
      queue: [],
      runs: {},
    },
    { columns: 120 },
  );
  assert.match(out, /PAUSED/);
});

test("render shows HALT when state.halted is true", () => {
  const out = render(
    {
      rig_version: "0.1.0",
      rig_heartbeat: new Date().toISOString(),
      concurrency: 1,
      paused: false,
      halted: true,
      daily_budget_usd: { spent: 25, cap: 25 },
      queue: [],
      runs: {},
    },
    { columns: 120 },
  );
  assert.match(out, /HALT/);
});

test("render reports empty-queue when no runs present", () => {
  const out = render(
    {
      rig_version: "0.1.0",
      rig_heartbeat: new Date().toISOString(),
      concurrency: 1,
      paused: false,
      halted: false,
      daily_budget_usd: { spent: 0, cap: 25 },
      queue: [],
      runs: {},
    },
    { columns: 120 },
  );
  assert.match(out, /no runs/);
});

test("render truncates long tail text to fit terminal width", () => {
  const longTail = "x".repeat(500);
  const state = {
    rig_version: "0.1.0",
    rig_heartbeat: new Date().toISOString(),
    concurrency: 1,
    paused: false,
    halted: false,
    daily_budget_usd: { spent: 0, cap: 25 },
    queue: [],
    runs: {
      "T0-01": {
        status: "running",
        tier: 0,
        attempt: 1,
        max_retries: 5,
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tests: { total: 0, passed: 0, failed: 0 },
        last_output: longTail,
      },
    },
  };

  // With a narrow terminal, the output line must not exceed (columns + some
  // slack for ANSI). Strip any ANSI and check line lengths.
  const out = render(state, { columns: 80 });
  const lines = out.split("\n");
  for (const line of lines) {
    const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(stripped.length <= 120, `line too long (${stripped.length}): ${stripped}`);
  }
});

test("render sorts running before queued before escalated", () => {
  const state = {
    rig_version: "0.1.0",
    rig_heartbeat: new Date().toISOString(),
    concurrency: 4,
    paused: false,
    halted: false,
    daily_budget_usd: { spent: 0, cap: 25 },
    queue: [],
    runs: {
      zzz_queued: {
        status: "queued",
        tier: 0,
        attempt: 0,
        max_retries: 5,
        started_at: null,
        updated_at: null,
        tests: { total: 0, passed: 0, failed: 0 },
      },
      aaa_escalated: {
        status: "escalated",
        tier: 0,
        attempt: 5,
        max_retries: 5,
        started_at: new Date(Date.now() - 10_000).toISOString(),
        updated_at: new Date().toISOString(),
        tests: { total: 0, passed: 0, failed: 0 },
      },
      mmm_running: {
        status: "running",
        tier: 0,
        attempt: 1,
        max_retries: 5,
        started_at: new Date(Date.now() - 10_000).toISOString(),
        updated_at: new Date().toISOString(),
        tests: { total: 0, passed: 0, failed: 0 },
      },
    },
  };
  const out = render(state, { columns: 140 });
  const iRun = out.indexOf("mmm_running");
  const iQueued = out.indexOf("zzz_queued");
  const iEsc = out.indexOf("aaa_escalated");
  assert.ok(iRun > 0 && iQueued > 0 && iEsc > 0, "all rows should be present");
  assert.ok(iRun < iEsc, "running should sort before escalated");
  assert.ok(iEsc < iQueued, "escalated should sort before queued");
});
