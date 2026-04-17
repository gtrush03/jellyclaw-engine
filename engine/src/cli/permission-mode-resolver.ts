/**
 * Permission mode resolver (T2-06).
 *
 * Resolves the permission mode from multiple sources with priority:
 *   1. CLI flag (`--permission-mode`)
 *   2. Settings file (`settings.json` defaultMode)
 *   3. Environment variable (`JELLYCLAW_PERMISSION_MODE`)
 *   4. Default (`"default"`)
 *
 * @module
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Permission mode enum. Mirrors the schema in permissions/types.ts.
 */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";

const VALID_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
];

const PermissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]);

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

/**
 * Thrown when an invalid permission mode value is provided.
 */
export class InvalidPermissionModeError extends Error {
  readonly invalidValue: string;
  readonly source: "flag" | "settings" | "env";

  constructor(invalidValue: string, source: "flag" | "settings" | "env") {
    const validList = VALID_MODES.join(", ");
    super(
      `Invalid permission mode "${invalidValue}" from ${source}. ` + `Valid values: ${validList}`,
    );
    this.name = "InvalidPermissionModeError";
    this.invalidValue = invalidValue;
    this.source = source;
  }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface ResolvePermissionModeInput {
  /** Value from CLI `--permission-mode` flag. */
  readonly flag?: string | undefined;
  /** Value from settings.json `permissions.defaultMode`. */
  readonly settings?: string | undefined;
  /** Environment object (defaults to process.env). */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/**
 * Validate a raw string as a PermissionMode.
 * @throws InvalidPermissionModeError if invalid.
 */
function validateMode(value: string, source: "flag" | "settings" | "env"): PermissionMode {
  const result = PermissionModeSchema.safeParse(value);
  if (!result.success) {
    throw new InvalidPermissionModeError(value, source);
  }
  return result.data;
}

/**
 * Resolve the permission mode from multiple sources.
 *
 * Priority (first defined wins):
 *   1. `flag` — CLI `--permission-mode`
 *   2. `settings` — from `loadClaudeSettings().permissions.defaultMode`
 *   3. `env.JELLYCLAW_PERMISSION_MODE`
 *   4. `"default"`
 *
 * @throws InvalidPermissionModeError if any provided value is invalid.
 */
export function resolvePermissionMode(input: ResolvePermissionModeInput = {}): PermissionMode {
  // Priority 1: CLI flag
  if (input.flag !== undefined && input.flag.length > 0) {
    return validateMode(input.flag, "flag");
  }

  // Priority 2: Settings file
  if (input.settings !== undefined && input.settings.length > 0) {
    return validateMode(input.settings, "settings");
  }

  // Priority 3: Environment variable
  const envValue = input.env?.JELLYCLAW_PERMISSION_MODE;
  if (envValue !== undefined && envValue.length > 0) {
    return validateMode(envValue, "env");
  }

  // Priority 4: Default
  return "default";
}
