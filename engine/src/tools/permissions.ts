/**
 * Phase-04 test helper: a minimal in-memory PermissionService that treats the
 * canonical `allow | ask | deny` strings from SPEC §13 the way a later phase
 * will: `allow` permits, everything else denies (Phase 04 has no interactive
 * prompt).
 */

import path from "node:path";
import { CwdEscapeError, type PermissionService, type ToolContext } from "./types.js";

export function fromMap(map: Record<string, "allow" | "ask" | "deny">): PermissionService {
  return {
    isAllowed(key) {
      return map[key] === "allow";
    },
  };
}

export const denyAll: PermissionService = {
  isAllowed: () => false,
};

export const allowAll: PermissionService = {
  isAllowed: () => true,
};

/**
 * Check if a resolved absolute path is within any of the allowed roots (T2-10).
 *
 * Returns true if the path is equal to or a descendant of any root in the list.
 */
export function isWithinAllowedRoots(absPath: string, roots: readonly string[]): boolean {
  const normalizedPath = path.resolve(absPath);
  for (const root of roots) {
    const normalizedRoot = path.resolve(root);
    if (normalizedPath === normalizedRoot || normalizedPath.startsWith(normalizedRoot + path.sep)) {
      return true;
    }
  }
  return false;
}

/**
 * Ensure a resolved path is inside cwd or additionalRoots (T2-10).
 *
 * Throws CwdEscapeError if the path escapes all allowed roots and the
 * corresponding permission (e.g., `read.outside_cwd`) is not granted.
 *
 * @param resolved - Absolute path that has been resolved
 * @param ctx - Tool context with cwd and additionalRoots
 * @param permissionKey - Permission key to check if escape is allowed
 */
export function ensureWithinAllowedRoots(
  resolved: string,
  ctx: ToolContext,
  permissionKey: string,
): void {
  const roots = [ctx.cwd, ...(ctx.additionalRoots ?? [])];
  if (isWithinAllowedRoots(resolved, roots)) {
    return;
  }
  // Path is outside all allowed roots — check permission.
  if (!ctx.permissions.isAllowed(permissionKey)) {
    throw new CwdEscapeError(resolved, ctx.cwd);
  }
}
