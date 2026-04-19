/**
 * MCP config loader (T0-01).
 *
 * Loads MCP server configurations from up to three sources, merging them
 * with a first-write-wins policy on server `name`:
 *
 *   1. `--mcp-config <path>` CLI flag (highest priority)
 *   2. `<cwd>/jellyclaw.json` `.mcp[]` array
 *   3. `~/.jellyclaw/jellyclaw.json` `.mcp[]` array (lowest priority)
 *
 * Error handling:
 *   - If `--mcp-config` is passed and the file doesn't exist → throw ExitError(4)
 *   - If `--mcp-config` is passed and the JSON is invalid → propagate zod error
 *   - Empty `.mcp[]` array is a no-op, not an error
 *   - Never mutates input configs
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type McpServerConfig as ConfigMcpServerConfig,
  type OAuthConfig as ConfigOAuthConfig,
  JellyclawConfig,
} from "../config.js";
import type { Logger } from "../logger.js";
import type {
  McpServerConfig as RegistryMcpServerConfig,
  OAuthConfig as RegistryOAuthConfig,
} from "../mcp/types.js";
import { ExitError } from "./main.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface LoadMcpConfigsOptions {
  /** Explicit `--mcp-config <path>` flag from CLI. */
  readonly mcpConfig?: string | undefined;
  /** Config directory override (for `~/.jellyclaw`). */
  readonly configDir?: string | undefined;
  /** Current working directory (for `<cwd>/jellyclaw.json`). */
  readonly cwd: string;
  /** Logger for warnings about duplicate server names. */
  readonly logger?: Logger | undefined;
}

export interface LoadMcpConfigsDeps {
  readonly fileExists?: (path: string) => boolean;
  readonly readFile?: (path: string) => Promise<string>;
  readonly homedir?: () => string;
}

/** Default connect timeout for MCP servers (matches McpRegistry default).
 * 30s accommodates slow-starting servers (Playwright, browser-launching MCPs)
 * whose first-connect probe exceeds a tight 10s budget. */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * Expand `${VAR}` and `${VAR:-default}` placeholders in a string.
 *
 * - `${VAR}` → process.env[VAR] or empty string if unset
 * - `${VAR:-default}` → process.env[VAR] if set and non-empty, else "default"
 *
 * The `:-` syntax matches Bash semantics: use default if VAR is unset OR empty.
 * An optional `requestEnv` overlay takes precedence over process.env.
 */
function expandEnv(v: string, requestEnv?: Record<string, string>): string {
  // Pattern: ${VAR} or ${VAR:-default}
  return v.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (_, varName: string, defaultVal?: string) => {
    // Check requestEnv first (per-request overlay), then process.env
    const envVal = requestEnv?.[varName] ?? process.env[varName];
    // If VAR is set and non-empty, use it; otherwise use default (or empty if no default)
    if (envVal !== undefined && envVal !== "") {
      return envVal;
    }
    return defaultVal ?? "";
  });
}

/**
 * Expand env vars in all header values.
 */
function expandHeaders(
  headers: Record<string, string>,
  requestEnv?: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    result[k] = expandEnv(v, requestEnv);
  }
  return result;
}

/**
 * Convert a config-file OAuth config to the registry's expected type.
 * Handles `exactOptionalPropertyTypes` by only spreading defined fields.
 */
function toRegistryOAuth(oauth: ConfigOAuthConfig | undefined): RegistryOAuthConfig | undefined {
  if (oauth === undefined) return undefined;
  const result: RegistryOAuthConfig = { clientId: oauth.clientId };
  if (oauth.scope !== undefined) (result as { scope?: string }).scope = oauth.scope;
  if (oauth.authorizeUrl !== undefined)
    (result as { authorizeUrl?: string }).authorizeUrl = oauth.authorizeUrl;
  if (oauth.tokenUrl !== undefined) (result as { tokenUrl?: string }).tokenUrl = oauth.tokenUrl;
  if (oauth.callbackPort !== undefined)
    (result as { callbackPort?: number }).callbackPort = oauth.callbackPort;
  return result;
}

/**
 * Convert a config-file MCP server config to the registry's expected type.
 * Strips `enabled` and `timeoutMs`, maps `timeoutMs` -> `connectTimeoutMs`.
 */
