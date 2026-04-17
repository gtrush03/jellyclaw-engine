/**
 * Claude Code settings.json loader (T2-05).
 *
 * Loads and merges settings from three locations (later wins for scalars;
 * deny-lists concatenate; hook arrays concatenate by event kind):
 *   1. ~/.claude/settings.json (user)
 *   2. ./.claude/settings.json (project)
 *   3. ./.claude/settings.local.json (local overrides)
 *
 * Returns { hookConfigs, permissions, warnings } ready for consumption by
 * HookRegistry and the permission engine.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { resolvePermissionMode } from "../cli/permission-mode-resolver.js";
import type { HookConfig, HookEventKind } from "../hooks/types.js";
import { compilePermissions } from "../permissions/rules.js";
import type { CompiledPermissions, PermissionMode } from "../permissions/types.js";

// ---------------------------------------------------------------------------
// Zod schema for Claude Code settings.json
// ---------------------------------------------------------------------------

const HookEventKindSchema = z.enum([
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStop",
  "Notification",
  "SessionStart",
  "InstructionsLoaded",
  "SubagentStart",
  "PreCompact",
]);

const HookConfigSchema = z.object({
  matcher: z.string().optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  timeout: z.number().int().positive().max(120_000).optional(),
  blocking: z.boolean().optional(),
  name: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const HooksRecordSchema = z.record(HookEventKindSchema, z.array(HookConfigSchema)).optional();

const PermissionModeSchema = z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]);

const PermissionsSchema = z
  .object({
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    ask: z.array(z.string()).default([]),
    additionalDirectories: z.array(z.string()).default([]),
    defaultMode: PermissionModeSchema.optional(),
  })
  .default({});

export const ClaudeSettings = z.object({
  hooks: HooksRecordSchema,
  permissions: PermissionsSchema,
});
export type ClaudeSettings = z.infer<typeof ClaudeSettings>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface LoadClaudeSettingsOptions {
  /** Override for home directory. Default: os.homedir(). */
  readonly home?: string;
  /** Override for cwd. Default: process.cwd(). */
  readonly cwd?: string;
  /** Override permission mode (CLI --permission-mode). Takes precedence over settings and env. */
  readonly overrideMode?: PermissionMode;
  /** Environment object for JELLYCLAW_PERMISSION_MODE. Default: process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface LoadClaudeSettingsResult {
  /** Flattened hook configs ready for HookRegistry. */
  readonly hookConfigs: HookConfig[];
  /** Compiled permissions ready for the permission engine. */
  readonly permissions: CompiledPermissions;
  /** Parse errors and other warnings collected during load. */
  readonly warnings: string[];
}

interface LayerResult {
  readonly settings: Partial<ClaudeSettings>;
  readonly warning?: string;
}

function loadLayer(path: string): LayerResult {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    // File doesn't exist — treat as empty.
    return { settings: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { settings: {}, warning: `${path}: JSON parse error: ${reason}` };
  }

  const result = ClaudeSettings.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { settings: {}, warning: `${path}: validation error: ${issues}` };
  }

  return { settings: result.data };
}

// Internal type for hook configs without the event field.
// Use `unknown` for the array items and cast when consuming.
type HooksRecord = Record<string, unknown[]>;

function mergeHooks(
  base: HooksRecord | undefined,
  overlay: Record<string, unknown[] | undefined> | undefined,
): HooksRecord {
  if (overlay === undefined) return base ?? {};
  if (base === undefined) {
    const result: HooksRecord = {};
    for (const [event, configs] of Object.entries(overlay)) {
      if (configs !== undefined) {
        result[event] = configs;
      }
    }
    return result;
  }

  const merged: HooksRecord = { ...base };
  for (const [event, configs] of Object.entries(overlay)) {
    if (configs === undefined) continue;
    const existing = merged[event] ?? [];
    merged[event] = [...existing, ...configs];
  }
  return merged;
}

function mergePermissions(
  base: ClaudeSettings["permissions"],
  overlay: ClaudeSettings["permissions"],
): ClaudeSettings["permissions"] {
  return {
    // Concatenate rule arrays (deny-wins happens at decide() time).
    allow: [...base.allow, ...overlay.allow],
    deny: [...base.deny, ...overlay.deny],
    ask: [...base.ask, ...overlay.ask],
    additionalDirectories: [...base.additionalDirectories, ...overlay.additionalDirectories],
    // Later defaultMode wins.
    defaultMode: overlay.defaultMode ?? base.defaultMode,
  };
}

interface RawHookConfig {
  command: string;
  matcher?: string;
  args?: string[];
  timeout?: number;
  blocking?: boolean;
  name?: string;
  env?: Record<string, string>;
}

function flattenHooks(hooksRecord: HooksRecord | undefined): HookConfig[] {
  if (hooksRecord === undefined) return [];

  const out: HookConfig[] = [];
  for (const [event, configs] of Object.entries(hooksRecord)) {
    for (const rawConfig of configs) {
      const config = rawConfig as RawHookConfig;
      out.push({
        event: event as HookEventKind,
        command: config.command,
        ...(config.matcher !== undefined ? { matcher: config.matcher } : {}),
        ...(config.args !== undefined ? { args: config.args } : {}),
        ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
        ...(config.blocking !== undefined ? { blocking: config.blocking } : {}),
        ...(config.name !== undefined ? { name: config.name } : {}),
        ...(config.env !== undefined ? { env: config.env } : {}),
      });
    }
  }
  return out;
}

export function loadClaudeSettings(opts: LoadClaudeSettingsOptions = {}): LoadClaudeSettingsResult {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();

  const paths = [
    join(home, ".claude", "settings.json"),
    resolve(cwd, ".claude", "settings.json"),
    resolve(cwd, ".claude", "settings.local.json"),
  ];

  const warnings: string[] = [];
  let mergedHooks: HooksRecord | undefined;
  let mergedPermissions: ClaudeSettings["permissions"] = {
    allow: [],
    deny: [],
    ask: [],
    additionalDirectories: [],
    defaultMode: undefined,
  };

  for (const path of paths) {
    const layer = loadLayer(path);
    if (layer.warning !== undefined) {
      warnings.push(layer.warning);
      continue;
    }

    if (layer.settings.hooks !== undefined) {
      mergedHooks = mergeHooks(mergedHooks, layer.settings.hooks);
    }
    if (layer.settings.permissions !== undefined) {
      mergedPermissions = mergePermissions(mergedPermissions, layer.settings.permissions);
    }
  }

  // Flatten hooks to array format expected by HookRegistry.
  const hookConfigs = flattenHooks(mergedHooks);

  // Resolve permission mode: flag (overrideMode) > settings > env > "default".
  // Uses resolvePermissionMode for consistent priority handling (T2-06).
  const mode = resolvePermissionMode({
    flag: opts.overrideMode,
    settings: mergedPermissions.defaultMode,
    env: opts.env ?? process.env,
  });

  // Compile permissions via the existing rules.ts API.
  const permissions = compilePermissions({
    mode,
    allow: mergedPermissions.allow,
    deny: mergedPermissions.deny,
    ask: mergedPermissions.ask,
  });

  // Add permission compile warnings to our warnings list.
  for (const w of permissions.warnings) {
    warnings.push(`permission rule "${w.source}" (${w.ruleClass}): ${w.reason}`);
  }

  return { hookConfigs, permissions, warnings };
}
