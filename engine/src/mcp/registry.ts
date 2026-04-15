/**
 * Phase 07 Prompt 01 — MCP client registry.
 *
 * Owns the full set of configured MCP clients: parallel connect on
 * `start()`, namespaced tool index, routed `callTool`, background retry
 * for dead servers, clean teardown on `stop()`.
 *
 * Failure policy:
 *   - A single server failing to connect MUST NOT abort engine start.
 *     Failures are logged as `warn` and the server is scheduled for
 *     background retry every `retryIntervalMs` (default 30 s).
 *   - `listTools()` returns only tools from clients currently in the
 *     `"ready"` status.
 *   - `callTool("mcp__srv__tool", ...)` routes to the live client for
 *     `srv`, or rejects with `McpUnknownServerError`. If the server
 *     exists but is not ready, the client itself rejects with
 *     `McpNotReadyError`.
 *
 * The registry is transport-agnostic: it constructs clients through
 * `opts.clientFactory` (DI seam for tests). Prompt 02 will extend the
 * factory switch to HTTP/SSE variants.
 */

import type { Logger } from "../logger.js";
import { createHttpMcpClient } from "./client-http.js";
import { createSseMcpClient } from "./client-sse.js";
import { createStdioMcpClient } from "./client-stdio.js";
import {
  type McpCallToolResult,
  type McpClient,
  type McpClientEvent,
  type McpClientFactoryOptions,
  type McpRegistryOptions,
  type McpRegistrySnapshot,
  type McpServerConfig,
  type McpTool,
  McpUnknownServerError,
  parseNamespaced,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_INTERVAL_MS = 30_000;

interface Entry {
  readonly config: McpServerConfig;
  client: McpClient;
  unsubscribe: () => void;
  /** Set once the client has reached `"dead"` and we've armed a retry timer. */
  retryTimer?: ReturnType<typeof setTimeout> | undefined;
  /** True once `stop()` has begun, blocks any in-flight retry from firing. */
  stopped: boolean;
}

function defaultClientFactory(config: McpServerConfig, opts: McpClientFactoryOptions): McpClient {
  // Transport dispatch. Phase 07 Prompt 01 is stdio-only; Prompt 02 will
  // add HTTP + SSE arms here. The discriminant keeps that extension
  // type-safe — a missing arm surfaces as a `never` assignment.
  switch (config.transport) {
    case "stdio":
      return createStdioMcpClient(config, opts);
    case "http":
      return createHttpMcpClient(config, opts);
    case "sse":
      return createSseMcpClient(config, opts);
    default: {
      // All transport variants handled above — this branch is unreachable
      // and `config` is narrowed to `never`.
      const _exhaustive: never = config;
      throw new Error(`unsupported MCP transport: ${String(_exhaustive)}`);
    }
  }
}

export class McpRegistry {
  readonly #logger: Logger;
  readonly #connectTimeoutMs: number;
  readonly #retryIntervalMs: number;
  readonly #clientFactory: (config: McpServerConfig, opts: McpClientFactoryOptions) => McpClient;
  readonly #entries = new Map<string, Entry>();
  #stopped = false;

  constructor(opts: McpRegistryOptions) {
    this.#logger = opts.logger;
    this.#connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#retryIntervalMs = opts.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    this.#clientFactory = opts.clientFactory ?? defaultClientFactory;
  }

  /**
   * Connect every server in parallel with `Promise.allSettled`. Each
   * connect carries its own timeout via `clientFactory` options. A
   * rejection here means the *first* connect failed — the client is
   * allowed to transition to `dead` asynchronously through its
   * reconnect loop; we arm a background retry either way.
   */
  async start(configs: readonly McpServerConfig[]): Promise<void> {
    if (this.#stopped) {
      throw new Error("McpRegistry: start() called after stop()");
    }
    // Build clients first so listeners are wired before any connect
    // emits an early "disconnected" event.
    for (const config of configs) {
      if (this.#entries.has(config.name)) {
        this.#logger.warn(
          { server: config.name },
          "mcp: duplicate server name in config; ignoring later entry",
        );
        continue;
      }
      this.#buildEntry(config);
    }

    await Promise.allSettled(
      [...this.#entries.values()].map(async (entry) => {
        try {
          await entry.client.start();
        } catch (err) {
          // start() rejection is a "first connect failed" signal. The
          // client may still be trying to reconnect internally (spawn
          // failure terminates that loop quickly). Arm a background
          // retry so transient issues (e.g. the server binary being
          // installed later) are recoverable.
          this.#logger.warn(
            { server: entry.config.name, reason: safeErrorMessage(err) },
            "mcp: initial connect failed; will retry in background",
          );
          this.#scheduleRetry(entry);
        }
      }),
    );
  }

  /**
   * Return every tool from every `ready` client. Tool `name` is the raw
   * (unnamespaced) server tool; `namespacedName` is what the model sees.
   */
  listTools(): McpTool[] {
    const out: McpTool[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.client.status === "ready") {
        out.push(...entry.client.tools);
      }
    }
    return out;
  }

  /**
   * Route a namespaced tool call. The registry does NOT cache
   * `status === "ready"` from before the call — the client checks at
   * call time and rejects with `McpNotReadyError` if it has since
   * disconnected.
   */
  callTool(namespacedName: string, input: unknown): Promise<McpCallToolResult> {
    const parsed = parseNamespaced(namespacedName);
    if (!parsed) {
      return Promise.reject(new McpUnknownServerError(namespacedName, namespacedName));
    }
    const entry = this.#entries.get(parsed.server);
    if (!entry) {
      return Promise.reject(new McpUnknownServerError(parsed.server, namespacedName));
    }
    return entry.client.callTool(parsed.tool, input);
  }

  /**
   * Snapshot of the registry state. Useful for the CLI smoke script and
   * for telemetry later.
   */
  snapshot(): McpRegistrySnapshot {
    const live: string[] = [];
    const dead: string[] = [];
    const retrying: string[] = [];
    for (const [name, entry] of this.#entries) {
      const status = entry.client.status;
      if (status === "ready") live.push(name);
      else if (status === "dead") {
        dead.push(name);
        if (entry.retryTimer) retrying.push(name);
      } else if (status === "reconnecting") retrying.push(name);
    }
    return { live, dead, retrying };
  }

  /**
   * Stop every client in parallel. Cancels all pending retry timers
   * first so nothing respawns mid-shutdown. Safe to call multiple times.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    const stops: Promise<void>[] = [];
    for (const entry of this.#entries.values()) {
      entry.stopped = true;
      if (entry.retryTimer) {
        clearTimeout(entry.retryTimer);
        entry.retryTimer = undefined;
      }
      entry.unsubscribe();
      stops.push(
        entry.client.stop().catch((err) => {
          this.#logger.warn(
            { server: entry.config.name, reason: safeErrorMessage(err) },
            "mcp: error during client stop (ignored)",
          );
        }),
      );
    }
    await Promise.allSettled(stops);
    this.#entries.clear();
  }

  #buildEntry(config: McpServerConfig): Entry {
    const factoryOpts: McpClientFactoryOptions = {
      logger: this.#logger,
      connectTimeoutMs: this.#connectTimeoutMs,
    };
    const client = this.#clientFactory(config, factoryOpts);
    const entry: Entry = {
      config,
      client,
      unsubscribe: () => {},
      stopped: false,
    };
    entry.unsubscribe = client.subscribe((event) => this.#onClientEvent(entry, event));
    this.#entries.set(config.name, entry);
    return entry;
  }

  #onClientEvent(entry: Entry, event: McpClientEvent): void {
    switch (event.type) {
      case "mcp.connected":
        this.#logger.info({ server: event.server, tools: event.toolCount }, "mcp: connected");
        break;
      case "mcp.reconnected":
        this.#logger.info({ server: event.server, tools: event.toolCount }, "mcp: reconnected");
        break;
      case "mcp.disconnected":
        this.#logger.warn(
          { server: event.server, reason: event.reason },
          "mcp: disconnected; client is attempting reconnect",
        );
        break;
      case "mcp.dead":
        this.#logger.warn(
          { server: event.server, reason: event.reason },
          "mcp: client marked dead; scheduling background retry",
        );
        this.#scheduleRetry(entry);
        break;
    }
  }

  /**
   * Rebuild-and-reconnect a dead server after `retryIntervalMs`. We
   * construct a fresh client rather than poking the dead one because
   * the SDK's transport is single-use after close.
   */
  #scheduleRetry(entry: Entry): void {
    if (this.#stopped || entry.stopped) return;
    if (entry.retryTimer) return; // already armed

    entry.retryTimer = setTimeout(() => {
      entry.retryTimer = undefined;
      if (this.#stopped || entry.stopped) return;

      // Unsubscribe from the dead client; replace it. stop() on the
      // dead instance is a best-effort cleanup — it should already be
      // terminal but we await it to guarantee no zombie child.
      entry.unsubscribe();
      const deadClient = entry.client;
      deadClient.stop().catch(() => {});

      const factoryOpts: McpClientFactoryOptions = {
        logger: this.#logger,
        connectTimeoutMs: this.#connectTimeoutMs,
      };
      entry.client = this.#clientFactory(entry.config, factoryOpts);
      entry.unsubscribe = entry.client.subscribe((event) => this.#onClientEvent(entry, event));

      entry.client.start().catch((err) => {
        this.#logger.warn(
          { server: entry.config.name, reason: safeErrorMessage(err) },
          "mcp: background retry failed; will try again",
        );
        // If start() rejects synchronously without the client ever
        // reaching "dead" (e.g. spawn failure fast-path), re-arm.
        if (entry.client.status === "dead" || entry.client.status === "closed") {
          this.#scheduleRetry(entry);
        }
      });
    }, this.#retryIntervalMs);
  }
}

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
