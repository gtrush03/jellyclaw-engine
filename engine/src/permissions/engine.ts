/**
 * Permission decision engine (Phase 08).
 *
 * This module owns the decision pipeline described in
 * `phases/PHASE-08-permissions-hooks.md` and `docs/permissions.md`. It
 * composes over the rule matcher from `./rules.js` (owned by the parallel
 * agent) and the frozen types contract in `./types.js`.
 *
 * Invariants (see SECURITY.md):
 *   - Default-deny.  An `ask` outcome with no usable handler resolves to
 *     `deny` and is audit-logged. The engine never silently allows.
 *   - Deny-wins.    A matching `deny` rule always beats any matching `allow`
 *     or `ask` rule for the same call. See the comment above Step 3.
 *   - Plan-mode.    Side-effectful tools are refused outright in plan mode,
 *     regardless of rules.  `bypassPermissions` is the ONLY escape hatch.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HookRunResult } from "../hooks/types.js";
import { firstMatch } from "./rules.js";
import {
  type AskHandler,
  type AskHandlerResult,
  type CompiledPermissions,
  type DecideOptions,
  EDIT_TOOLS,
  INTERACTIVE_TOOLS,
  type PermissionAuditEntry,
  type PermissionDecision,
  type PermissionRule,
  READ_ONLY_TOOLS,
  type ToolCall,
} from "./types.js";

/**
 * Default side-effect classifier. A call is side-effect-free iff
 *   (a) its tool name is in `READ_ONLY_TOOLS`, OR
 *   (b) it is an MCP tool whose FQN is tagged `"readonly"` in
 *       `permissions.mcpTools`.
 * Unknown MCP tools are treated as side-effectful — default-deny for plan.
 */
export function defaultIsSideEffectFree(call: ToolCall, permissions: CompiledPermissions): boolean {
  if (READ_ONLY_TOOLS.has(call.name)) return true;
  if (call.name.startsWith("mcp__")) {
    return permissions.mcpTools[call.name] === "readonly";
  }
  return false;
}

/**
 * Default audit sink: JSON-line append to `~/.jellyclaw/logs/permissions.jsonl`.
 * Creates the directory recursively on first use. Exported for tests that
 * want to assert behaviour; in practice an in-memory sink is injected.
 */
