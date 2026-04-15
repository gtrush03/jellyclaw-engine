/**
 * Phase 10.03 — `createEngine(options)` — the blessed entry point for
 * library consumers.
 *
 * Responsibilities (in order):
 *   1. Resolve config: merge `options.config` > `options.configPath` file >
 *      `defaultConfig()` > env. Shape normalization (string provider →
 *      `{type: "..."}`), then zod parse. Zod failure → `ConfigInvalidError`.
 *   2. Build (or accept) a pino-compatible logger.
 *   3. Start opencode-ai under loopback + minted 256-bit password.
 *   4. Open the shared SQLite session index.
 *   5. Load registries (skills, agents, mcp, hooks, permissions) in parallel.
 *   6. Wire a Phase 10.02 `RunManager`.
 *   7. Construct the `Engine` via the internal factory.
 *
 * Mid-construction failures roll back in reverse order via `Promise.allSettled`.
 */

import { z } from "zod";
import { AgentRegistry } from "./agents/registry.js";
import type { OpenCodeHandle } from "./bootstrap/opencode-server.js";
import { startOpenCode } from "./bootstrap/opencode-server.js";
import { defaultConfig, type JellyclawConfig, loadConfigFromFile, parseConfig } from "./config.js";
import { ConfigInvalidError, type Engine, type EngineInternals, newEngine } from "./engine.js";
import { HookRegistry } from "./hooks/registry.js";
import type { Logger } from "./logger.js";
import { createLogger } from "./logger.js";
import { McpRegistry } from "./mcp/registry.js";
import type { McpServerConfig as McpRegistryServerConfig } from "./mcp/types.js";
import { compilePermissions } from "./permissions/rules.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import type { Provider } from "./providers/types.js";
import type { EngineOptions } from "./public-types.js";
import { createRunManager } from "./server/run-manager.js";
import { type Db, openDb } from "./session/db.js";
import { SessionPaths } from "./session/paths.js";
import { SkillRegistry } from "./skills/registry.js";

interface LoggerLike {
  info: unknown;
  warn: unknown;
  error: unknown;
}

function looksLikeLogger(x: unknown): x is Logger {
  if (!x || typeof x !== "object") return false;
  const l = x as Partial<LoggerLike>;
  return (
    typeof l.info === "function" && typeof l.warn === "function" && typeof l.error === "function"
  );
}

async function resolveConfig(options: EngineOptions): Promise<JellyclawConfig> {
  // Precedence: explicit inline `config` > configPath file > cwd jellyclaw.json > defaults.
  let merged: Record<string, unknown> | undefined;
  if (options.configPath) {
    const fromFile = await loadConfigFromFile(options.configPath);
    merged = { ...fromFile } as unknown as Record<string, unknown>;
  }
  if (options.config) {
    const inline = normalizeInlineConfig(options.config);
    merged = merged ? { ...merged, ...inline } : { ...inline };
  }
  if (!merged) {
    // No inline + no path → try cwd; fall back to defaults.
    const { existsSync } = await import("node:fs");
    const local = `${options.cwd ?? process.cwd()}/jellyclaw.json`;
    if (existsSync(local)) {
      return loadConfigFromFile(local);
    }
    return defaultConfig();
  }

  // Ensure provider shape is present before parsing.
  if (merged.provider === undefined) merged.provider = { type: "anthropic" };

  const result = parseConfigSafe(merged);
  if (!result.success) throw new ConfigInvalidError(result.error.issues);
  return result.data;
}

function parseConfigSafe(
  input: unknown,
): { success: true; data: JellyclawConfig } | { success: false; error: z.ZodError } {
  try {
    return { success: true, data: parseConfig(input) };
  } catch (err) {
    if (err instanceof z.ZodError) return { success: false, error: err };
    throw err;
  }
}

function normalizeInlineConfig(
  input: NonNullable<EngineOptions["config"]>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const p = out.provider;
  if (typeof p === "string") {
    out.provider = { type: p };
  }
  return out;
}

/**
 * Construct a jellyclaw engine. Idempotent failure semantics — if any
 * construction step throws, all successfully-initialised subsystems are torn
 * down before re-throwing, so callers never see a partially-built engine.
 */
