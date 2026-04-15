/**
 * Permission-rule parser + matcher (Phase 08).
 *
 * Implements Claude Code's `Tool(pattern)` grammar for the three rule classes
 * (`allow` / `ask` / `deny`). The engine pipeline (see `engine.ts`, owned by
 * the parallel agent) consumes `CompiledPermissions` produced here.
 *
 * Grammar
 *   rule     := toolName "(" pattern ")" | toolName
 *   toolName := [A-Za-z_][A-Za-z0-9_]*
 *             | "mcp__" [a-z0-9-]+ "__" ([a-z0-9_-]+ | "*")
 *   pattern  := arbitrary text — treated as a picomatch glob against a
 *               per-tool-derived argument string (see `selectArgString`).
 *
 * picomatch options are fixed to `{ dot: true, nonegate: true }`:
 *  - `dot: true`  → `src/**` matches `src/.hidden/x` (users expect globs to
 *    cover dotfiles in a dev tool).
 *  - `nonegate: true` → a leading `!` in a pattern is treated literally; it
 *    MUST NOT invert the match. Otherwise `Bash(!rm*)` in a `deny` list would
 *    silently turn into an allow, which is a security footgun.
 *
 * Unknown built-in tool names are NOT an error — they produce a live rule so
 * that configs can reference tools that are not yet connected (e.g. an MCP
 * server not started yet). Grammar violations (bad parens, empty pattern,
 * malformed MCP naming) are collected as warnings; the rest of the block
 * still compiles.
 */

import path from "node:path";
import picomatch from "picomatch";
import type {
  CompiledPermissions,
  PermissionMode,
  PermissionRule,
  PermissionRuleWarning,
  RuleClass,
  ToolCall,
} from "./types.js";

const BUILTIN_TOOL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MCP_TOOL_RE = /^mcp__[a-z0-9-]+__([a-z0-9_-]+|\*)$/;
const PICOMATCH_OPTS = { dot: true, nonegate: true } as const;

/** Tools whose arg-string comes from `input.command`. */
const BASH_TOOLS: ReadonlySet<string> = new Set(["Bash"]);

/** Path-taking tools — arg-string drawn from file_path / path / pattern. */
const PATH_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "Read",
  "Glob",
  "Grep",
  "NotebookEdit",
  "NotebookRead",
]);

/** Web tools — arg-string drawn from url / query. */
const WEB_TOOLS: ReadonlySet<string> = new Set(["WebFetch", "WebSearch"]);

function warning(source: string, ruleClass: RuleClass, reason: string): PermissionRuleWarning {
  return { source, ruleClass, reason };
}

/**
 * Pull the string the matcher should glob against for a given tool call.
 * Exported for testability and for the parallel engine agent if it needs to
 * cross-check arg derivation.
 */
export function selectArgString(call: ToolCall): string {
  const { name, input } = call;

  if (BASH_TOOLS.has(name)) {
    const cmd = input["command"];
    return typeof cmd === "string" ? cmd : "";
  }

  if (PATH_TOOLS.has(name)) {
    const fp = input["file_path"];
    if (typeof fp === "string") return path.normalize(fp);
    const p = input["path"];
    if (typeof p === "string") return path.normalize(p);
    const pat = input["pattern"];
    if (typeof pat === "string") return path.normalize(pat);
    return "";
  }

  if (WEB_TOOLS.has(name)) {
    const url = input["url"];
    if (typeof url === "string") return url;
    const q = input["query"];
    if (typeof q === "string") return q;
    return "";
  }

  if (name.startsWith("mcp__")) {
    try {
      return JSON.stringify(input);
    } catch {
      return "";
    }
  }

  return "";
}

interface ParsedShape {
  readonly toolName: string;
  readonly pattern?: string;
}

/**
 * Split `Tool` or `Tool(pattern)` into `{ toolName, pattern }`. Returns a
 * string-error on grammar failure. Does NOT validate toolName semantics — the
 * caller does that next.
 */
function splitShape(source: string): ParsedShape | string {
  const trimmed = source.trim();
  if (trimmed.length === 0) return "empty rule";

  const openIdx = trimmed.indexOf("(");
  if (openIdx === -1) {
    if (trimmed.includes(")")) return "unmatched ')'";
    return { toolName: trimmed };
  }

  if (!trimmed.endsWith(")")) return "missing trailing ')'";
  const toolName = trimmed.slice(0, openIdx);
  const pattern = trimmed.slice(openIdx + 1, -1);
  if (toolName.length === 0) return "missing tool name";
  if (pattern.length === 0) return "empty pattern";
  // Guard against `Foo(bar)baz` — the endsWith(")") check already fails that,
  // but be explicit about nested unbalanced parens.
  if (pattern.includes("(") || pattern.includes(")")) {
    // Picomatch allows parens in extglobs like `@(a|b)`. Accept them.
  }
  return { toolName, pattern };
}

