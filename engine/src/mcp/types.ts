/**
 * MCP (Model Context Protocol) client types.
 *
 * Phase 07 Prompt 01 covers stdio only. Prompt 02 adds HTTP/SSE. The
 * `McpTransport` discriminant is defined with all three variants now so
 * the downstream callers (registry, Task-tool wiring) don't have to be
 * rewritten when the other transports land — but only `"stdio"` is
 * constructible through this prompt's factories.
 *
 * Namespacing: tools from MCP servers are exposed to the model as
 * `mcp__<server>__<tool>`. The server prefix makes collisions impossible
 * across servers. Namespace construction/parsing lives in this module so
 * both stdio and HTTP paths reuse it.
 */

import type { Logger } from "pino";

// ---------------------------------------------------------------------------
// Server config (what a caller hands to the factory)
// ---------------------------------------------------------------------------

/**
 * Config for a stdio-transport MCP server.
 *
 * The repo's root `JellyclawConfig.mcp` array stores a slightly different
 * shape today (no `transport` field, secrets named only by key in `env`).
 * Prompt 02 will extend the root schema to tag each entry with
 * `transport: "stdio" | "http" | "sse"`; until then, the adapter from
 * `JellyclawConfig.mcp[]` → `McpServerConfig` treats every entry as stdio.
 */
export interface StdioMcpServerConfig {
  readonly transport: "stdio";
  /** Unique server name. Used as the tool-namespace prefix. */
  readonly name: string;
  /** Executable. Never passed through a shell (`shell: true` is forbidden). */
  readonly command: string;
  readonly args?: readonly string[];
  /**
   * Environment variables passed to the child. VALUES here are treated
   * as secrets by `credential-strip.ts` — any occurrence of a value in
   * stderr/stdout/error-messages is replaced with `[REDACTED]` before
   * being logged.
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory for the spawned process. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /**
   * Connection-attempt timeout. Applies to spawn + SDK `connect()` +
   * initial `listTools()`. Defaults to 10_000 ms in the registry.
   */
  readonly connectTimeoutMs?: number;
}

/**
 * Union type reserved for prompt 02 (HTTP + SSE variants). Only the
 * `"stdio"` arm is callable in prompt 01.
 */
export type McpServerConfig = StdioMcpServerConfig;

export type McpTransport = McpServerConfig["transport"];

// ---------------------------------------------------------------------------
// Tool shape (what the model / registry sees)
// ---------------------------------------------------------------------------

/**
 * A single tool exposed by an MCP server, normalized to the shape the
 * engine's tool loop expects. `inputSchema` is whatever the server
 * returned (JSON-Schema-ish); we do not re-validate here.
 */
export interface McpTool {
  /** Raw tool name as the server reported it (unnamespaced). */
  readonly name: string;
  /** Namespaced name as exposed to the model: `mcp__<server>__<name>`. */
  readonly namespacedName: string;
  readonly description?: string | undefined;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Name of the server this tool came from. */
  readonly server: string;
}

// ---------------------------------------------------------------------------
// Client contract
// ---------------------------------------------------------------------------

export type McpClientStatus =
  /** spawn + connect in flight, no tools listed yet */
  | "connecting"
  /** connected, tools listed, ready to call */
  | "ready"
  /** lost connection, reconnect attempt in flight */
  | "reconnecting"
  /** reconnect gave up; client is terminal */
  | "dead"
  /** explicitly closed via `stop()` */
  | "closed";

/**
 * Minimal lifecycle events emitted by an `McpClient`. The registry
 * subscribes to these to maintain its live-tool index and surface
 * warnings through the engine's logger.
 */
export type McpClientEvent =
  | { readonly type: "mcp.connected"; readonly server: string; readonly toolCount: number }
  | { readonly type: "mcp.disconnected"; readonly server: string; readonly reason: string }
  | { readonly type: "mcp.reconnected"; readonly server: string; readonly toolCount: number }
  | { readonly type: "mcp.dead"; readonly server: string; readonly reason: string };

export type McpClientListener = (event: McpClientEvent) => void;

/**
 * Result of `callTool()`. Mirrors the SDK's CallToolResult but typed
 * narrowly for our consumers. Structured content is kept `unknown` so
 * we don't freeze a schema the registry doesn't own.
 */