export async function createEngine(options: EngineOptions = {}): Promise<Engine> {
  // Step 1 — config
  const config = await resolveConfig(options);

  // Step 2 — logger
  const logger: Logger = looksLikeLogger(options.logger)
    ? options.logger
    : createLogger({ level: config.logger.level, pretty: config.logger.pretty });

  const cwd = options.cwd ?? process.cwd();
  const sessionPaths = new SessionPaths();

  // Progressive construction — track everything we've built so rollback can
  // run in reverse order if a later step throws.
  let opencode: OpenCodeHandle | null = null;
  let opencodePassword: string | null = null;
  let db: Db | null = null;
  let skills: SkillRegistry | null = null;
  let agents: AgentRegistry | null = null;
  let mcp: McpRegistry | null = null;
  let hooks: HookRegistry | null = null;

  try {
    // Step 3 — start OpenCode (loopback, minted password)
    opencode = await startOpenCode({});
    opencodePassword = opencode.password;

    // Step 4 — open SQLite index
    db = await openDb({ paths: sessionPaths, logger });

    // Step 5 — registries in parallel
    skills = new SkillRegistry();
    agents = new AgentRegistry();
    mcp = new McpRegistry({ logger });
    hooks = new HookRegistry([], { logger });

    await Promise.all([
      skills.loadAll({ logger }).catch((err: unknown) => {
        logger.warn({ err }, "createEngine: skills.loadAll failed; continuing");
      }),
      agents.loadAll({ logger }).catch((err: unknown) => {
        logger.warn({ err }, "createEngine: agents.loadAll failed; continuing");
      }),
      config.mcp.length > 0
        ? mcp
            .start(config.mcp as unknown as readonly McpRegistryServerConfig[])
            .catch((err: unknown) => {
              logger.warn(
                { err },
                "createEngine: mcp.start had failures; unreachable servers will retry",
              );
            })
        : Promise.resolve(),
    ]);

    const permissions = compilePermissions({
      mode: config.permissions.mode === "strict" ? "default" : "default",
      allow: config.permissions.allow,
      deny: config.permissions.deny,
    });

    // Step 6 — RunManager (wired with the real agent loop when the config
    // provides everything `runAgentLoop` needs). Library consumers who don't
    // configure a provider API key still get a manager — it transparently
    // falls back to the Phase-0 stub iterator.
    let provider: Provider | undefined;
    if (config.provider.type === "anthropic") {
      const apiKey = config.provider.apiKey ?? process.env.ANTHROPIC_API_KEY;
      if (apiKey !== undefined && apiKey.length > 0) {
        const anthropicDeps: {
          apiKey: string;
          logger: Logger;
          baseURL?: string;
        } = { apiKey, logger };
        if (config.provider.baseURL !== undefined) {
          anthropicDeps.baseURL = config.provider.baseURL;
        }
        provider = new AnthropicProvider(anthropicDeps);
      }
    }
    const runManager = createRunManager({
      logger,
      paths: sessionPaths,
      db,
      ...(provider !== undefined ? { provider } : {}),
      hooks,
      permissions,
      defaultModel: config.provider.defaultModel,
      defaultCwd: cwd,
    });

    // Step 7 — Engine
    const internals: EngineInternals = {
      config,
      logger,
      runManager,
      sessionPaths,
      db,
      registries: {
        skills,
        agents,
        mcp,
        hooks,
        permissions,
      },
      opencode,
      opencodePassword,
      providerOverride: options.providerOverride ?? null,
      skillWatcher: null,
      cwd,
      disposed: false,
      disposePromise: null,
    };

    return newEngine(internals);
  } catch (err) {
    // Roll back in reverse order.
    const tasks: Promise<unknown>[] = [];
    if (mcp) {
      tasks.push(
        mcp.stop().catch((e: unknown) => {
          logger.warn({ err: e }, "createEngine rollback: mcp.stop failed");
        }),
      );
    }
    await Promise.allSettled(tasks);

    if (db) {
      try {
        db.close();
      } catch (e) {
        logger.warn({ err: e }, "createEngine rollback: db.close failed");
      }
    }
    if (opencode) {
      try {
        await opencode.kill();
      } catch (e) {
        logger.warn({ err: e }, "createEngine rollback: opencode.kill failed");
      }
    }
    throw err;
  }
}
