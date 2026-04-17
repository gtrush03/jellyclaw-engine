/**
 * Plugin loader (T4-05).
 *
 * Walks `~/.claude/plugins/` (or override dirs) and loads plugins.
 * Each plugin contributes skills, agents, commands, and hooks under
 * a namespaced ID (`<pluginId>:<localId>`).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import matter from "gray-matter";
import type { Logger } from "pino";
import { z } from "zod";

import type { AgentFrontmatter } from "../agents/types.js";
import type { HookConfig, HookEventKind } from "../hooks/types.js";
import { logger as defaultLogger } from "../logger.js";
import { type LoadedPlugin, loadManifest } from "./manifest.js";
import {
  isValidAgentName,
  isValidCommandName,
  isValidHookEventName,
  isValidSkillName,
  namespaced,
} from "./namespace.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PluginSkill {
  readonly id: string; // Namespaced: pluginId:localId
  readonly pluginId: string;
  readonly localId: string;
  readonly path: string;
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

export interface PluginAgent {
  readonly id: string; // Namespaced: pluginId:localId
  readonly pluginId: string;
  readonly localId: string;
  readonly path: string;
  readonly frontmatter: AgentFrontmatter;
  readonly prompt: string;
}

export interface PluginCommand {
  readonly id: string; // Namespaced: pluginId:localId
  readonly pluginId: string;
  readonly localId: string;
  readonly path: string;
  readonly description?: string | undefined;
  readonly argumentHint?: string | undefined;
  readonly body: string;
}

export interface PluginHook {
  readonly id: string; // Namespaced: pluginId:hookName
  readonly pluginId: string;
  readonly event: HookEventKind;
  readonly config: HookConfig;
}

export interface LoadedPluginComponents {
  readonly plugin: LoadedPlugin;
  readonly skills: PluginSkill[];
  readonly agents: PluginAgent[];
  readonly commands: PluginCommand[];
  readonly hooks: PluginHook[];
}

export interface PluginLoaderState {
  readonly plugins: Map<string, LoadedPluginComponents>;
  readonly skills: Map<string, PluginSkill>;
  readonly agents: Map<string, PluginAgent>;
  readonly commands: Map<string, PluginCommand>;
  readonly hooks: PluginHook[];
  readonly warnings: string[];
}

// ---------------------------------------------------------------------------
// Default paths
// ---------------------------------------------------------------------------

function defaultPluginsDir(): string {
  const home = os.homedir();
  return path.join(home, ".claude", "plugins");
}

export interface PluginLoaderOptions {
  /** Override plugins directories. Comma-separated for multiple. */
  readonly pluginsDir?: string | undefined;
  readonly logger?: Logger | undefined;
}

// ---------------------------------------------------------------------------
// Hook config schema (from T2-04)
// ---------------------------------------------------------------------------

