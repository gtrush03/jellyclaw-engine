/**
 * Phase 07 Prompt 02 — SSE MCP client (legacy transport).
 *
 * The MCP spec deprecated SSE-only in favor of StreamableHTTP in 2025,
 * but a long tail of servers still speak SSE during the migration
 * window. This client wires the SDK's `SSEClientTransport` into
 * jellyclaw's `McpClient` lifecycle, sharing the OAuth + token-store
 * plumbing with `client-http.ts`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

import type { Logger } from "../logger.js";
import { buildCredentialScrubber } from "./credential-strip.js";
import { namespace } from "./namespacing.js";
import { createOAuthClientProvider } from "./oauth.js";
import type { TokenStore } from "./token-store.js";
import {
  type McpCallToolResult,
  type McpClient,
  type McpClientEvent,
  type McpClientFactoryOptions,
  type McpClientListener,
  type McpClientStatus,
  McpNotReadyError,
  type McpTool,
  type SseMcpServerConfig,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_SCHEDULE = Object.freeze([500, 1_000, 2_000, 4_000, 8_000]);
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

export interface SseMcpClientFactoryOptions extends McpClientFactoryOptions {
  readonly tokenStore?: TokenStore;
}

export function createSseMcpClient(
  config: SseMcpServerConfig,
  opts: SseMcpClientFactoryOptions,
): McpClient {
  return new SseMcpClient(config, opts);
}

class SseMcpClient implements McpClient {
  readonly server: string;
  #status: McpClientStatus = "connecting";
  #tools: McpTool[] = [];
  #client: Client | undefined = undefined;
  #transport: SSEClientTransport | undefined = undefined;
  readonly #listeners = new Set<McpClientListener>();
  readonly #logger: Logger;
  readonly #scrub: (s: string) => string;
  readonly #connectTimeoutMs: number;
  readonly #reconnectSchedule: readonly number[];
  readonly #maxReconnectAttempts: number;
  readonly #tokenStore: TokenStore | undefined;
  #reconnectTimer?: ReturnType<typeof setTimeout> | undefined;
  #reconnectCancel?: (() => void) | undefined;

  constructor(
    readonly config: SseMcpServerConfig,
    opts: SseMcpClientFactoryOptions,
  ) {
    this.server = config.name;
    this.#logger = opts.logger;
    this.#tokenStore = opts.tokenStore;
    this.#connectTimeoutMs =
      opts.connectTimeoutMs ?? config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#reconnectSchedule = opts.reconnectSchedule ?? DEFAULT_RECONNECT_SCHEDULE;
    this.#maxReconnectAttempts = opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.#scrub = buildCredentialScrubber(Object.values(config.headers ?? {}));
  }

  get status(): McpClientStatus {
    return this.#status;
  }

  get tools(): readonly McpTool[] {
    return this.#tools;
  }

  async start(): Promise<void> {
    await this.#connectOnce();
  }

  async callTool(name: string, input: unknown): Promise<McpCallToolResult> {
    if (this.#status !== "ready" || !this.#client) {
      throw new McpNotReadyError(this.server, this.#status);
    }
    try {
      const result = await this.#client.callTool({
        name,
        arguments: input as Record<string, unknown> | undefined,
      });
      return {
        isError: Boolean(result.isError),
        content: (result.content ?? []) as McpCallToolResult["content"],
        structuredContent: result.structuredContent,
      };
    } catch (err) {
      const msg = this.#scrub(err instanceof Error ? err.message : String(err));
      throw new Error(`mcp sse '${this.server}' callTool('${name}'): ${msg}`);
    }
  }

  async stop(): Promise<void> {
    this.#status = "closed";
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    if (this.#reconnectCancel) {
      this.#reconnectCancel();
      this.#reconnectCancel = undefined;
    }
    try {
      await this.#client?.close();
    } catch {
      // best-effort
    }
    this.#client = undefined;
    this.#transport = undefined;
  }

  subscribe(listener: McpClientListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async #connectOnce(): Promise<void> {
    const authProvider = this.config.oauth
      ? createOAuthClientProvider({
          server: this.config.name,
          url: this.config.url,
          oauth: this.config.oauth,
          logger: this.#logger,
          ...(this.#tokenStore ? { tokenStore: this.#tokenStore } : {}),
        })
      : undefined;

    const transportOpts: ConstructorParameters<typeof SSEClientTransport>[1] = {
      requestInit: { headers: { ...this.config.headers } },
    };
    if (authProvider) {
      transportOpts.authProvider = authProvider;
    }
    this.#transport = new SSEClientTransport(new URL(this.config.url), transportOpts);
    this.#client = new Client({ name: "jellyclaw-engine", version: "0.0.1" });
    this.#client.onclose = () => {
      if (this.#status !== "closed") {
        this.#scheduleReconnect("transport closed");
      }
    };
    this.#client.onerror = (err) => {
      this.#logger.warn(
        { server: this.server, err: this.#scrub(err.message) },
        "mcp sse: transport error",
      );
    };

    try {
      // Same exactOptionalPropertyTypes friction as client-http.ts.
      await this.#withTimeout(
        this.#client.connect(this.#transport as unknown as Parameters<Client["connect"]>[0]),
        "connect",
      );
      const result = await this.#withTimeout(this.#client.listTools({}), "listTools");
      this.#tools = result.tools.map((t) => ({
        name: t.name,
        namespacedName: namespace(this.server, t.name),
        description: t.description,
        inputSchema: t.inputSchema as Record<string, unknown>,
        server: this.server,
      }));
      const wasReconnecting = this.#status === "reconnecting";
      this.#status = "ready";
      this.#emit({
        type: wasReconnecting ? "mcp.reconnected" : "mcp.connected",
        server: this.server,
        toolCount: this.#tools.length,
      });
    } catch (err) {
      const reason = this.#scrub(err instanceof Error ? err.message : String(err));
      if (this.#status === "reconnecting") {
        throw new Error(reason);
      }
      this.#status = "dead";
      this.#emit({ type: "mcp.dead", server: this.server, reason });
      throw new Error(`mcp sse '${this.server}': ${reason}`);
    }
  }

  #scheduleReconnect(reason: string): void {
    if (this.#status === "closed" || this.#status === "reconnecting") return;
    this.#status = "reconnecting";
    this.#emit({ type: "mcp.disconnected", server: this.server, reason });

    let attempt = 0;
    const tryNext = (): void => {
      if (this.#status === "closed") return;
      if (attempt >= this.#maxReconnectAttempts) {
        this.#status = "dead";
        this.#emit({ type: "mcp.dead", server: this.server, reason: "reconnect exhausted" });
        return;
      }
      const delay = this.#reconnectSchedule[attempt] ?? this.#reconnectSchedule.at(-1) ?? 8000;
      attempt += 1;

      let cancelled = false;
      this.#reconnectCancel = () => {
        cancelled = true;
      };
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = undefined;
        this.#reconnectCancel = undefined;
        if (cancelled || this.#status === "closed") return;
        this.#connectOnce().catch((err) => {
          this.#logger.warn(
            {
              server: this.server,
              err: this.#scrub(err instanceof Error ? err.message : String(err)),
            },
            "mcp sse: reconnect attempt failed",
          );
          tryNext();
        });
      }, delay);
    };
    tryNext();
  }

  async #withTimeout<T>(p: Promise<T>, op: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`mcp sse '${this.server}': ${op} timed out`)),
        this.#connectTimeoutMs,
      );
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #emit(event: McpClientEvent): void {
    for (const l of [...this.#listeners]) {
      try {
        l(event);
      } catch (err) {
        this.#logger.warn(
          {
            server: this.server,
            err: this.#scrub(err instanceof Error ? err.message : String(err)),
          },
          "mcp sse: listener error (isolated)",
        );
      }
    }
  }
}
