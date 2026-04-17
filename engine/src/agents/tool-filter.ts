/**
 * Tool filtering for --allowed-tools / --disallowed-tools (T2-09).
 *
 * Filters tools based on allow/deny lists with support for MCP wildcard
 * patterns like `mcp__github__*`.
 *
 * @module
 */

import picomatch from "picomatch";

// Use the same picomatch options as rules.ts for consistency.
const PICOMATCH_OPTS: picomatch.PicomatchOptions = { dot: true, nonegate: true };

/**
 * Tool filter configuration.
 *
 * - `deny` — tool names to exclude. Supports `mcp__server__*` wildcards.
 * - `allow` — when defined AND non-empty, only these tools are included.
 *
 * Filtering rules (applied in order):
 * 1. If `deny` contains the tool name (or a matching wildcard) — exclude.
 * 2. If `allow` is defined AND non-empty AND the tool name is NOT matched — exclude.
 * 3. Otherwise include.
 */
export interface ToolFilter {
  readonly allow?: readonly string[] | undefined;
  readonly deny?: readonly string[] | undefined;
}

/**
 * Check if a tool name matches any pattern in the list.
 * Patterns can be exact names or globs like `mcp__github__*`.
 */
function matchesAny(name: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    // Exact match (common case — fast path).
    if (pattern === name) return true;

    // Wildcard pattern (e.g., `mcp__github__*`).
    if (pattern.includes("*")) {
      const isMatch = picomatch(pattern, PICOMATCH_OPTS);
      if (isMatch(name)) return true;
    }
  }
  return false;
}

/**
 * Check if a tool is enabled by the filter.
 *
 * @param name - Tool name (e.g., "Bash", "mcp__github__create_issue")
 * @param filter - The filter configuration
 * @returns true if the tool is enabled, false if filtered out
 */
export function isToolEnabled(name: string, filter: ToolFilter): boolean {
  // Rule 1: If deny contains the tool name (or matching wildcard) — exclude.
  if (filter.deny !== undefined && filter.deny.length > 0) {
    if (matchesAny(name, filter.deny)) {
      return false;
    }
  }

  // Rule 2: If allow is defined AND non-empty AND tool name is NOT matched — exclude.
  if (filter.allow !== undefined && filter.allow.length > 0) {
    if (!matchesAny(name, filter.allow)) {
      return false;
    }
  }

  // Rule 3: Otherwise include.
  return true;
}

/**
 * Filter a list of tools based on allow/deny configuration.
 *
 * @param tools - Array of tool objects with `name` property
 * @param filter - The filter configuration
 * @returns Filtered array of tools
 */
export function applyToolFilter<T extends { readonly name: string }>(
  tools: readonly T[],
  filter: ToolFilter,
): readonly T[] {
  // Fast path: no filter configured.
  if (
    (filter.allow === undefined || filter.allow.length === 0) &&
    (filter.deny === undefined || filter.deny.length === 0)
  ) {
    return tools;
  }

  return tools.filter((tool) => isToolEnabled(tool.name, filter));
}