function toRegistryConfig(cfg: ConfigMcpServerConfig): RegistryMcpServerConfig {
  if (cfg.transport === "stdio") {
    const result: RegistryMcpServerConfig = {
      transport: "stdio",
      name: cfg.name,
      command: cfg.command,
      connectTimeoutMs: cfg.timeoutMs ?? CONNECT_TIMEOUT_MS,
    };
    if (cfg.args.length > 0) (result as { args?: readonly string[] }).args = cfg.args;
    if (Object.keys(cfg.env).length > 0)
      (result as { env?: Readonly<Record<string, string>> }).env = cfg.env;
    if (cfg.cwd !== undefined) (result as { cwd?: string }).cwd = cfg.cwd;
    return result;
  }
  if (cfg.transport === "http") {
    const result: RegistryMcpServerConfig = {
      transport: "http",
      name: cfg.name,
      url: cfg.url,
      connectTimeoutMs: cfg.timeoutMs ?? CONNECT_TIMEOUT_MS,
    };
    const expandedHeaders = expandHeaders(cfg.headers);
    if (Object.keys(expandedHeaders).length > 0)
      (result as { headers?: Readonly<Record<string, string>> }).headers = expandedHeaders;
    const oauth = toRegistryOAuth(cfg.oauth);
    if (oauth !== undefined) (result as { oauth?: RegistryOAuthConfig }).oauth = oauth;
    return result;
  }
  // sse
  const result: RegistryMcpServerConfig = {
    transport: "sse",
    name: cfg.name,
    url: cfg.url,
    connectTimeoutMs: cfg.timeoutMs ?? CONNECT_TIMEOUT_MS,
  };
  const expandedHeaders = expandHeaders(cfg.headers);
  if (Object.keys(expandedHeaders).length > 0)
    (result as { headers?: Readonly<Record<string, string>> }).headers = expandedHeaders;
  const oauth = toRegistryOAuth(cfg.oauth);
  if (oauth !== undefined) (result as { oauth?: RegistryOAuthConfig }).oauth = oauth;
  return result;
}

/**
 * Load MCP server configs from multiple sources, merging with first-write-wins.
 *
 * @throws ExitError if explicit `--mcp-config` doesn't exist or is invalid JSON
 */
export async function loadMcpConfigs(
  opts: LoadMcpConfigsOptions,
  deps: LoadMcpConfigsDeps = {},
): Promise<readonly RegistryMcpServerConfig[]> {
  const fileExistsFn = deps.fileExists ?? existsSync;
  const readFileFn = deps.readFile ?? ((p: string) => readFile(p, "utf8"));
  const homedirFn = deps.homedir ?? homedir;

  const sources: Array<{ path: string; source: string }> = [];

  // 1. Explicit --mcp-config flag (highest priority)
  if (opts.mcpConfig !== undefined) {
    const configPath = resolve(opts.cwd, opts.mcpConfig);
    if (!fileExistsFn(configPath)) {
      throw new ExitError(4, `mcp config not found: ${configPath}`);
    }
    sources.push({ path: configPath, source: "cli flag" });
  }

  // 2. <cwd>/jellyclaw.json
  const cwdConfig = join(opts.cwd, "jellyclaw.json");
  if (fileExistsFn(cwdConfig)) {
    sources.push({ path: cwdConfig, source: "cwd" });
  }

  // 3. ~/.jellyclaw/jellyclaw.json
  const configDir = opts.configDir ?? join(homedirFn(), ".jellyclaw");
  const homeConfig = join(configDir, "jellyclaw.json");
  if (fileExistsFn(homeConfig)) {
    sources.push({ path: homeConfig, source: "home" });
  }

  // Merge configs with first-write-wins on server name
  const seenNames = new Map<string, string>(); // name -> source that owns it
  const result: RegistryMcpServerConfig[] = [];

  for (const { path, source } of sources) {
    let raw: string;
    try {
      raw = await readFileFn(path);
    } catch {
      // File disappeared between check and read — skip silently
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      // If this is the explicit --mcp-config flag, propagate the error
      if (source === "cli flag") {
        throw new ExitError(
          4,
          `mcp config invalid JSON: ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Otherwise, skip silently (corrupted local config shouldn't brick the CLI)
      continue;
    }

    // Validate through zod — this extracts the .mcp array with defaults
    let config: JellyclawConfig;
    try {
      config = JellyclawConfig.parse(parsed);
    } catch (err) {
      // If this is the explicit --mcp-config flag, propagate the zod error
      if (source === "cli flag") {
        throw new ExitError(
          4,
          `mcp config schema error: ${path}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // Otherwise, skip silently
      continue;
    }

    // Merge servers with first-write-wins
    for (const server of config.mcp) {
      if (server.enabled === false) continue;
      if (server._disabled === true) continue;

      // Skip entries whose required env vars aren't set. Lets the default
      // template ship active-by-default for users who have the key, silent
      // for users who don't — no error, no stub.
      const requiresEnv = server._requires_env;
      if (Array.isArray(requiresEnv) && requiresEnv.length > 0) {
        const missing = requiresEnv.filter((k) => !process.env[k]);
        if (missing.length > 0) {
          opts.logger?.debug?.(
            { server: server.name, missing },
            "mcp: skipping entry — required env var(s) unset",
          );
          continue;
        }
        // Emit info log when Exa (or any env-gated MCP) loads
        opts.logger?.info?.({ server: server.name }, "mcp: env-gated server enabled");
      }

      const existing = seenNames.get(server.name);
      if (existing !== undefined) {
        // Log WARN about duplicate
        opts.logger?.warn(
          { name: server.name, winner: existing, duplicate: source },
          `mcp server "${server.name}" configured in multiple sources; using ${existing}`,
        );
        continue;
      }

      seenNames.set(server.name, source);
      // Convert from config schema to registry schema
      result.push(toRegistryConfig(server));
    }
  }

  return result;
}
