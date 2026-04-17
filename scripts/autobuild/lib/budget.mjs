// budget.mjs — per-session + per-day cost tracking.
//
// Claude Code's stream-json emits usage records per turn. We parse events.ndjson
// for any line with a { type: "result" } or { type: "usage.updated", ... }
// shape, extract cost_usd (or compute from tokens using a model→USD table),
// and sum.
//
// Gates (enforced by the dispatcher poll loop):
//   $5  → self-check: ask a plain `claude -p` one-turn query whether the
//         worker should continue. Fail closed (treat as "escalate") on parse
//         error. Records the verdict in state.runs[id].self_check.
//   $10 → hard kill the tmux worker session (the rig refuses to keep spending).
//   daily $25 → pause the dispatcher (no new spawns). In-flight runs finish.

import { readFileSync, existsSync } from "node:fs";
import { execa } from "execa";

export const SOFT_SELF_CHECK_USD = 5;
export const HARD_KILL_USD = 10;
export const DAILY_CAP_DEFAULT = 25;

// Token → USD table (prices per 1M tokens). Approximate but fine for
// guardrails: when the model is unknown we fall back to Opus rates so we err
// toward stopping early.
export const MODEL_COST_TABLE = [
  { match: /claude-opus/i, input_per_m: 15, output_per_m: 75 },
  { match: /claude-sonnet/i, input_per_m: 3, output_per_m: 15 },
  { match: /claude-haiku/i, input_per_m: 0.8, output_per_m: 4 },
];
export const DEFAULT_RATE = { input_per_m: 15, output_per_m: 75 };

/**
 * Look up the per-million input+output rate for a model name. Unknown models
 * fall back to Opus (conservative overestimate).
 */
export function rateForModel(modelName) {
  if (!modelName || typeof modelName !== "string") return DEFAULT_RATE;
  for (const entry of MODEL_COST_TABLE) {
    if (entry.match.test(modelName)) {
      return { input_per_m: entry.input_per_m, output_per_m: entry.output_per_m };
    }
  }
  return DEFAULT_RATE;
}

/**
 * Compute USD cost for a usage record (input + output token counts).
 * Cache-read and cache-creation tokens, when present, are billed at the
 * output rate as a conservative upper bound.
 */
export function computeCostFromTokens(usage, modelName) {
  if (!usage || typeof usage !== "object") return 0;
  const rate = rateForModel(modelName);
  const input = Number(usage.input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0);
  const cacheRead = Number(usage.cache_read_input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const cost =
    (input * rate.input_per_m) / 1_000_000 +
    (cacheRead * rate.input_per_m * 0.1) / 1_000_000 + // cache reads ≈ 10% of input
    (output * rate.output_per_m) / 1_000_000;
  return cost;
}

/**
 * Read events.ndjson and sum the cost reported by the Claude CLI.
 *
 * Precedence:
 *   1. If a `{ type: "result", total_cost_usd: N }` line is present, return N
 *      (this is the authoritative session-end total).
 *   2. Otherwise sum any per-turn `cost_usd` floats seen inline.
 *   3. Otherwise sum `computeCostFromTokens(usage, model)` from every
 *      `{ type: "usage.updated" | "assistant" | "message", usage, model }`
 *      record. Useful for live mid-run polling where no `result` has arrived.
 */
export function sumCostFromEventsFile(eventsPath) {
  if (!existsSync(eventsPath)) return { cost_usd: 0, turns_used: 0 };
  const raw = readFileSync(eventsPath, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  let cost = 0;
  let turns = 0;
  let finalCost = null;
  let tokenCost = 0;
  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === "result" && typeof obj.total_cost_usd === "number") {
      finalCost = obj.total_cost_usd;
    }
    if (typeof obj?.cost_usd === "number") cost += obj.cost_usd;
    if (obj?.type === "assistant" || obj?.type === "message") turns += 1;
    // Mid-run token-based estimate.
    if (obj?.usage && typeof obj.usage === "object") {
      const model = obj.model || obj.message?.model;
      tokenCost += computeCostFromTokens(obj.usage, model);
    }
  }
  // Prefer authoritative > inline cost_usd > token estimate.
  let resolved;
  if (finalCost !== null) resolved = finalCost;
  else if (cost > 0) resolved = cost;
  else resolved = tokenCost;
  return { cost_usd: resolved, turns_used: turns };
}

/**
 * Self-check gate at $5. Calls `claude -p` with a tight single-turn prompt and
 * parses the JSON verdict strictly. Returns:
 *   { decision: "continue" | "escalate", reason: string, raw: string|null,
 *     cost_at_gate: number, ts: ISO-8601 }
 */