const HookConfigSchema = z.object({
  event: z.string(),
  matcher: z.string().optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  timeout_ms: z.number().int().positive().optional(),
  blocking: z.boolean().optional(),
  name: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Loader class
// ---------------------------------------------------------------------------

export class PluginLoader {
  readonly #logger: Logger;
  readonly #pluginsDirs: string[];

  #state: PluginLoaderState = {
    plugins: new Map(),
    skills: new Map(),
    agents: new Map(),
    commands: new Map(),
    hooks: [],
    warnings: [],
  };

  constructor(opts: PluginLoaderOptions = {}) {
    this.#logger = opts.logger ?? defaultLogger;

    // Parse plugins directories.
    const envDir = process.env.JELLYCLAW_PLUGINS_DIR;
    const dirsStr = opts.pluginsDir ?? envDir ?? defaultPluginsDir();
    this.#pluginsDirs = dirsStr
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
  }

  get state(): PluginLoaderState {
    return this.#state;
  }

  get plugins(): Map<string, LoadedPluginComponents> {
    return this.#state.plugins;
  }

  get skills(): Map<string, PluginSkill> {
    return this.#state.skills;
  }

  get agents(): Map<string, PluginAgent> {
    return this.#state.agents;
  }

  get commands(): Map<string, PluginCommand> {
    return this.#state.commands;
  }

  get hooks(): PluginHook[] {
    return this.#state.hooks;
  }

  get warnings(): string[] {
    return this.#state.warnings;
  }

  /**
   * Load all plugins from configured directories.
   */
  loadAll(): void {
    this.#state = {
      plugins: new Map(),
      skills: new Map(),
      agents: new Map(),
      commands: new Map(),
      hooks: [],
      warnings: [],
    };

    const seenPluginIds = new Set<string>();

    for (const pluginsDir of this.#pluginsDirs) {
      if (!fs.existsSync(pluginsDir)) {
        continue;
      }

      let entries: string[];
      try {
        entries = fs.readdirSync(pluginsDir);
      } catch {
        continue;
      }

      for (const entry of entries.sort()) {
        const pluginDir = path.join(pluginsDir, entry);

        // Skip non-directories.
        try {
          if (!fs.statSync(pluginDir).isDirectory()) continue;
        } catch {
          continue;
        }

        // Load manifest.
        const result = loadManifest(pluginDir, { logger: this.#logger });
        if (result.kind !== "ok" || !result.plugin) {
          if (result.error) {
            this.#state.warnings.push(result.error);
          }
          continue;
        }

        const plugin = result.plugin;
        const pluginId = plugin.manifest.id;

        // Check for collision.
        if (seenPluginIds.has(pluginId)) {
          const warning = `plugin collision: ${pluginId} already loaded, skipping ${pluginDir}`;
          this.#logger.warn({ pluginId, path: pluginDir }, "plugin.collision");
          this.#state.warnings.push(warning);
          continue;
        }
        seenPluginIds.add(pluginId);

        // Load components.
        const components = this.#loadPluginComponents(plugin);
        this.#state.plugins.set(pluginId, components);

        // Register components.
        for (const skill of components.skills) {
          if (this.#state.skills.has(skill.id)) {
            const warning = `skill collision: ${skill.id} already exists`;
            this.#state.warnings.push(warning);
            continue;
          }
          this.#state.skills.set(skill.id, skill);
        }

        for (const agent of components.agents) {
          if (this.#state.agents.has(agent.id)) {
            const warning = `agent collision: ${agent.id} already exists`;
            this.#state.warnings.push(warning);
            continue;
          }
          this.#state.agents.set(agent.id, agent);
        }

        for (const command of components.commands) {
          if (this.#state.commands.has(command.id)) {
            const warning = `command collision: ${command.id} already exists`;
            this.#state.warnings.push(warning);
            continue;
          }
          this.#state.commands.set(command.id, command);
        }

        this.#state.hooks.push(...components.hooks);

        this.#logger.info(
          {
            pluginId,
            version: plugin.manifest.version,
            skills: components.skills.length,
            agents: components.agents.length,
            commands: components.commands.length,
            hooks: components.hooks.length,
          },
          "plugin.loaded",
        );
      }
    }
  }

  /**
   * Reload all plugins (idempotent).
   */
  reloadAll(): { added: string[]; removed: string[]; unchanged: string[] } {
    const prevIds = new Set(this.#state.plugins.keys());
    this.loadAll();
    const nextIds = new Set(this.#state.plugins.keys());

    const added: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];

    for (const id of nextIds) {
      if (prevIds.has(id)) {
        unchanged.push(id);
      } else {
        added.push(id);
      }
    }
    for (const id of prevIds) {
      if (!nextIds.has(id)) {
        removed.push(id);
      }
    }

    return { added, removed, unchanged };
  }

  /**
   * Get a skill by namespaced ID.
   */
  getSkill(id: string): PluginSkill | undefined {
    return this.#state.skills.get(id);
  }

  /**
   * Get an agent by namespaced ID.
   */
  getAgent(id: string): PluginAgent | undefined {
    return this.#state.agents.get(id);
  }

  /**
   * Get a command by namespaced ID.
   */
  getCommand(id: string): PluginCommand | undefined {
    return this.#state.commands.get(id);
  }

  /**
   * List all skills.
   */
  listSkills(): PluginSkill[] {
    return [...this.#state.skills.values()];
  }

  /**
   * List all agents.
   */
  listAgents(): PluginAgent[] {
    return [...this.#state.agents.values()];
  }

  /**
   * List all commands.
   */
  listCommands(): PluginCommand[] {
    return [...this.#state.commands.values()];
  }

  /**
   * List all hooks.
   */
  listHooks(): PluginHook[] {
    return [...this.#state.hooks];
  }

  // -------------------------------------------------------------------------
  // Internal component loaders
  // -------------------------------------------------------------------------

  #loadPluginComponents(plugin: LoadedPlugin): LoadedPluginComponents {
    const skills = this.#loadSkills(plugin);
    const agents = this.#loadAgents(plugin);
    const commands = this.#loadCommands(plugin);
    const hooks = this.#loadHooks(plugin);

    return { plugin, skills, agents, commands, hooks };
  }

  #loadSkills(plugin: LoadedPlugin): PluginSkill[] {
    const skills: PluginSkill[] = [];
    const skillsDir = plugin.skillsDir;

    if (!fs.existsSync(skillsDir)) return skills;

    let entries: string[];
    try {
      entries = fs.readdirSync(skillsDir);
    } catch {
      return skills;
    }

    for (const entry of entries.sort()) {
      if (!isValidSkillName(entry)) continue;

      const skillDir = path.join(skillsDir, entry);
      try {
        if (!fs.statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const skillPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;

      try {
        const content = fs.readFileSync(skillPath, "utf8");
        const parsed = matter(content);

        skills.push({
          id: namespaced(plugin.manifest.id, entry),
          pluginId: plugin.manifest.id,
          localId: entry,
          path: skillPath,
          frontmatter: parsed.data as Record<string, unknown>,
          body: parsed.content.trim(),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.#logger.warn({ path: skillPath, reason }, "plugin.skill.load_failed");
      }
    }

    return skills;
  }

  #loadAgents(plugin: LoadedPlugin): PluginAgent[] {
    const agents: PluginAgent[] = [];
    const agentsDir = plugin.agentsDir;

    if (!fs.existsSync(agentsDir)) return agents;

    let entries: string[];
    try {
      entries = fs.readdirSync(agentsDir);
    } catch {
      return agents;
    }

    for (const entry of entries.sort()) {
      if (!isValidAgentName(entry)) continue;

      const agentDir = path.join(agentsDir, entry);
      try {
        if (!fs.statSync(agentDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const agentPath = path.join(agentDir, "AGENT.md");
      if (!fs.existsSync(agentPath)) continue;

      try {
        const content = fs.readFileSync(agentPath, "utf8");
        const parsed = matter(content);

        // Validate frontmatter structure.
        const fm = parsed.data as AgentFrontmatter;
        if (!fm.name || !fm.description) {
          this.#logger.warn({ path: agentPath }, "plugin.agent.missing_required_fields");
          continue;
        }

        agents.push({
          id: namespaced(plugin.manifest.id, entry),
          pluginId: plugin.manifest.id,
          localId: entry,
          path: agentPath,
          frontmatter: fm,
          prompt: parsed.content.trim(),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.#logger.warn({ path: agentPath, reason }, "plugin.agent.load_failed");
      }
    }

    return agents;
  }

  #loadCommands(plugin: LoadedPlugin): PluginCommand[] {
    const commands: PluginCommand[] = [];
    const commandsDir = plugin.commandsDir;

    if (!fs.existsSync(commandsDir)) return commands;

    let entries: string[];
    try {
      entries = fs.readdirSync(commandsDir);
    } catch {
      return commands;
    }

    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;

      const localId = entry.slice(0, -3);
      if (!isValidCommandName(localId)) continue;

      const commandPath = path.join(commandsDir, entry);
      try {
        if (!fs.statSync(commandPath).isFile()) continue;
      } catch {
        continue;
      }

      try {
        const content = fs.readFileSync(commandPath, "utf8");
        const parsed = matter(content);
        const fm = parsed.data as { description?: string; argument_hint?: string };

        commands.push({
          id: namespaced(plugin.manifest.id, localId),
          pluginId: plugin.manifest.id,
          localId,
          path: commandPath,
          description: fm.description,
          argumentHint: fm.argument_hint,
          body: parsed.content.trim(),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.#logger.warn({ path: commandPath, reason }, "plugin.command.load_failed");
      }
    }

    return commands;
  }

  #loadHooks(plugin: LoadedPlugin): PluginHook[] {
    const hooks: PluginHook[] = [];
    const hooksDir = plugin.hooksDir;

    if (!fs.existsSync(hooksDir)) return hooks;

    let entries: string[];
    try {
      entries = fs.readdirSync(hooksDir);
    } catch {
      return hooks;
    }

    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;

      const hookName = entry.slice(0, -5);
      if (!isValidHookEventName(hookName)) {
        this.#logger.warn(
          { path: path.join(hooksDir, entry), hookName },
          "plugin.hook.invalid_event_name",
        );
        continue;
      }

      const hookPath = path.join(hooksDir, entry);
      try {
        const content = fs.readFileSync(hookPath, "utf8");
        const raw = JSON.parse(content);

        const result = HookConfigSchema.safeParse(raw);
        if (!result.success) {
          const issues = result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          this.#logger.warn({ path: hookPath, issues }, "plugin.hook.invalid_config");
          continue;
        }

        const config = result.data;

        // Ensure event matches filename.
        if (config.event !== hookName) {
          this.#logger.warn(
            { path: hookPath, expected: hookName, got: config.event },
            "plugin.hook.event_mismatch",
          );
          continue;
        }

        hooks.push({
          id: namespaced(plugin.manifest.id, hookName),
          pluginId: plugin.manifest.id,
          event: hookName as HookEventKind,
          config: config as HookConfig,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.#logger.warn({ path: hookPath, reason }, "plugin.hook.load_failed");
      }
    }

    return hooks;
  }
}

// ---------------------------------------------------------------------------
// Singleton loader
// ---------------------------------------------------------------------------

let globalLoader: PluginLoader | null = null;

/**
 * Get the global plugin loader singleton.
 */
export function getPluginLoader(opts?: PluginLoaderOptions): PluginLoader {
  if (!globalLoader) {
    globalLoader = new PluginLoader(opts);
  }
  return globalLoader;
}

/**
 * Reset the global plugin loader (for testing).
 */
export function _resetPluginLoader(): void {
  globalLoader = null;
}
