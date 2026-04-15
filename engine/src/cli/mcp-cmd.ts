/**
 * `jellyclaw mcp list` — Phase 10.01.
 *
 * Loads the MCP block from the effective config, boots an `McpRegistry`
 * with a short connect timeout, and prints one row per configured server:
 *
 *   SERVER  STATUS  TOOLS
 *
 * STATUS is derived from `registry.snapshot()` — `live`, `dead`, or
 * `retrying`. TOOLS is the comma-separated list of namespaced tool names
 * currently advertised by the server; rows are truncated to 120 chars
 * so one misbehaving server cannot blow up the terminal.
 *
 * Failure policy: the action exits 0 regardless of individual server
 * health — a dead server shows up as `dead` in the table, which is the
 * information the user asked for. Only a catastrophic loader error
 * produces a non-zero exit.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type JellyclawConfig, loadConfigFromFile } from "../config.js";
import { createLogger, type Logger } from "../logger.js";
import { McpRegistry } from "../mcp/registry.js";
import type {
  McpRegistryOptions,
  OAuthConfig as RegistryOAuthConfig,
  McpServerConfig as RegistryServerConfig,
} from "../mcp/types.js";

const CONNECT_TIMEOUT_MS = 5_000;
const OVERALL_TIMEOUT_MS = 10_000;
const ROW_MAX = 120;

export interface McpListOptions {
  readonly configPath?: string;
}

/** Minimal contract the action needs from a registry — for test injection. */
export interface McpRegistryLike {
  start(configs: readonly RegistryServerConfig[]): Promise<void>;
  listTools(): ReadonlyArray<{ readonly server: string; readonly namespacedName: string }>;
  snapshot(): {
    readonly live: readonly string[];
    readonly dead: readonly string[];
    readonly retrying: readonly string[];
  };
  stop(): Promise<void>;
}

export interface McpListDeps {
  readonly cwd?: string;
  readonly loadFromFile?: (path: string) => Promise<JellyclawConfig>;
  readonly fileExists?: (path: string) => boolean;
  readonly registryFactory?: (opts: McpRegistryOptions) => McpRegistryLike;
  readonly logger?: Logger;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly overallTimeoutMs?: number;
}

function loadConfig(opts: McpListOptions, deps: McpListDeps): Promise<JellyclawConfig | undefined> {
  const loader = deps.loadFromFile ?? loadConfigFromFile;
  const exists = deps.fileExists ?? existsSync;
  if (opts.configPath) return loader(opts.configPath);
  const cwd = deps.cwd ?? process.cwd();
  const local = resolve(cwd, "jellyclaw.json");
  if (exists(local)) return loader(local);
  return Promise.resolve(undefined);
}

/**
 * Map the legacy `JellyclawConfig.mcp` shape (config.ts) to the shape
 * expected by the MCP registry (mcp/types.ts). The two overlap by design
 * but the registry's `McpServerConfig` is a narrower readonly view that
 * omits `enabled` / `timeoutMs` (the registry owns its own timeout).
 */
function normalizeOAuth(
  oauth:
    | {
        clientId: string;
        scope?: string | undefined;
        authorizeUrl?: string | undefined;
        tokenUrl?: string | undefined;
        callbackPort?: number | undefined;
      }
    | undefined,
): RegistryOAuthConfig | undefined {
  if (!oauth) return undefined;
  const out: {
    clientId: string;
    scope?: string;
    authorizeUrl?: string;
    tokenUrl?: string;
    callbackPort?: number;
  } = {
    clientId: oauth.clientId,
  };
  if (oauth.scope !== undefined) out.scope = oauth.scope;
  if (oauth.authorizeUrl !== undefined) out.authorizeUrl = oauth.authorizeUrl;
  if (oauth.tokenUrl !== undefined) out.tokenUrl = oauth.tokenUrl;
  if (oauth.callbackPort !== undefined) out.callbackPort = oauth.callbackPort;
  return out;
}

