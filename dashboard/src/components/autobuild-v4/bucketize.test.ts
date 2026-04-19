/**
 * Unit tests for autobuild-v4/bucketize.ts.
 *
 * Covers the two concrete bugs from the live-run autopsy:
 *   1. bucket counts disagreeing with the DONE column ("Completed 4" next to
 *      "0 completed" in the top strip) — see `bucketize` block.
 *   2. tier strip showing "T0 0/5" when four T0 runs have shipped — see
 *      `tierCountsV4` block. The key assertion is that we never trust
 *      `prompt.status`, only `state.runs[id].status` + `state.completed[]`.
 *
 * No DOM, no network, no React. Discovered by vitest via the
 * `src/**\/*.{test,spec}.ts` include glob.
 */

import { describe, expect, it } from "vitest";
import { bucketCounts, bucketize, progressTotal, tierCountsV4 } from "./bucketize";
import type { Prompt, RigState, RunRecord, RunStatus, Tier } from "@/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function prompt(
  id: string,
  tier: Tier | undefined,
  status: Prompt["status"] = "not-started",
): Prompt {
  return {
    id,
    phase: 99,
    phaseId: "99b-unfucking-v2",
    subPrompt: id.split("/")[1] ?? id,
    title: id,
    whenToRun: "",
    duration: "",
    newSession: false,
    model: "",
    filePath: `prompts/${id}.md`,
    status,
    tier,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    status: "queued",
    tier: 0,
    session_id: "sess-1",
    tmux_session: "ab-1",
    branch: "autobuild/x",
    started_at: null,
    updated_at: "2026-04-17T10:00:00.000Z",
    ended_at: null,
    attempt: 0,
    max_retries: 2,
    turns_used: 0,
    cost_usd: 0,
    self_check: null,
    log_path: "",
    events_path: "",
    tests: { total: 0, passed: 0, failed: 0, pending: 0 },
    commit_sha: null,
    last_error: null,
    last_retry_reason: null,
    needs_review: false,
    retry_history: [],
    ...overrides,
  };
}

