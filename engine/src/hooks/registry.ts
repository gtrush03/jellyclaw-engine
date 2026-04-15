/**
 * Hook registry + aggregate `runHooks()` dispatcher (Phase 08.02).
 *
 * Compile-once, dispatch-many. User-declared `HookConfig`s are turned into
 * `CompiledHook`s at `new HookRegistry(...)`. Invalid configs never throw —
 * they collect into `registry.warnings` so one bad entry does not brick the
 * whole engine.
 *
 * Matcher semantics (mirrored from the phase doc):
 *  - Undefined matcher → match-all for that event kind.
 *  - PreToolUse / PostToolUse → `Tool` or `Tool(pattern)`, parsed with the
 *    same grammar as permissions rules (reused from `../permissions/rules.js`).
 *  - UserPromptSubmit → picomatch against the first 256 chars of the prompt.
 *  - All other kinds → matcher IGNORED + a warning is recorded.
 *  - Invalid grammar → warning; compiled `match()` returns false so the hook
 *    never fires (safer than accidental match-all).
 *
 * Test seam: `runHooks` delegates to `runHooksWith(runner, opts)` where
 * `runner` defaults to `runSingleHook` from `./runner.js`. Tests call
 * `runHooksWith` directly with an in-memory recorder. We chose this over a
 * hidden `_runner?` parameter on `runHooks` because:
 *   1. `RunHooksOptions` is defined in the frozen `types.ts` — we cannot add
 *      a new field there.
 *   2. The two-function surface keeps the production entry point
 *      (`runHooks`) identical to the public docs while still allowing DI.
 */

import picomatch from "picomatch";
import type { Logger } from "../logger.js";
import { parseRule } from "../permissions/rules.js";
import type { PermissionRuleWarning, ToolCall } from "../permissions/types.js";
import type {
  CompiledHook,
  HookAuditEntry,
  HookConfig,
  HookEvent,
  HookEventKind,
  HookEventMap,
  HookOutcome,
  HookRunResult,
  RunHooksOptions,
} from "./types.js";
import { ALL_HOOK_EVENTS, MODIFIABLE_EVENTS } from "./types.js";

// ---------------------------------------------------------------------------
// Signature of the single-hook runner. Matches what `./runner.ts` exports.
// ---------------------------------------------------------------------------

export interface RunSingleHookRunnerOptions {
  readonly logger?: Logger;
  readonly defaultTimeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly signal?: AbortSignal;
}

export type RunSingleHookFn = <K extends HookEventKind>(
  hook: CompiledHook,
  event: HookEvent & { readonly kind: K },
  sessionId: string,
  opts?: RunSingleHookRunnerOptions,
) => Promise<HookOutcome<K>>;

// ---------------------------------------------------------------------------
// Matcher construction
// ---------------------------------------------------------------------------

const PROMPT_MATCH_HEAD_BYTES = 256;
const PICOMATCH_OPTS = { dot: true, nonegate: true } as const;

const TOOL_EVENTS: ReadonlySet<HookEventKind> = new Set(["PreToolUse", "PostToolUse"]);

function isKnownEventKind(kind: string): kind is HookEventKind {
  return (ALL_HOOK_EVENTS as readonly string[]).includes(kind);
}

function eventToToolCall(event: HookEvent): ToolCall | null {
  if (event.kind === "PreToolUse" || event.kind === "PostToolUse") {
    return { name: event.payload.toolName, input: event.payload.toolInput };
  }
  return null;
}

interface MatcherBuild {
  readonly match: (event: HookEvent) => boolean;
  readonly warning?: string;
}

