/**
 * MCP tool namespacing.
 *
 * Every MCP tool is exposed to the model as `mcp__<server>__<tool>`.
 * The double-underscore separator is Claude Code's canonical form —
 * server and tool each contribute exactly one `__` boundary, parsed
 * left-to-right so the tool part may contain additional underscores or
 * any non-reserved character.
 *
 * Server names are restricted to `[a-z0-9-]+` (kebab-ish, lowercase,
 * digits, hyphen). Underscores are forbidden in server names because
 * a `_` inside a server name would make the `__` boundary ambiguous.
 *
 * Tool names may contain letters, digits, `_`, `-`, `.` — anything the
 * server reports. No ambiguity risk: we split on the **first** `__`
 * after the `mcp__` prefix.
 */

/** Validates a server name. Enforced at config-load and by `namespace()`. */
export const SERVER_NAME_RE = /^[a-z0-9-]+$/;

/** Canonical regex for a namespaced tool. Captures `[server, tool]`. */
export const NAMESPACED_TOOL_RE = /^mcp__([a-z0-9-]+)__(.+)$/;

/**
 * Thrown when a server name fails the `[a-z0-9-]+` check. This is
 * caller error — config validation should reject invalid names before
 * they reach this layer.
 */
export class InvalidServerNameError extends Error {
  override readonly name = "InvalidServerNameError";
  constructor(readonly server: string) {
    super(`invalid MCP server name '${server}' (must match [a-z0-9-]+)`);
  }
}

/**
 * Thrown when a tool name contains the namespacing separator. The
 * server cannot return a tool whose raw name contains `__` because we
 * would not be able to round-trip it; fail fast at namespacing time.
 */
export class InvalidToolNameError extends Error {
  override readonly name = "InvalidToolNameError";
  constructor(readonly tool: string) {
    super(`invalid MCP tool name '${tool}' (must not contain '__')`);
  }
}

/**
 * Assert a server name is valid. Returns the name on success; throws
 * `InvalidServerNameError` on failure. Useful at config load.
 */
export function validateServerName(server: string): string {
  if (!SERVER_NAME_RE.test(server)) throw new InvalidServerNameError(server);
  return server;
}

/**
 * Produce the namespaced form of a tool.
 *
 *   namespace("playwright", "browser_click") === "mcp__playwright__browser_click"
 *
 * Rejects server names failing `[a-z0-9-]+` and tool names containing
 * `__` (which would break round-trip parsing).
 */
export function namespace(server: string, tool: string): string {
  validateServerName(server);
  if (tool.includes("__")) throw new InvalidToolNameError(tool);
  return `mcp__${server}__${tool}`;
}

/**
 * Parse a namespaced tool name. Splits on the **first** `__` after the
 * `mcp__` prefix — the tool name may contain any additional characters,
 * including more underscores. Returns `null` on malformed input.
 */
export function parse(
  namespaced: string,
): { readonly server: string; readonly tool: string } | null {
  const m = NAMESPACED_TOOL_RE.exec(namespaced);
  if (!m?.[1] || !m[2]) return null;
  return { server: m[1], tool: m[2] };
}
