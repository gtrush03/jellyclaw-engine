/**
 * Shared types + error taxonomy for jellyclaw built-in tools.
 *
 * Every tool in `engine/src/tools/<name>.ts` exports a `Tool` conforming to
 * this contract. The registry in `engine/src/tools/index.ts` collects them.
 *
 * Design notes:
 * - `inputSchema` is the JSON-Schema shape surfaced to the model (byte-for-byte
 *   paired with Claude Code's published schema — see
 *   `test/fixtures/tools/claude-code-schemas/*.json`).
 * - `zodSchema` is the runtime validator the handler uses. The parity tests
 *   check that the two agree.
 * - `overridesOpenCode` marks tools that replace OpenCode's builtin of the
 *   same name (Phase 04 dream outcome).
 */

import type { z } from "zod";
import type { Logger } from "../logger.js";

export type JsonSchema = {
  readonly $schema?: string;
  readonly type: "object";
  readonly additionalProperties?: boolean;
  readonly properties: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly required?: readonly string[];
};

export interface ToolContext {
  /** Project root. All tool I/O is jailed below this unless config grants otherwise. */
  readonly cwd: string;
  /** Opaque session identifier; used for scoping caches + background process logs. */
  readonly sessionId: string;
  /**
   * Absolute paths the model has Read in this session. Write consults this to
   * enforce the "read before overwrite" invariant.
   */
  readonly readCache: Set<string>;
  /** Cancellation signal propagated into spawned processes + fetches. */
  readonly abort: AbortSignal;
  readonly logger: Logger;
  readonly permissions: PermissionService;
}

/**
 * Minimal permission surface exposed to tools. The real engine implementation
 * (Phase 08) resolves `allow` / `ask` / `deny` against config + hook runner.
 * For Phase 04 we only need the synchronous `isAllowed` check.
 */
export interface PermissionService {
  /**
   * Resolve a permission key (e.g. "bash", "write.outside_cwd",
   * "bash.cd_escape") to an effective mode. `ask` is treated as `deny` in
   * Phase 04 — an interactive prompt will be wired in Phase 08.
   */
  isAllowed(key: string): boolean;
}

export interface Tool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly zodSchema: z.ZodType<I>;
  readonly overridesOpenCode: boolean;
  handler(input: I, ctx: ToolContext): Promise<O>;
}

// ---------------------------------------------------------------------------
// Error taxonomy
// ---------------------------------------------------------------------------

/**
 * Base class for typed tool errors. Keeps `.code` stable so callers can
 * pattern-match; `.details` carries structured context for the logger.
 */
export class ToolError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class InvalidInputError extends ToolError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super("InvalidInput", message, details);
    this.name = "InvalidInputError";
  }
}

export class BlockedCommandError extends ToolError {
  constructor(pattern: string, command: string) {
    super("BlockedCommand", `Refused to run blocked pattern: ${pattern}`, { pattern, command });
    this.name = "BlockedCommandError";
  }
}

export class CwdEscapeError extends ToolError {
  constructor(path: string, cwd: string) {
    super("CwdEscape", `Path escapes the project root: ${path}`, { path, cwd });
    this.name = "CwdEscapeError";
  }
}

export class TimeoutError extends ToolError {
  constructor(ms: number, command: string) {
    super("Timeout", `Command timed out after ${ms}ms`, { ms, command });
    this.name = "TimeoutError";
  }
}

export class WriteRequiresReadError extends ToolError {
  constructor(path: string) {
    super(
      "WriteRequiresRead",
      `File exists but has not been Read in this session: ${path}. Read it first, then Write.`,
      { path },
    );
    this.name = "WriteRequiresReadError";
  }
}

export class PermissionDeniedError extends ToolError {
  constructor(key: string, detail: string) {
    super("PermissionDenied", `Permission ${key} denied: ${detail}`, { key, detail });
    this.name = "PermissionDeniedError";
  }
}

export class EditRequiresReadError extends ToolError {
  constructor(path: string) {
    super(
      "EditRequiresRead",
      `File has not been Read in this session: ${path}. Read it first, then Edit.`,
      { path },
    );
    this.name = "EditRequiresReadError";
  }
}

export class NoMatchError extends ToolError {
  constructor(path: string, oldStringPreview: string, diagnostic: string) {
    super(
      "NoMatch",
      `old_string not found in ${path}. ${diagnostic}`,
      { path, old_string_preview: oldStringPreview, diagnostic },
    );
    this.name = "NoMatchError";
  }
}

export class AmbiguousMatchError extends ToolError {
  readonly count: number;
  constructor(path: string, count: number) {
    super(
      "AmbiguousMatch",
      `old_string matches ${count} times in ${path}; either make it more unique by adding surrounding context, or pass replace_all: true.`,
      { path, count },
    );
    this.name = "AmbiguousMatchError";
    this.count = count;
  }
}

export class NoOpEditError extends ToolError {
  constructor(path: string) {
    super("NoOpEdit", `Edit is a no-op: old_string === new_string (${path}).`, { path });
    this.name = "NoOpEditError";
  }
}

export class StaleReadError extends ToolError {
  constructor(path: string, cachedMtimeMs: number, currentMtimeMs: number) {
    super("StaleRead", `File changed on disk since last Read: ${path}`, {
      path,
      cachedMtimeMs,
      currentMtimeMs,
    });
    this.name = "StaleReadError";
  }
}

// ---------------------------------------------------------------------------
// Handy permission helpers used across tools
// ---------------------------------------------------------------------------

/** In-memory permission service with a simple allow-set; useful for tests. */
export function makePermissionService(allow: Iterable<string> = []): PermissionService {
  const set = new Set(allow);
  return {
    isAllowed(key) {
      return set.has(key);
    },
  };
}