function buildMatcher(config: HookConfig, hookName: string): MatcherBuild {
  const { event: kind, matcher } = config;

  // Unknown event — compile as no-op match (registry also records a warning
  // for the unknown kind itself).
  if (!isKnownEventKind(kind)) {
    return { match: () => false };
  }

  if (matcher === undefined) {
    return { match: (event) => event.kind === kind };
  }

  if (TOOL_EVENTS.has(kind)) {
    // Reuse permissions rule grammar. We wrap in a fake rule-class since
    // parseRule requires one.
    const parsed = parseRule(matcher, "allow");
    if ("match" in parsed) {
      const pred = parsed.match;
      return {
        match: (event) => {
          if (event.kind !== kind) return false;
          const call = eventToToolCall(event);
          if (call === null) return false;
          return pred(call);
        },
      };
    }
    const warn = (parsed as PermissionRuleWarning).reason;
    return {
      match: () => false,
      warning: `[${hookName}] invalid matcher "${matcher}" for ${kind}: ${warn}`,
    };
  }

  if (kind === "UserPromptSubmit") {
    try {
      const isMatch = picomatch(matcher, PICOMATCH_OPTS);
      return {
        match: (event) => {
          if (event.kind !== "UserPromptSubmit") return false;
          const head = event.payload.prompt.slice(0, PROMPT_MATCH_HEAD_BYTES);
          return isMatch(head);
        },
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        match: () => false,
        warning: `[${hookName}] invalid matcher "${matcher}" for UserPromptSubmit: ${reason}`,
      };
    }
  }

  // Other events — matcher is meaningless. Behave as match-all + warn.
  return {
    match: (event) => event.kind === kind,
    warning: `[${hookName}] matcher "${matcher}" is ignored for event kind ${kind} (not supported)`,
  };
}

function defaultHookName(config: HookConfig, index: number): string {
  if (config.name !== undefined && config.name.length > 0) return config.name;
  return `${config.command}#${index}`;
}

// ---------------------------------------------------------------------------
// HookRegistry
// ---------------------------------------------------------------------------

export interface HookRegistryOptions {
  readonly logger?: Logger;
}

export class HookRegistry {
  readonly #compiled: readonly CompiledHook[];
  readonly #warnings: readonly string[];
  readonly #logger: Logger | undefined;

  constructor(configs: readonly HookConfig[], opts: HookRegistryOptions = {}) {
    const compiled: CompiledHook[] = [];
    const warnings: string[] = [];

    configs.forEach((config, idx) => {
      const name = defaultHookName(config, idx);

      if (!isKnownEventKind(config.event)) {
        warnings.push(`[${name}] unknown event kind "${config.event}" — hook disabled`);
        compiled.push({ config, name, match: () => false });
        return;
      }

      const built = buildMatcher(config, name);
      if (built.warning !== undefined) warnings.push(built.warning);
      compiled.push({ config, name, match: built.match });
    });

    this.#compiled = compiled;
    this.#warnings = warnings;
    this.#logger = opts.logger;

    if (this.#logger !== undefined) {
      for (const w of warnings) this.#logger.warn({ warning: w }, "hook-registry: compile warning");
    }
  }

  get all(): readonly CompiledHook[] {
    return this.#compiled;
  }

  get warnings(): readonly string[] {
    return this.#warnings;
  }

