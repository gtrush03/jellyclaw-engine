/**
 * Template path utilities (T0-02).
 *
 * Provides helpers for locating and reading the canonical MCP config
 * template shipped with jellyclaw. Used by `doctor` to suggest the
 * template path and by future `init` commands.
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Returns the absolute path to `engine/templates/mcp.default.json`.
 * Works both in development (src/) and after build (dist/).
 */
export function getDefaultMcpTemplatePath(): string {
  // In dev: engine/src/cli/templates.ts → engine/templates/mcp.default.json
  // In dist: engine/dist/cli/templates.js → engine/templates/mcp.default.json
  // Both are 3 levels up from __dirname to reach engine/, then into templates/
  return resolve(__dirname, "..", "..", "..", "templates", "mcp.default.json");
}

/**
 * Reads and parses the default MCP template JSON.
 * @throws if the template file doesn't exist or is invalid JSON
 */
export async function readDefaultMcpTemplate(): Promise<unknown> {
  const path = getDefaultMcpTemplatePath();
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}