export interface McpCallToolResult {
  readonly isError: boolean;
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
    | { readonly type: "resource"; readonly resource: Readonly<Record<string, unknown>> }
    | { readonly type: string; readonly [k: string]: unknown }
  >;
  readonly structuredContent?: unknown;
}

/**
 * Shape exposed by any MCP client factory (stdio, HTTP, SSE).
 *
 * A client is owned by the registry; callers outside the registry must
 * not `start()`/`stop()` it directly.
 */
export interface McpClient {
  readonly server: string;
  readonly status: McpClientStatus;
  /** Tools advertised by the server as of the last successful connect. */
  readonly tools: readonly McpTool[];

  /** Spawn + connect + list tools. Resolves on success; rejects on timeout or fatal error. */
  start(): Promise<void>;
  /** Invoke a tool by its **unnamespaced** name. The namespace layer lives in the registry. */
  callTool(name: string, input: unknown): Promise<McpCallToolResult>;
  /** Graceful shutdown. Safe to call multiple times. */
  stop(): Promise<void>;

  /** Subscribe to lifecycle events. Returns an unsubscribe function. */
  subscribe(listener: McpClientListener): () => void;
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface McpClientFactoryOptions {
  readonly logger: Logger;
  /** Overrides the default exponential-backoff schedule (for tests). */
  readonly reconnectSchedule?: readonly number[];
  /** Max reconnect attempts before marking the client `dead`. */
  readonly maxReconnectAttempts?: number;
  /** SIGTERM → SIGKILL grace period during `stop()` / respawn. */
  readonly killGraceMs?: number;
  /** Connect timeout override (ms); also falls back to `config.connectTimeoutMs`. */
  readonly connectTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Namespacing
// ---------------------------------------------------------------------------

/** Regex for a valid namespaced tool. `mcp__<server>__<tool>`. */
export const NAMESPACED_TOOL_RE = /^mcp__([a-z0-9_-]+)__(.+)$/;

/**
 * Namespace a raw tool name for exposure to the model.
 *
 * Server names must match `[a-z0-9_-]+`; enforced here as a defensive
 * check (config validation is upstream).
 */
export function namespaceTool(server: string, tool: string): string {
  if (!/^[a-z0-9_-]+$/.test(server)) {
    throw new Error(`invalid MCP server name '${server}' (must match [a-z0-9_-]+)`);
  }
  return `mcp__${server}__${tool}`;
}

/**
 * Parse a namespaced tool name back into its parts. Returns `null` when
 * the string is not in the expected shape.
 */
export function parseNamespaced(
  namespaced: string,
): { readonly server: string; readonly tool: string } | null {
  const m = NAMESPACED_TOOL_RE.exec(namespaced);
  if (!m?.[1] || !m[2]) return null;
  return { server: m[1], tool: m[2] };
}

// ---------------------------------------------------------------------------
// Registry contract (implementation lives in registry.ts)
// ---------------------------------------------------------------------------

export interface McpRegistryOptions {
  readonly logger: Logger;
  /** Per-connection timeout used by `start()`. Defaults to 10_000 ms. */
  readonly connectTimeoutMs?: number;
  /** Retry interval for dead servers. Defaults to 30_000 ms. */
  readonly retryIntervalMs?: number;
  /** Dependency-injection seam used by tests. */
  readonly clientFactory?: (config: McpServerConfig, opts: McpClientFactoryOptions) => McpClient;
}

export interface McpRegistrySnapshot {
  readonly live: readonly string[];
  readonly dead: readonly string[];
  readonly retrying: readonly string[];
}

export class McpUnknownServerError extends Error {
  override readonly name = "McpUnknownServerError";
  constructor(
    readonly server: string,
    readonly namespacedName: string,
  ) {
    super(`unknown_server: no live MCP server '${server}' for tool '${namespacedName}'`);
  }
}

export class McpNotReadyError extends Error {
  override readonly name = "McpNotReadyError";
  constructor(
    readonly server: string,
    readonly status: McpClientStatus,
  ) {
    super(`mcp server '${server}' is not ready (status=${status})`);
  }
}
