/**
 * Permission-engine types (Phase 08).
 *
 * This is the **rule-based tool-call gating** layer — distinct from the
 * key-based `PermissionService` under `engine/src/tools/types.ts` which only
 * answers `isAllowed(key)` for intra-tool checks (e.g. `bash.cd_escape`,
 * `write.outside_cwd`).
 *
 * At this layer we gate an entire tool call (`{ tool, input }`) against four
 * modes + three rule classes (`allow` / `ask` / `deny`). See
 * `docs/permissions.md` and `phases/PHASE-08-permissions-hooks.md`.
 */
import type { Logger } from "../logger.js";

/**
 * Four permission modes. Matches Claude Code's `--permission-mode`.
 * - `default`         — reads auto-allow; Bash/Write/Edit/other ask; rules win.
 * - `acceptEdits`     — reads auto-allow; Write/Edit auto-allow; Bash/other ask.
 * - `bypassPermissions` — every tool call allowed (audit-logged).
 * - `plan`            — no tool with observable side effects may execute.
 */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

/**
 * Three rule classes. See `docs/permissions.md` for exact semantics.
 */
export type RuleClass = "allow" | "ask" | "deny";

/**
 * Terminal decisions produced by the engine. `ask` is only produced when the
 * caller needs to prompt; the engine resolves it to `allow` or `deny` via the
 * injected ask-handler.
 */
export type PermissionDecision = "allow" | "deny" | "ask";

/**
 * Tool-call envelope passed to the engine. `input` is the arguments the model
 * produced for this tool; we never interpret it beyond what the matcher needs.
 */
export interface ToolCall {
  /** Canonical tool name — e.g. `Bash`, `Write`, `mcp__github__create_issue`. */
  readonly name: string;
  /** Raw argument record as produced by the model. */
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * Parsed permission rule — one entry in `config.permissions.{allow,ask,deny}`.
 * Rules are compiled once at load-time; see `rules.ts`.
 */
export interface PermissionRule {
  /** Source string, exactly as the user wrote it. Useful for audit + errors. */
  readonly source: string;
  /** Rule class (derived from which array the source appeared in). */
  readonly ruleClass: RuleClass;
  /** Canonical tool name (or `mcp__<server>__<tool|*>` form). */
  readonly toolName: string;
  /**
   * Optional picomatch glob on an argument string. `undefined` means "match
   * every call of this tool" (equivalent to `Tool(**)`).
   */
  readonly pattern?: string;
  /**
   * Compiled predicate. Given a `ToolCall`, returns true when the rule
   * matches. Pure; no side effects.
   */
  match(call: ToolCall): boolean;
}

/**
 * Parsed permissions block from jellyclaw.json. Produced by `rules.ts`.
 */
export interface CompiledPermissions {
  readonly mode: PermissionMode;
  readonly rules: readonly PermissionRule[];
  /** Rules that failed to parse — logged as warnings, never errors. */
  readonly warnings: readonly PermissionRuleWarning[];
  /**
   * MCP tool readonly hints. Maps fully-qualified MCP tool name (e.g.
   * `mcp__github__get_issue`) to `"readonly"` to opt it into plan mode.
   */
  readonly mcpTools: Readonly<Record<string, "readonly">>;
}

export interface PermissionRuleWarning {
  readonly source: string;
  readonly ruleClass: RuleClass;
  readonly reason: string;
}

/**
 * Interactive ask-handler. Called when the pipeline lands on `ask`. Must
 * resolve to `allow` or `deny` (never `ask`). If no handler is supplied or
 * we're in a non-TTY context, the engine treats `ask` as `deny` (never as
 * silent allow) and audit-logs the decision.
 */
export type AskHandler = (call: ToolCall, ctx: AskContext) => Promise<"allow" | "deny">;

export interface AskContext {
  readonly reason: string;
  readonly matchedRule?: PermissionRule;
  readonly mode: PermissionMode;
}

/**
 * Audit-log entry appended to `~/.jellyclaw/logs/permissions.jsonl` for every
 * decision. `input` is redacted by the engine before writing.
 */
export interface PermissionAuditEntry {
  readonly ts: string;
  readonly sessionId: string;
  readonly mode: PermissionMode;
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly decision: PermissionDecision;
  readonly ruleMatched?: string;
  readonly reason?: string;
}

/**
 * Per-call inputs to the decision pipeline.
 */
export interface DecideOptions {
  readonly call: ToolCall;
  readonly permissions: CompiledPermissions;
  readonly sessionId: string;
  /**
   * Injected ask-handler. Tests pass a deterministic one; production wires
   * `promptAskHandler()` from `prompt.ts`.
   */
  readonly askHandler?: AskHandler;
  /**
   * Injected side-effect classifier. Defaults to `defaultIsSideEffectFree`
   * from `engine.ts`. Override in tests to exercise plan mode.
   */
  readonly isSideEffectFree?: (call: ToolCall, permissions: CompiledPermissions) => boolean;
  /**
   * Append audit-log entries here. Defaults to `~/.jellyclaw/logs/permissions.jsonl`.
   * Tests inject an in-memory sink.
   */
  readonly audit?: (entry: PermissionAuditEntry) => void;
  /**
   * Secret values to redact from audited input. Usually derived from config
   * (api keys, tokens) + process env.
   */
  readonly secrets?: readonly string[];
  readonly logger?: Logger;
}

/**
 * Built-in read-only tool set — always allowed outside `bypassPermissions`/
 * plan side-effect refusal. Kept in types.ts so rule parser and engine agree.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Grep",
  "Glob",
  "LSP",
  "NotebookRead",
  "WebSearch",
]);

/**
 * Auto-allow-under-acceptEdits tool set.
 */
export const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
]);

/**
 * Hard-coded list of tools that are **always** considered side-effectful in
 * plan mode, regardless of name. Kept for clarity — anything not in
 * `READ_ONLY_TOOLS` is side-effectful by default.
 */
export const PLAN_MODE_DENY_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "Task",
  "TodoWrite",
]);