  hooksFor<K extends HookEventKind>(
    event: HookEvent & { readonly kind: K },
  ): readonly CompiledHook[] {
    const out: CompiledHook[] = [];
    for (const hook of this.#compiled) {
      if (hook.config.event !== event.kind) continue;
      if (hook.match(event)) out.push(hook);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// Aggregate dispatcher
// ---------------------------------------------------------------------------

function noopAudit(_entry: HookAuditEntry): void {
  // intentionally empty default
}

function outcomeToAuditEntry<K extends HookEventKind>(
  outcome: HookOutcome<K>,
  sessionId: string,
): HookAuditEntry {
  return {
    ts: new Date().toISOString(),
    event: outcome.event,
    sessionId,
    hookName: outcome.hookName,
    decision: outcome.decision,
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    ...(outcome.timedOut ? { timedOut: outcome.timedOut } : {}),
    ...(outcome.warn !== undefined ? { warn: outcome.warn } : {}),
  };
}

function stubNonBlockingOutcome(hook: CompiledHook, eventKind: HookEventKind): HookOutcome {
  return {
    hookName: hook.name,
    event: eventKind,
    decision: "neutral",
    durationMs: 0,
    exitCode: null,
    timedOut: false,
    warn: "blocking=false",
  };
}

/**
 * Testable form of `runHooks`. Production callers should prefer `runHooks`,
 * which delegates here with the real `runSingleHook`.
 */
export async function runHooksWith<K extends HookEventKind>(
  runner: RunSingleHookFn,
  opts: RunHooksOptions<K>,
): Promise<HookRunResult<K>> {
  const { event, sessionId, hooks } = opts;
  const audit = opts.audit ?? noopAudit;
  const outcomes: HookOutcome<K>[] = [];

  let denyIndex = -1;
  let firstDeny: HookOutcome<K> | undefined;
  let lastModify: HookOutcome<K> | undefined;
  let sawAllow = false;

  for (const hook of hooks) {
    const blocking = hook.config.blocking;
    const isNonBlockingPostToolUse = event.kind === "PostToolUse" && blocking === false;

    const runnerOpts: RunSingleHookRunnerOptions = {
      ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
      ...(opts.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: opts.defaultTimeoutMs } : {}),
      ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    };

    if (isNonBlockingPostToolUse) {
      // Fire-and-forget: kick off without awaiting. Still audit the stub so
      // the per-event line count matches declarations.
      const stub = stubNonBlockingOutcome(hook, event.kind) as HookOutcome<K>;
      outcomes.push(stub);
      audit(outcomeToAuditEntry(stub, sessionId));

      // Launch and swallow errors — the runner's own audit plumbing will log
      // the real outcome but we must not await or otherwise block the
      // aggregate result.
      void (
        runner as (
          h: CompiledHook,
          e: HookEvent,
          s: string,
          o?: RunSingleHookRunnerOptions,
        ) => Promise<HookOutcome>
      )(hook, event, sessionId, runnerOpts).catch(() => {
        /* swallowed — non-blocking */
      });
      continue;
    }

    // Blocking path — sequential by design so deny-wins + last-modify-wins
    // resolve in declaration order.
    const call = runner as (
      h: CompiledHook,
      e: HookEvent,
      s: string,
      o?: RunSingleHookRunnerOptions,
    ) => Promise<HookOutcome<K>>;
    const outcome = await call(hook, event, sessionId, runnerOpts);
    outcomes.push(outcome);
    audit(outcomeToAuditEntry(outcome, sessionId));

    if (outcome.decision === "deny" && firstDeny === undefined) {
      firstDeny = outcome;
      denyIndex = outcomes.length - 1;
    } else if (outcome.decision === "modify") {
      lastModify = outcome;
    } else if (outcome.decision === "allow") {
      sawAllow = true;
    }
  }

  // Compose.
  if (firstDeny !== undefined) {
    void denyIndex;
    const base = {
      event: event.kind,
      outcomes,
      decision: "deny" as const,
      denyingHookName: firstDeny.hookName,
    };
    return firstDeny.reason !== undefined ? { ...base, reason: firstDeny.reason } : base;
  }

  if (lastModify !== undefined && MODIFIABLE_EVENTS.has(event.kind)) {
    // Non-MODIFIABLE events should never surface a "modify" outcome — the
    // runner downgrades them. We still guard here.
    const modified = lastModify.modified as HookEventMap[K] | undefined;
    if (modified !== undefined) {
      return {
        event: event.kind,
        outcomes,
        decision: "modify",
        modified,
      };
    }
  }

  if (sawAllow) {
    return { event: event.kind, outcomes, decision: "allow" };
  }

  return { event: event.kind, outcomes, decision: "neutral" };
}

/**
 * Production entry point. Dispatches all matching hooks for `opts.event` in
 * declaration order, composes their decisions per the deny-wins /
 * last-modify-wins rules documented on `HookRunResult`, and returns the
 * aggregate.
 */
export async function runHooks<K extends HookEventKind>(
  opts: RunHooksOptions<K>,
): Promise<HookRunResult<K>> {
  const { runSingleHook } = await import("./runner.js");
  return runHooksWith(runSingleHook as unknown as RunSingleHookFn, opts);
}
