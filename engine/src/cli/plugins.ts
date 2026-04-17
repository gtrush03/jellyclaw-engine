/**
 * CLI plugins subcommand (T4-05).
 *
 * jellyclaw plugins list — list installed plugins
 * jellyclaw plugins reload — reload all plugins
 * jellyclaw plugins doctor — diagnose plugin issues
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { PluginLoader, type PluginLoaderOptions } from "../plugins/loader.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PluginsListOptions {
  readonly json?: boolean | undefined;
  readonly pluginsDir?: string | undefined;
}

export interface PluginsReloadOptions {
  readonly pluginsDir?: string | undefined;
}

export interface PluginsDoctorOptions {
  readonly pluginsDir?: string | undefined;
}

interface PluginListEntry {
  readonly id: string;
  readonly version: string;
  readonly description?: string | undefined;
  readonly skills: number;
  readonly agents: number;
  readonly hooks: number;
  readonly commands: number;
  readonly source_dir: string;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * List installed plugins.
 */
// biome-ignore lint/suspicious/useAwait: CLI action interface requires Promise return type.
export async function pluginsListAction(opts: PluginsListOptions = {}): Promise<number> {
  const loaderOpts: PluginLoaderOptions = {
    pluginsDir: opts.pluginsDir,
  };

  const loader = new PluginLoader(loaderOpts);
  loader.loadAll();

  const entries: PluginListEntry[] = [];

  for (const [id, components] of loader.plugins) {
    entries.push({
      id,
      version: components.plugin.manifest.version,
      description: components.plugin.manifest.description,
      skills: components.skills.length,
      agents: components.agents.length,
      hooks: components.hooks.length,
      commands: components.commands.length,
      source_dir: components.plugin.dir,
    });
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    return 0;
  }

  if (entries.length === 0) {
    process.stdout.write("No plugins installed.\n");
    return 0;
  }

  // Print table header.
  const header = "ID                       | VERSION | SKILLS | AGENTS | HOOKS | COMMANDS | SOURCE";
  const sep = "-".repeat(header.length);
  process.stdout.write(`${header}\n`);
  process.stdout.write(`${sep}\n`);

  for (const entry of entries) {
    const id = entry.id.padEnd(24);
    const version = entry.version.padEnd(7);
    const skills = String(entry.skills).padEnd(6);
    const agents = String(entry.agents).padEnd(6);
    const hooks = String(entry.hooks).padEnd(5);
    const commands = String(entry.commands).padEnd(8);
    process.stdout.write(
      `${id} | ${version} | ${skills} | ${agents} | ${hooks} | ${commands} | ${entry.source_dir}\n`,
    );
  }

  return 0;
}

/**
 * Reload all plugins.
 */
// biome-ignore lint/suspicious/useAwait: CLI action interface requires Promise return type.
export async function pluginsReloadAction(opts: PluginsReloadOptions = {}): Promise<number> {
  const loaderOpts: PluginLoaderOptions = {
    pluginsDir: opts.pluginsDir,
  };

  const loader = new PluginLoader(loaderOpts);

  // First load to establish baseline.
  loader.loadAll();

  // Reload and compute diff.
  const diff = loader.reloadAll();

  process.stdout.write(`Plugins reloaded:\n`);
  process.stdout.write(`  added:     ${diff.added.length} (${diff.added.join(", ") || "none"})\n`);
  process.stdout.write(
    `  removed:   ${diff.removed.length} (${diff.removed.join(", ") || "none"})\n`,
  );
  process.stdout.write(`  unchanged: ${diff.unchanged.length}\n`);

  return 0;
}

/**
 * Diagnose plugin issues.
 */
// biome-ignore lint/suspicious/useAwait: CLI action interface requires Promise return type.
export async function pluginsDoctorAction(opts: PluginsDoctorOptions = {}): Promise<number> {
  const loaderOpts: PluginLoaderOptions = {
    pluginsDir: opts.pluginsDir,
  };

  const loader = new PluginLoader(loaderOpts);
  loader.loadAll();

  const warnings = loader.warnings;
  let hasIssues = false;

  if (warnings.length > 0) {
    process.stdout.write("Warnings:\n");
    for (const warning of warnings) {
      process.stdout.write(`  - ${warning}\n`);
    }
    hasIssues = true;
  }

  for (const [id, components] of loader.plugins) {
    const issues: string[] = [];

    // Check hook command shebangs.
    for (const hook of components.hooks) {
      const cmd = hook.config.command;
      if (!cmd.startsWith("/") && !cmd.startsWith("./")) {
        // Relative command, check if it exists in plugin dir.
        const cmdPath = path.join(components.plugin.dir, cmd);
        if (!fs.existsSync(cmdPath)) {
          issues.push(`hook ${hook.event}: command not found: ${cmd}`);
        }
      }
    }

    if (issues.length > 0) {
      process.stdout.write(`\nPlugin ${id}:\n`);
      for (const issue of issues) {
        process.stdout.write(`  - ${issue}\n`);
      }
      hasIssues = true;
    }
  }

  if (!hasIssues) {
    process.stdout.write("All plugins OK.\n");
  }

  return hasIssues ? 1 : 0;
}
