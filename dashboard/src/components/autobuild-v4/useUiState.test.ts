/**
 * Unit tests for autobuild-v4/useUiState.ts — the pure `deriveUiState`
 * function. Mirrors the fixture helpers from `bucketize.test.ts` so tests
 * read the same way across the module.
 *
 * Covers every branch of the UiState union:
 *   - empty        — rig offline + no history
 *   - idle         — rig online + 0 running, or rig offline + history
 *   - running      — rig online + ≥1 in-flight
 *   - all-complete — every managed prompt landed in `state.completed`
 *
 * No DOM, no network. Discovered by vitest via the glob in vitest.config.ts.
 */

import { describe, expect, it } from "vitest";
import { deriveUiState } from "./useUiState";
import type { Prompt, RigProcessStatus, RigState, RunRecord, Tier } from "@/types";

// ---------------------------------------------------------------------------
// Fixtures — identical in spirit to bucketize.test.ts.
// ---------------------------------------------------------------------------

function prompt(id: string, tier: Tier | undefined): Prompt {
  return {
    id,
    phase: 99,
    phaseId: "99b-unfucking-v2",
    subPrompt: id,
    title: id,
    whenToRun: "",
    duration: "",
    newSession: false,
    model: "",
    filePath: `prompts/${id}.md`,
    status: "not-started",
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

function procStatus(running: boolean): RigProcessStatus {
  return {
    running,
    pid: running ? 42 : null,
    since: running ? "2026-04-17T08:00:00Z" : null,
    log_path: running ? "/logs/dispatcher.jsonl" : null,
  };
}

function rig(overrides: Partial<RigState> & { rigRunning?: boolean } = {}): RigState {
  const { rigRunning, ...rest } = overrides;
  const base: RigState = {
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
    rig_process: procStatus(rigRunning ?? false),
    ...rest,
  };
  return base;
}

// ---------------------------------------------------------------------------
// empty — no state, or rig offline + zero history
// ---------------------------------------------------------------------------

describe("deriveUiState — empty", () => {
  it("returns empty when state is null", () => {
    expect(deriveUiState(null, null)).toEqual({ kind: "empty" });
  });

  it("returns empty when state is undefined", () => {
    expect(deriveUiState(undefined, undefined)).toEqual({ kind: "empty" });
  });

  it("returns empty when rig offline and no runs / completed / escalated", () => {
    const state = rig({ rigRunning: false });
    expect(deriveUiState(state, [])).toEqual({ kind: "empty" });
  });

  it("does NOT return empty when rig offline but history exists", () => {
    const state = rig({
      rigRunning: false,
      completed: ["T0-02-x"],
    });
    const out = deriveUiState(state, []);
    expect(out.kind).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// idle — rig online with 0 in-flight, or rig offline with history
// ---------------------------------------------------------------------------

describe("deriveUiState — idle", () => {
  it("rig online + 0 running runs → idle, hasHistory=false", () => {
    const state = rig({ rigRunning: true });
    const out = deriveUiState(state, []);
    expect(out).toEqual({ kind: "idle", hasHistory: false });
  });

  it("rig online + 0 running + completed history → idle, hasHistory=true", () => {
    const state = rig({
      rigRunning: true,
      completed: ["T0-02-x"],
    });
    expect(deriveUiState(state, [])).toEqual({
      kind: "idle",
      hasHistory: true,
    });
  });

  it("rig offline + history → idle, hasHistory=true", () => {
    const state = rig({
      rigRunning: false,
      runs: { "T0-04-x": run({ status: "failed" }) },
    });
    expect(deriveUiState(state, [])).toEqual({
      kind: "idle",
      hasHistory: true,
    });
  });

  it("rig online with only a queued (not running) run is still idle", () => {
    const state = rig({
      rigRunning: true,
      runs: { "T0-02-x": run({ status: "queued" }) },
      queue: ["T0-02-x"],
    });
    expect(deriveUiState(state, []).kind).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// running — rig online with at least one in-flight run
// ---------------------------------------------------------------------------

describe("deriveUiState — running", () => {
  it("rig online + one working run → running with that run as currentRun", () => {
    const state = rig({
      rigRunning: true,
      runs: {
        "T0-02-x": run({
          status: "working",
          updated_at: "2026-04-17T10:00:00.000Z",
        }),
      },
    });
    const out = deriveUiState(state, []);
    expect(out.kind).toBe("running");
    if (out.kind === "running") {
      expect(out.currentRun.id).toBe("T0-02-x");
      expect(out.currentRun.status).toBe("working");
    }
  });

  it("picks the most-recently-updated run when two are in-flight", () => {
    const state = rig({
      rigRunning: true,
      runs: {
        "T0-02-x": run({
          status: "working",
          updated_at: "2026-04-17T09:00:00.000Z",
        }),
        "T0-03-y": run({
          status: "testing",
          updated_at: "2026-04-17T10:00:00.000Z",
        }),
      },
    });
    const out = deriveUiState(state, []);
    expect(out.kind).toBe("running");
    if (out.kind === "running") {
      expect(out.currentRun.id).toBe("T0-03-y");
    }
  });
});

// ---------------------------------------------------------------------------
// all-complete — every managed prompt has landed in state.completed
// ---------------------------------------------------------------------------

describe("deriveUiState — all-complete", () => {
  it("returns all-complete when every tiered prompt is in state.completed", () => {
    const prompts: Prompt[] = [prompt("T0-02-x", 0), prompt("T0-03-y", 0)];
    const state = rig({
      rigRunning: true,
      completed: ["T0-02-x", "T0-03-y"],
    });
    expect(deriveUiState(state, prompts)).toEqual({ kind: "all-complete" });
  });

  it("does NOT return all-complete when one prompt is still missing", () => {
    const prompts: Prompt[] = [prompt("T0-02-x", 0), prompt("T0-03-y", 0)];
    const state = rig({
      rigRunning: true,
      completed: ["T0-02-x"],
    });
    const out = deriveUiState(state, prompts);
    expect(out.kind).not.toBe("all-complete");
  });

  it("ignores non-tiered (legacy) prompts when deciding all-complete", () => {
    const prompts: Prompt[] = [
      prompt("T0-02-x", 0),
      // legacy non-autobuild prompt — no tier. Should not block "all-complete".
      prompt("phase-01/01-foo", undefined),
    ];
    const state = rig({
      rigRunning: true,
      completed: ["T0-02-x"],
    });
    expect(deriveUiState(state, prompts)).toEqual({ kind: "all-complete" });
  });

  it("does not return all-complete when prompts list is empty", () => {
    const state = rig({
      rigRunning: true,
      completed: ["T0-02-x"],
    });
    expect(deriveUiState(state, []).kind).not.toBe("all-complete");
  });
});
