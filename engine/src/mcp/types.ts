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
 * OAuth 2.1 + PKCE configuration for an HTTP-ish MCP server.
 *
 * Discovery: when `authorizeUrl`/`tokenUrl` are omitted, the SDK's auth
 * helper resolves them via `GET <base>/.well-known/oauth-authorization-server`.
 * Explicit values win.
 *
 * `callbackPort` is fixed (not random) because `redirect_uri` is
 * registered with the authorization server and must match exactly.
 * Default is the jellyclaw reserved port `47419` (free/reserved via
 * IANA user range; unlikely to collide with a running service).
 */
export interface OAuthConfig {
  readonly clientId: string;
  readonly scope?: string;
  readonly authorizeUrl?: string;
  readonly tokenUrl?: string;
  readonly callbackPort?: number;
}

/** Shared fields for HTTP and SSE transports. */
interface HttpishCommon {
  readonly name: string;
  readonly url: string;
  /**
   * Static headers added to every outbound request. Values here are
   * treated as secrets by the logger-scrubber (same policy as stdio
   * `env`). Do not use this for `Authorization: Bearer <token>` — that
   * lives in the OAuth layer.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly oauth?: OAuthConfig;
  readonly connectTimeoutMs?: number;
}

/**
 * Config for a StreamableHTTP-transport MCP server (the 2025 unified
 * HTTP transport — supports both POST/response and SSE upgrades
 * through the same endpoint).
 */
export interface HttpMcpServerConfig extends HttpishCommon {
  readonly transport: "http";
}

/**
 * Config for a legacy SSE-transport MCP server. Deprecated by the MCP
 * spec but retained during the migration window.
 */
export interface SseMcpServerConfig extends HttpishCommon {
  readonly transport: "sse";
}

/**
 * Discriminated union over all supported transports. The `transport`
 * field is the discriminant; every consumer switches on it and
 * TypeScript will flag missing arms.
 */
export type McpServerConfig = StdioMcpServerConfig | HttpMcpServerConfig | SseMcpServerConfig;

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
// Namespacing — implementation lives in ./namespacing.ts; these aliases
// preserve the pre-Prompt-02 import path for existing callers (registry,
// client-stdio). New code should import from ./namespacing directly.
// ---------------------------------------------------------------------------

export {
  NAMESPACED_TOOL_RE,
  namespace as namespaceTool,
  parse as parseNamespaced,
} from "./namespacing.js";

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