export async function runSelfCheckGate({ sessionDir, currentCost, promptId, model } = {}) {
  const ts = new Date().toISOString();
  const context = [
    `prompt_id: ${promptId || "(unknown)"}`,
    `session_dir: ${sessionDir || "(unknown)"}`,
    `cost_usd so far: $${(currentCost ?? 0).toFixed(4)}`,
  ].join("\n");
  const prompt = [
    "You are a budget self-check gate for an autobuild rig.",
    "A worker has spent $5 on a single task. Should it continue?",
    "Reply ONLY with a JSON object on one line of the form:",
    '{"continue": true, "reason": "..."}',
    "",
    "Context:",
    context,
  ].join("\n");

  // Dry-run short-circuit: never call `claude`. Default to continue at low
  // cost (matches the dispatcher's dry-run cost of $0.01).
  if (process.env.AUTOBUILD_DRY_RUN === "1") {
    return {
      decision: "continue",
      reason: "dry-run: self-check skipped",
      raw: null,
      cost_at_gate: currentCost ?? 0,
      ts,
    };
  }
  // Test hook: allow unit tests to inject a verdict without spawning `claude`.
  if (process.env.AUTOBUILD_SELF_CHECK_INJECT) {
    try {
      const parsed = JSON.parse(process.env.AUTOBUILD_SELF_CHECK_INJECT);
      const decision = parsed.continue === true ? "continue" : "escalate";
      return {
        decision,
        reason: parsed.reason || `(injected) ${decision}`,
        raw: process.env.AUTOBUILD_SELF_CHECK_INJECT,
        cost_at_gate: currentCost ?? 0,
        ts,
      };
    } catch (err) {
      return {
        decision: "escalate",
        reason: `injected self-check malformed: ${err.message}`,
        raw: process.env.AUTOBUILD_SELF_CHECK_INJECT,
        cost_at_gate: currentCost ?? 0,
        ts,
      };
    }
  }

  const args = ["-p", prompt, "--output-format", "json"];
  if (model) args.push("--model", model);
  try {
    const result = await execa("claude", args, { timeout: 120_000, reject: false });
    const text = result.stdout || "";
    const match = text.match(/\{[^\n]*"continue"[^\n]*\}/);
    if (!match) {
      return {
        decision: "escalate",
        reason: "self-check: no JSON verdict found",
        raw: text,
        cost_at_gate: currentCost ?? 0,
        ts,
      };
    }
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.continue !== "boolean") {
      return {
        decision: "escalate",
        reason: "self-check: malformed JSON",
        raw: text,
        cost_at_gate: currentCost ?? 0,
        ts,
      };
    }
    return {
      decision: parsed.continue ? "continue" : "escalate",
      reason: parsed.reason || "",
      raw: text,
      cost_at_gate: currentCost ?? 0,
      ts,
    };
  } catch (err) {
    return {
      decision: "escalate",
      reason: `self-check error: ${err.message}`,
      raw: null,
      cost_at_gate: currentCost ?? 0,
      ts,
    };
  }
}

/**
 * Returns true if today's spent exceeds the cap. Rolls over the day if needed.
 */
export function dailyBudgetExceeded(state) {
  const today = new Date().toISOString().slice(0, 10);
  const b = state.daily_budget_usd || { spent: 0, cap: DAILY_CAP_DEFAULT, day: today };
  if (b.day !== today) {
    // Caller is responsible for persisting; we just report the *current* rollover.
    return false;
  }
  return b.spent >= b.cap;
}

/**
 * Returns true if (committed daily spent + in-flight current_running_cost)
 * would exceed the cap. Used mid-run to decide whether to pause the rig.
 */
export function dailyBudgetWouldExceed(state, currentRunningCost = 0) {
  const today = new Date().toISOString().slice(0, 10);
  const b = state.daily_budget_usd || { spent: 0, cap: DAILY_CAP_DEFAULT, day: today };
  if (b.day !== today) return false;
  const cap = b.cap ?? DAILY_CAP_DEFAULT;
  return (b.spent ?? 0) + (currentRunningCost ?? 0) >= cap;
}

export function rollDailyBudget(state) {
  const today = new Date().toISOString().slice(0, 10);
  const b = state.daily_budget_usd || { spent: 0, cap: DAILY_CAP_DEFAULT, day: today };
  if (b.day !== today) {
    state.daily_budget_usd = { spent: 0, cap: b.cap ?? DAILY_CAP_DEFAULT, day: today };
  } else {
    state.daily_budget_usd = b;
  }
  return state.daily_budget_usd;
}
