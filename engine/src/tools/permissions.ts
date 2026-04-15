/**
 * Phase-04 test helper: a minimal in-memory PermissionService that treats the
 * canonical `allow | ask | deny` strings from SPEC §13 the way a later phase
 * will: `allow` permits, everything else denies (Phase 04 has no interactive
 * prompt).
 */

import type { PermissionService } from "./types.js";

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