function validateToolName(toolName: string): string | null {
  if (toolName.startsWith("mcp__")) {
    if (!MCP_TOOL_RE.test(toolName)) {
      return "invalid MCP tool name (expected mcp__<server>__<tool|*>, lowercase)";
    }
    return null;
  }
  if (!BUILTIN_TOOL_RE.test(toolName)) {
    return "invalid tool name";
  }
  return null;
}

/**
 * Build the predicate closure for a rule. Pure — safe to call at parse time.
 */
function buildMatcher(toolName: string, pattern: string | undefined): (call: ToolCall) => boolean {
  // MCP wildcard: `mcp__<server>__*` — match on call.name shape only.
  if (toolName.startsWith("mcp__") && toolName.endsWith("__*")) {
    const prefix = toolName.slice(0, -1); // keep trailing "__", drop "*"
    return (call) => call.name.startsWith(prefix) && call.name.length > prefix.length;
  }

  // MCP exact tool — the toolName IS the full FQN; ignore input patterns.
  if (toolName.startsWith("mcp__")) {
    // If a pattern is present (rare) still honour it against JSON-stringified input.
    if (pattern === undefined) {
      return (call) => call.name === toolName;
    }
    const isMatch = picomatch(pattern, PICOMATCH_OPTS);
    return (call) => call.name === toolName && isMatch(selectArgString(call));
  }

  // Built-in tool — naked form (no pattern) means "any invocation of this
  // tool" regardless of args. Short-circuit so we never depend on whether a
  // glob like `**` happens to match the empty string in picomatch.
  if (pattern === undefined) {
    return (call) => call.name === toolName;
  }
  const isMatch = picomatch(pattern, PICOMATCH_OPTS);
  return (call) => call.name === toolName && isMatch(selectArgString(call));
}

/**
 * Parse one rule string. Returns a fully-built `PermissionRule` on success or
 * a `PermissionRuleWarning` describing the grammar failure.
 */
export function parseRule(
  source: string,
  ruleClass: RuleClass,
): PermissionRule | PermissionRuleWarning {
  const shape = splitShape(source);
  if (typeof shape === "string") {
    return warning(source, ruleClass, shape);
  }

  const toolErr = validateToolName(shape.toolName);
  if (toolErr !== null) {
    return warning(source, ruleClass, toolErr);
  }

  let match: (call: ToolCall) => boolean;
  try {
    match = buildMatcher(shape.toolName, shape.pattern);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return warning(source, ruleClass, `invalid glob: ${reason}`);
  }

  return {
    source,
    ruleClass,
    toolName: shape.toolName,
    ...(shape.pattern !== undefined ? { pattern: shape.pattern } : {}),
    match,
  };
}

export interface CompilePermissionsInput {
  readonly mode?: PermissionMode;
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
  readonly ask?: readonly string[];
  readonly mcpTools?: Readonly<Record<string, "readonly">>;
}

/**
 * Compile a full permissions block. Never throws — bad entries become
 * warnings while good entries still become live rules.
 *
 * Source order is preserved within each class; classes are concatenated in
 * the stable order `deny → ask → allow` for caller convenience, but the
 * engine should filter by `ruleClass` rather than rely on this.
 */
export function compilePermissions(input: CompilePermissionsInput): CompiledPermissions {
  const rules: PermissionRule[] = [];
  const warnings: PermissionRuleWarning[] = [];

  const classes: readonly { cls: RuleClass; list: readonly string[] | undefined }[] = [
    { cls: "deny", list: input.deny },
    { cls: "ask", list: input.ask },
    { cls: "allow", list: input.allow },
  ];

  for (const { cls, list } of classes) {
    if (list === undefined) continue;
    for (const source of list) {
      const result = parseRule(source, cls);
      if ("match" in result) {
        rules.push(result);
      } else {
        warnings.push(result);
      }
    }
  }

  return {
    mode: input.mode ?? "default",
    rules,
    warnings,
    mcpTools: input.mcpTools ?? {},
  };
}

/**
 * Sugar: evaluate a single rule against a call.
 */
export function matchRule(rule: PermissionRule, call: ToolCall): boolean {
  return rule.match(call);
}

/**
 * Return the first rule of the given class that matches the call, respecting
 * source order within that class. Returns `undefined` if none match.
 */
export function firstMatch(
  rules: readonly PermissionRule[],
  call: ToolCall,
  ruleClass: RuleClass,
): PermissionRule | undefined {
  for (const rule of rules) {
    if (rule.ruleClass !== ruleClass) continue;
    if (rule.match(call)) return rule;
  }
  return undefined;
}