export function defaultAuditSink(entry: PermissionAuditEntry): void {
  const dir = join(homedir(), ".jellyclaw", "logs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "permissions.jsonl");
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Shallow-clone `input` and replace every occurrence of each secret in any
 * string value with `[REDACTED]`. Longest-first so superstrings win over
 * their prefixes. This mirrors the strategy in
 * `engine/src/mcp/credential-strip.ts` — we deliberately inline a small
 * version here to avoid a dependency cycle between the permissions layer
 * and the MCP layer.
 */
export function redactInputForAudit(
  input: Readonly<Record<string, unknown>>,
  secrets: readonly string[] | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  if (!secrets || secrets.length === 0) return out;

  const kept = [...new Set(secrets.filter((s) => typeof s === "string" && s.length >= 6))];
  if (kept.length === 0) return out;
  kept.sort((a, b) => b.length - a.length);

  const escaped = kept.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(escaped, "g");

  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string") {
      out[k] = v.replace(re, "[REDACTED]");
    }
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emit(
  audit: (entry: PermissionAuditEntry) => void,
  call: ToolCall,
  perms: CompiledPermissions,
  sessionId: string,
  decision: PermissionDecision,
  reason: string,
  secrets: readonly string[] | undefined,
  ruleMatched?: string,
): void {
  const entry: PermissionAuditEntry = {
    ts: nowIso(),
    sessionId,
    mode: perms.mode,
    tool: call.name,
    input: redactInputForAudit(call.input, secrets),
    decision,
    ...(ruleMatched !== undefined ? { ruleMatched } : {}),
    reason,
  };
  try {
    audit(entry);
  } catch {
    // Never let a broken audit sink turn a deny into a throw — swallow and
    // rely on the caller's logger for visibility.
  }
}

async function invokeAsk(
  handler: AskHandler | undefined,
  call: ToolCall,
  perms: CompiledPermissions,
  reason: string,
  matchedRule?: PermissionRule,
): Promise<"allow" | "deny"> {
  if (handler === undefined) return "deny";
  try {
    const ctx = matchedRule
      ? { reason, mode: perms.mode, matchedRule }
      : { reason, mode: perms.mode };
    const result = await handler(call, ctx);
    // Handle the answer variant — only valid for AskUserQuestion.
    // For all other tools, answer collapses to deny.
    if (typeof result === "object" && result.kind === "answer") {
      return call.name === "AskUserQuestion" ? "allow" : "deny";
    }
    return result === "allow" ? "allow" : "deny";
  } catch {
    return "deny";
  }
}

/**
 * Invoke the askHandler and return the full result including answer text.
 * Used by AskUserQuestion to get the user's free-text response.
 */
export async function invokeAskForAnswer(
  handler: AskHandler | undefined,
  call: ToolCall,
  perms: CompiledPermissions,
  reason: string,
): Promise<AskHandlerResult> {
  if (handler === undefined) return "deny";
  try {
    const ctx = { reason, mode: perms.mode };
    return await handler(call, ctx);
  } catch {
    return "deny";
  }
}

/**
 * Resolve a `ToolCall` to a terminal `"allow"` or `"deny"` decision.
 *
 * Pipeline order (deny-wins invariant enforced at Step 3):
 *   1. `bypassPermissions` → allow.
 *   2. `plan` + side-effectful → deny.
 *   3. First matching `deny` rule → deny.
 *   4. First matching `ask`  rule → run askHandler.
 *   5. First matching `allow` rule → allow.
 *   6. Mode fall-through (no rule matched).
 */
export async function decide(opts: DecideOptions): Promise<PermissionDecision> {
  const call = opts.call;
  const perms = opts.permissions;
  const sessionId = opts.sessionId;
  const secrets = opts.secrets;
  const audit = opts.audit ?? defaultAuditSink;
  const isSEF = opts.isSideEffectFree ?? defaultIsSideEffectFree;
  const sideEffectFree = isSEF(call, perms);

  // Step 1 — bypass is the highest-priority escape hatch.
  if (perms.mode === "bypassPermissions") {
    emit(audit, call, perms, sessionId, "allow", "mode:bypassPermissions", secrets);
    return "allow";
  }

  // Step 2 — plan-mode refusal of any side-effectful tool.
  if (perms.mode === "plan" && !sideEffectFree) {
    emit(audit, call, perms, sessionId, "deny", "mode:plan side-effectful tool", secrets);
    return "deny";
  }

  // Step 2.5 — INTERACTIVE_TOOLS always go through ask, skip deny-rule matching.
  // These tools have no side effects beyond "render the question" so they bypass
  // the deny-wins invariant and always invoke the askHandler.
  if (INTERACTIVE_TOOLS.has(call.name)) {
    const decision = await invokeAsk(opts.askHandler, call, perms, "interactive-tool");
    emit(audit, call, perms, sessionId, decision, "interactive-tool (asked)", secrets);
    return decision;
  }

  // Step 3 — DENY-WINS INVARIANT.
  // A matching `deny` rule always beats any matching `allow` or `ask` rule
  // for the same call. This is covered by the "deny-wins regression" test in
  // `engine.test.ts` — do not reorder these steps.
  const denyHit = firstMatch(perms.rules, call, "deny");
  if (denyHit) {
    emit(audit, call, perms, sessionId, "deny", `rule:${denyHit.source}`, secrets, denyHit.source);
    return "deny";
  }

  // Step 4 — ask rules. Per spec: deny > ask > allow class priority; so if
  // an ask rule matches we go to the ask flow even when an allow rule also
  // matches.
  const askHit = firstMatch(perms.rules, call, "ask");
  if (askHit) {
    const decision = await invokeAsk(opts.askHandler, call, perms, `rule:${askHit.source}`, askHit);
    emit(
      audit,
      call,
      perms,
      sessionId,
      decision,
      `rule:${askHit.source} (asked)`,
      secrets,
      askHit.source,
    );
    return decision;
  }

  // Step 5 — allow rules.
  const allowHit = firstMatch(perms.rules, call, "allow");
  if (allowHit) {
    emit(
      audit,
      call,
      perms,
      sessionId,
      "allow",
      `rule:${allowHit.source}`,
      secrets,
      allowHit.source,
    );
    return "allow";
  }

  // Step 6 — mode default fall-through when no rule matched.
  switch (perms.mode) {
    case "default": {
      if (READ_ONLY_TOOLS.has(call.name)) {
        emit(audit, call, perms, sessionId, "allow", "mode-default:readonly", secrets);
        return "allow";
      }
      const decision = await invokeAsk(opts.askHandler, call, perms, "mode:default");
      emit(audit, call, perms, sessionId, decision, "mode:default (asked)", secrets);
      return decision;
    }
    case "acceptEdits": {
      if (READ_ONLY_TOOLS.has(call.name)) {
        emit(audit, call, perms, sessionId, "allow", "mode-acceptEdits:readonly", secrets);
        return "allow";
      }
      if (EDIT_TOOLS.has(call.name)) {
        emit(audit, call, perms, sessionId, "allow", "mode:acceptEdits", secrets);
        return "allow";
      }
      const decision = await invokeAsk(opts.askHandler, call, perms, "mode:acceptEdits");
      emit(audit, call, perms, sessionId, decision, "mode:acceptEdits (asked)", secrets);
      return decision;
    }
    case "plan": {
      // Reaching here means the tool was classified side-effect-free; allow.
      emit(audit, call, perms, sessionId, "allow", "mode:plan readonly", secrets);
      return "allow";
    }
  }
}

/**
 * Options for {@link decideWithHooks}. Extends {@link DecideOptions} with
 * an optional pre-tool-use hook runner.
 *
 * The hook contract:
 *   - `"deny"`    — authoritative; the call is denied even in
 *                   `bypassPermissions` mode.
 *   - `"modify"`  — the (possibly mutated) `toolInput` replaces the
 *                   original for the rest of the pipeline.
 *   - `"allow"`   — ADVISORY ONLY. Does not override later deny rules;
 *                   we downgrade it to neutral and let rule evaluation
 *                   decide. Documented + tested.
 *   - `"neutral"` — proceed as if no hook fired.
 *
 * Note that hooks are NOT invoked on the plan-mode side-effect refusal
 * path — that denial is unconditional and observing it via a hook would
 * leak the attempted call into user-supplied code.
 */
export interface DecideWithHooksOptions extends DecideOptions {
  /**
   * Optional PreToolUse hook runner. When provided and the call is not
   * short-circuited by plan mode, this runs BEFORE rule evaluation.
   * Must resolve; must NOT throw (runner swallows errors into neutral).
   */
  readonly preToolHook?: (call: ToolCall) => Promise<HookRunResult<"PreToolUse">>;
  /** Correlation id for logs / payloads (opaque to this layer). */
  readonly callId?: string;
}

/**
 * Decide a tool call with an optional PreToolUse hook composed in.
 *
 * Pipeline:
 *   1. `bypassPermissions` — STILL run the hook; hook-deny beats bypass.
 *      Otherwise bypass allows. (Belt-and-suspenders per SECURITY.md.)
 *   2. `plan` + side-effectful → deny WITHOUT invoking the hook.
 *   3. Run the hook:
 *        - deny    → deny (authoritative)
 *        - modify  → replace call input, continue to rule evaluation
 *        - allow   → advisory; downgraded to neutral
 *        - neutral → continue
 *   4. Delegate to `decide()` with the (possibly modified) call.
 *
 * The existing `decide()` signature and behavior are unchanged — this is
 * a pure superset. Callers that don't need hooks should keep calling
 * `decide()` directly.
 */
export async function decideWithHooks(opts: DecideWithHooksOptions): Promise<PermissionDecision> {
  const audit = opts.audit ?? defaultAuditSink;
  const secrets = opts.secrets;
  const perms = opts.permissions;
  const sessionId = opts.sessionId;
  const isSEF = opts.isSideEffectFree ?? defaultIsSideEffectFree;
  const sideEffectFree = isSEF(opts.call, perms);

  // Step 2 (early) — plan-mode refusal. Hook NOT invoked.
  // Run BEFORE bypass because bypass wins only if hook didn't deny — but
  // plan mode is a different dimension that never combines with hooks.
  if (perms.mode === "plan" && !sideEffectFree) {
    emit(audit, opts.call, perms, sessionId, "deny", "mode:plan side-effectful tool", secrets);
    return "deny";
  }

  // Step 3 — invoke the hook (if any) on the original call. We need its
  // decision BEFORE we can honour bypassPermissions.
  let effectiveCall: ToolCall = opts.call;
  if (opts.preToolHook) {
    const result = await opts.preToolHook(opts.call);
    if (result.decision === "deny") {
      emit(
        audit,
        opts.call,
        perms,
        sessionId,
        "deny",
        `hook:${result.denyingHookName ?? "unknown"}${result.reason ? ` (${result.reason})` : ""}`,
        secrets,
      );
      return "deny";
    }
    if (result.decision === "modify" && result.modified) {
      const modifiedInput = result.modified.toolInput;
      effectiveCall = { name: opts.call.name, input: modifiedInput };
    }
    // "allow" is advisory — downgraded to neutral.
    // "neutral" — proceed.
  }

  // Step 1 (now safe) — bypassPermissions, hook did not deny.
  if (perms.mode === "bypassPermissions") {
    emit(audit, effectiveCall, perms, sessionId, "allow", "mode:bypassPermissions", secrets);
    return "allow";
  }

  // Step 4 — delegate to decide() with the (possibly modified) call.
  // Rebuild a clean DecideOptions; do not mutate the caller's input.
  const delegated: DecideOptions = {
    call: effectiveCall,
    permissions: perms,
    sessionId,
    ...(opts.askHandler !== undefined ? { askHandler: opts.askHandler } : {}),
    ...(opts.isSideEffectFree !== undefined ? { isSideEffectFree: opts.isSideEffectFree } : {}),
    ...(opts.audit !== undefined ? { audit: opts.audit } : {}),
    ...(opts.secrets !== undefined ? { secrets: opts.secrets } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  };
  return decide(delegated);
}