function toRegistryConfigs(servers: JellyclawConfig["mcp"]): readonly RegistryServerConfig[] {
  const out: RegistryServerConfig[] = [];
  for (const srv of servers) {
    if (srv.enabled === false) continue;
    if (srv.transport === "stdio") {
      out.push({
        transport: "stdio",
        name: srv.name,
        command: srv.command,
        args: srv.args,
        env: srv.env,
        ...(srv.cwd !== undefined ? { cwd: srv.cwd } : {}),
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
      });
    } else if (srv.transport === "http") {
      const normalizedOAuth = normalizeOAuth(srv.oauth);
      out.push({
        transport: "http",
        name: srv.name,
        url: srv.url,
        headers: srv.headers,
        ...(normalizedOAuth !== undefined ? { oauth: normalizedOAuth } : {}),
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
      });
    } else {
      const normalizedOAuth = normalizeOAuth(srv.oauth);
      out.push({
        transport: "sse",
        name: srv.name,
        url: srv.url,
        headers: srv.headers,
        ...(normalizedOAuth !== undefined ? { oauth: normalizedOAuth } : {}),
        connectTimeoutMs: CONNECT_TIMEOUT_MS,
      });
    }
  }
  return out;
}

function statusFor(
  name: string,
  snap: {
    readonly live: readonly string[];
    readonly dead: readonly string[];
    readonly retrying: readonly string[];
  },
): string {
  if (snap.live.includes(name)) return "live";
  if (snap.dead.includes(name)) return "dead";
  if (snap.retrying.includes(name)) return "retrying";
  return "unknown";
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function padRight(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + " ".repeat(width - value.length);
}

const SERVER_WIDTH = 24;
const STATUS_WIDTH = 10;

function formatRow(server: string, status: string, tools: string): string {
  return truncate(
    [
      padRight(truncate(server, SERVER_WIDTH), SERVER_WIDTH),
      padRight(truncate(status, STATUS_WIDTH), STATUS_WIDTH),
      tools,
    ].join("  "),
    ROW_MAX,
  );
}

export async function mcpListAction(
  opts: McpListOptions = {},
  deps: McpListDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const logger = deps.logger ?? createLogger({ level: "error" });
  const factory = deps.registryFactory ?? ((o: McpRegistryOptions) => new McpRegistry(o));

  let config: JellyclawConfig | undefined;
  try {
    config = await loadConfig(opts, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`mcp list: ${message}\n`);
    return 1;
  }

  const servers = config ? toRegistryConfigs(config.mcp) : [];
  if (servers.length === 0) {
    stdout.write("no MCP servers configured\n");
    return 0;
  }

  const registry = factory({
    logger,
    connectTimeoutMs: CONNECT_TIMEOUT_MS,
  });

  const overall = deps.overallTimeoutMs ?? OVERALL_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
  }, overall);
  try {
    await Promise.race([
      registry.start(servers),
      new Promise<void>((resolvePromise) => setTimeout(resolvePromise, overall)),
    ]);
  } catch (err) {
    // `start()` uses `Promise.allSettled` internally, so it should never
    // reject. Log defensively and carry on — the snapshot below is still
    // the user-facing truth.
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`mcp list: registry start error (ignored): ${message}\n`);
  } finally {
    clearTimeout(timer);
  }

  const snapshot = registry.snapshot();
  const tools = registry.listTools();
  const toolsByServer = new Map<string, string[]>();
  for (const t of tools) {
    const list = toolsByServer.get(t.server) ?? [];
    list.push(t.namespacedName);
    toolsByServer.set(t.server, list);
  }

  stdout.write(`${formatRow("SERVER", "STATUS", "TOOLS")}\n`);
  for (const srv of servers) {
    const status = statusFor(srv.name, snapshot);
    const names = (toolsByServer.get(srv.name) ?? []).join(", ");
    stdout.write(`${formatRow(srv.name, status, names)}\n`);
  }

  if (timedOut) {
    stderr.write(
      `mcp list: overall connect budget (${overall}ms) exceeded; some servers may appear as retrying\n`,
    );
  }

  await registry.stop();
  return 0;
}
