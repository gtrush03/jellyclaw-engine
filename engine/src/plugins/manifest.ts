/**
 * Plugin manifest schema (T4-05).
 *
 * A plugin is a directory with a `plugin.json` manifest file. The manifest
 * declares the plugin's identity and optional permissions. Malformed manifests
 * cause the entire plugin to be skipped (all-or-nothing).
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { Logger } from "pino";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

/**
 * Plugin ID: kebab-case, lowercase, 1-64 chars, must start with a letter.
 */
export const PluginId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export type PluginId = z.infer<typeof PluginId>;

/**
 * Semantic version string (major.minor.patch, optionally with prerelease).
 */
export const PluginVersion = z.string().regex(/^\d+\.\d+\.\d+/);
export type PluginVersion = z.infer<typeof PluginVersion>;

/**
 * Plugin manifest schema — the contents of `plugin.json`.
 */
export const PluginManifest = z.object({
  id: PluginId,
  version: PluginVersion,
  description: z.string().max(512).optional(),
  homepage: z.string().url().optional(),
  author: z.string().optional(),
  engines: z
    .object({
      jellyclaw: z.string().optional(),
    })
    .optional(),
  permissions: z
    .object({
      /** If set, the plugin's agents default to this tool allowlist. */
      tools: z.array(z.string()).optional(),
      /** Future-reserved: filesystem write permissions. */
      fs_write: z.array(z.string()).optional(),
    })
    .optional(),
});
export type PluginManifest = z.infer<typeof PluginManifest>;

/**
 * A loaded plugin with resolved paths.
 */
export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly dir: string;
  readonly skillsDir: string;
  readonly agentsDir: string;
  readonly commandsDir: string;
  readonly hooksDir: string;
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

export interface LoadManifestOptions {
  readonly logger?: Logger | undefined;
}

export interface LoadManifestResult {
  readonly kind: "ok" | "missing" | "invalid";
  readonly plugin?: LoadedPlugin | undefined;
  readonly error?: string | undefined;
}

/**
 * Load and validate a plugin manifest from a directory.
 * Returns `{ kind: "ok", plugin }` on success, or `{ kind: "missing|invalid", error }` on failure.
 */
export function loadManifest(
  pluginDir: string,
  opts: LoadManifestOptions = {},
): LoadManifestResult {
  const manifestPath = path.join(pluginDir, "plugin.json");

  // Check if manifest exists.
  if (!fs.existsSync(manifestPath)) {
    const error = `plugin.json not found in ${pluginDir}`;
    opts.logger?.warn({ path: pluginDir }, "plugin.manifest.missing");
    return { kind: "missing", error };
  }

  // Read and parse JSON.
  let raw: unknown;
  try {
    const content = fs.readFileSync(manifestPath, "utf8");
    raw = JSON.parse(content);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const error = `failed to parse plugin.json in ${pluginDir}: ${reason}`;
    opts.logger?.warn({ path: manifestPath, reason }, "plugin.manifest.invalid");
    return { kind: "invalid", error };
  }

  // Validate with Zod.
  const result = PluginManifest.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    const error = `invalid plugin.json in ${pluginDir}: ${issues}`;
    opts.logger?.warn({ path: manifestPath, issues }, "plugin.manifest.invalid");
    return { kind: "invalid", error };
  }

  const manifest = result.data;

  return {
    kind: "ok",
    plugin: {
      manifest,
      dir: pluginDir,
      skillsDir: path.join(pluginDir, "skills"),
      agentsDir: path.join(pluginDir, "agents"),
      commandsDir: path.join(pluginDir, "commands"),
      hooksDir: path.join(pluginDir, "hooks"),
    },
  };
}

/**
 * Validate a plugin ID.
 */
export function isValidPluginId(id: string): boolean {
  return PluginId.safeParse(id).success;
}