function rig(overrides: Partial<RigState> = {}): RigState {
  return {
    rig_version: "0.1.0",
    rig_heartbeat: null,
    concurrency: 1,
    paused: false,
    halted: false,
    daily_budget_usd: { spent: 0, cap: 25, day: "2026-04-17" },
    runs: {},
    queue: [],
    completed: [],
    escalated: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// bucketize — one run per status lands in the right place
// ---------------------------------------------------------------------------

describe("bucketize — status → bucket mapping", () => {
  const cases: Array<{ status: RunStatus; bucket: keyof ReturnType<typeof bucketize> }> = [
    { status: "queued", bucket: "queued" },
    { status: "spawning", bucket: "running" },
    { status: "prompting", bucket: "running" },
    { status: "working", bucket: "running" },
    { status: "testing", bucket: "running" },
    { status: "completion_detected", bucket: "running" },
    { status: "retrying", bucket: "running" },
    { status: "complete", bucket: "completed" },
    { status: "passed", bucket: "completed" },
    { status: "failed", bucket: "failed" },
    { status: "escalated", bucket: "escalated" },
  ];

  for (const { status, bucket } of cases) {
    it(`routes ${status} → ${bucket}`, () => {
      const state = rig({
        runs: {
          "T0-02-x": run({ status }),
        },
      });
      const out = bucketize(state);
      expect(out[bucket].map((e) => e.runId)).toContain("T0-02-x");
    });
  }

  it("also routes self_checking (non-canonical RunStatus string) into running", () => {
    // Cast through `unknown` so we can cover the ad-hoc self-check transient
    // without loosening the RunStatus union for the whole codebase.
    const state = rig({
      runs: {
        "T0-02-x": run({ status: "self_checking" as unknown as RunStatus }),
      },
    });
    const out = bucketize(state);
    expect(out.running.map((e) => e.runId)).toContain("T0-02-x");
  });
});

// ---------------------------------------------------------------------------
// bucketize — override rules
// ---------------------------------------------------------------------------

describe("bucketize — needs_review wins over status", () => {
  it("routes a complete run with needs_review=true to review (not completed)", () => {
    const state = rig({
      runs: {
        "T0-02-x": run({ status: "complete", needs_review: true }),
      },
    });
    const out = bucketize(state);
    expect(out.review.map((e) => e.runId)).toEqual(["T0-02-x"]);
    expect(out.completed).toHaveLength(0);
  });

  it("routes a working run with needs_review=true to review (paused on human)", () => {
    const state = rig({
      runs: {
        "T0-02-x": run({ status: "working", needs_review: true }),
      },
    });
    const out = bucketize(state);
    expect(out.review.map((e) => e.runId)).toEqual(["T0-02-x"]);
    expect(out.running).toHaveLength(0);
  });
});

describe("bucketize — halted rig surfaces in-flight runs as escalated", () => {
  it("treats a working run under halted=true as escalated", () => {
    const state = rig({
      halted: true,
      runs: {
        "T0-02-x": run({ status: "working" }),
      },
    });
    const out = bucketize(state);
    expect(out.escalated.map((e) => e.runId)).toContain("T0-02-x");
    expect(out.running).toHaveLength(0);
  });

  it("does not touch queued runs when halted", () => {
    const state = rig({
      halted: true,
      runs: {
        "T0-02-x": run({ status: "queued" }),
      },
    });
    const out = bucketize(state);
    expect(out.queued.map((e) => e.runId)).toContain("T0-02-x");
    expect(out.escalated).toHaveLength(0);
  });
});

describe("bucketize — synthetic queue entries", () => {
  it("adds queue ids without run records as synthetic queued entries", () => {
    const state = rig({
      runs: {
        "T0-02-x": run({ status: "working" }),
      },
      queue: ["T0-03-y", "T0-04-z"],
    });
    const out = bucketize(state);
    expect(out.running.map((e) => e.runId)).toEqual(["T0-02-x"]);
    expect(out.queued.map((e) => e.runId).sort()).toEqual(["T0-03-y", "T0-04-z"]);
    for (const entry of out.queued) {
      expect(entry.run).toBeNull();
    }
  });

  it("does NOT double-count ids present in both state.queue and state.runs", () => {
    const state = rig({
      runs: {
        "T0-02-x": run({ status: "queued" }),
      },
      queue: ["T0-02-x"],
    });
    const out = bucketize(state);
    expect(out.queued).toHaveLength(1);
    expect(out.queued[0]?.run).not.toBeNull();
  });
});

describe("bucketize — state.completed / state.escalated authority", () => {
  it("treats ids only present in state.completed as completed entries", () => {
    const state = rig({
      runs: {},
      completed: ["T0-02-x", "T0-03-y"],
    });
    const out = bucketize(state);
    expect(out.completed.map((e) => e.runId).sort()).toEqual(["T0-02-x", "T0-03-y"]);
  });

  it("does not duplicate when the run record is already completed", () => {
    const state = rig({
      runs: {
        "T0-02-x": run({ status: "complete" }),
      },
      completed: ["T0-02-x"],
    });
    const out = bucketize(state);
    expect(out.completed).toHaveLength(1);
  });
});

describe("bucketize — empty state", () => {
  it("returns all empty buckets for null input", () => {
    const out = bucketize(null);
    expect(out.running).toEqual([]);
    expect(out.queued).toEqual([]);
    expect(out.review).toEqual([]);
    expect(out.escalated).toEqual([]);
    expect(out.completed).toEqual([]);
    expect(out.failed).toEqual([]);
  });

  it("returns all empty buckets for a fresh rig with no runs", () => {
    const out = bucketize(rig());
    expect(out.running).toEqual([]);
    expect(out.queued).toEqual([]);
    expect(out.completed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// bucketCounts — scalar pills in the top strip
// ---------------------------------------------------------------------------

describe("bucketCounts", () => {
  it("matches the live-run scenario: 4 completes surface as completed:4", () => {
    // This is the exact situation the user screenshotted. Before the fix, the
    // top strip showed `0 completed` while the left column showed `Completed 4`.
    const runs: Record<string, RunRecord> = {};
    for (const id of ["T0-02", "T0-03", "T0-04", "T0-05"]) {
      runs[id] = run({ status: "complete", tier: 0 });
    }
    const state = rig({ runs, completed: ["T0-02", "T0-03", "T0-04", "T0-05"] });
    const counts = bucketCounts(state);
    expect(counts.completed).toBe(4);
    expect(counts.running).toBe(0);
    expect(counts.queued).toBe(0);
    expect(counts.review).toBe(0);
    expect(counts.escalated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// tierCountsV4 — THE key bug fix. Counts MUST come from rig.runs, not prompt.status.
// ---------------------------------------------------------------------------

describe("tierCountsV4 — joins rig.runs into prompt list", () => {
  it("with 5 prompts in T0 and 4 runs complete, returns {done:4, total:5}", () => {
    const prompts = [
      prompt("T0-01", 0),
      prompt("T0-02", 0),
      prompt("T0-03", 0),
      prompt("T0-04", 0),
      prompt("T0-05", 0),
    ];
    const runs: Record<string, RunRecord> = {
      "T0-02": run({ status: "complete", tier: 0 }),
      "T0-03": run({ status: "complete", tier: 0 }),
      "T0-04": run({ status: "complete", tier: 0 }),
      "T0-05": run({ status: "complete", tier: 0 }),
    };
    const state = rig({ runs });
    const counts = tierCountsV4(state, prompts);
    expect(counts[0]).toMatchObject({ tier: 0, done: 4, total: 5 });
  });

  it("ignores legacy prompt.status — a prompt marked complete with no run record is NOT done", () => {
    // This is the T0 0/5 bug. Before the fix, tierCountsFromPrompts read
    // prompt.status and returned 4/5 even though no runs existed. Now we
    // require a matching rig run (or a state.completed entry) to count.
    const prompts = [
      prompt("T0-01", 0, "complete"), // phase-level says complete — should be ignored
      prompt("T0-02", 0, "complete"),
      prompt("T0-03", 0, "complete"),
      prompt("T0-04", 0, "complete"),
      prompt("T0-05", 0, "not-started"),
    ];
    const state = rig({ runs: {} });
    const counts = tierCountsV4(state, prompts);
    expect(counts[0]).toMatchObject({ tier: 0, done: 0, total: 5 });
  });

  it("counts prompt as done when state.completed lists its id (post-commit path)", () => {
    const prompts = [prompt("T0-02", 0), prompt("T0-03", 0)];
    const state = rig({
      runs: {}, // rig has pruned the in-memory run
      completed: ["T0-02"],
    });
    const counts = tierCountsV4(state, prompts);
    expect(counts[0]).toMatchObject({ done: 1, total: 2 });
  });

  it("counts prompts with status=passed as done (legacy terminal success)", () => {
    const prompts = [prompt("T1-01", 1), prompt("T1-02", 1)];
    const state = rig({
      runs: {
        "T1-01": run({ status: "passed", tier: 1 }),
      },
    });
    const counts = tierCountsV4(state, prompts);
    expect(counts[1]).toMatchObject({ done: 1, total: 2 });
  });

  it("running count = prompts with matching run in RUNNING_STATUSES", () => {
    const prompts = [prompt("T1-01", 1), prompt("T1-02", 1), prompt("T1-03", 1)];
    const state = rig({
      runs: {
        "T1-01": run({ status: "working", tier: 1 }),
        "T1-02": run({ status: "testing", tier: 1 }),
      },
    });
    const counts = tierCountsV4(state, prompts);
    expect(counts[1]).toMatchObject({ done: 0, total: 3, running: 2 });
  });

  it("excludes runs with needs_review=true from the running count", () => {
    const prompts = [prompt("T1-01", 1)];
    const state = rig({
      runs: {
        "T1-01": run({ status: "working", tier: 1, needs_review: true }),
      },
    });
    const counts = tierCountsV4(state, prompts);
    expect(counts[1]).toMatchObject({ running: 0 });
  });

  it("empty state: 0 prompts, 0 runs → all zeros per tier", () => {
    const counts = tierCountsV4(null, []);
    for (const t of [0, 1, 2, 3, 4] as const) {
      expect(counts[t]).toEqual({ tier: t, done: 0, total: 0, running: 0 });
    }
  });

  it("skips prompts with undefined tier (not yet assigned to a tier pack)", () => {
    const prompts = [prompt("misc/foo", undefined), prompt("T0-01", 0)];
    const state = rig({
      runs: {
        "T0-01": run({ status: "complete", tier: 0 }),
      },
    });
    const counts = tierCountsV4(state, prompts);
    expect(counts[0]).toMatchObject({ total: 1, done: 1 });
  });
});

// ---------------------------------------------------------------------------
// progressTotal — the "4/42" in the tier strip's right margin
// ---------------------------------------------------------------------------

describe("progressTotal", () => {
  it("sums done + total across all tiers", () => {
    const prompts = [
      prompt("T0-01", 0),
      prompt("T0-02", 0),
      prompt("T1-01", 1),
      prompt("T1-02", 1),
    ];
    const state = rig({
      runs: {
        "T0-01": run({ status: "complete", tier: 0 }),
        "T1-01": run({ status: "complete", tier: 1 }),
      },
    });
    expect(progressTotal(state, prompts)).toEqual({ done: 2, total: 4 });
  });
});
