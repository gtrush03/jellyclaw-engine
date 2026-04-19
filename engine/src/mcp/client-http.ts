/**
 * Phase 07 Prompt 02 — StreamableHTTP MCP client.
 *
 * Thin wrapper around `@modelcontextprotocol/sdk`'s
 * `StreamableHTTPClientTransport`. The SDK owns reconnect + OAuth
 * retry semantics on this transport; we layer the jellyclaw
 * lifecycle contract (`McpClient`) + shared listener bus on top.
 *
 * Full implementation lands in this prompt's sequential phase once
 * the token-store + oauth pieces are in. This file currently provides
 * the export surface required by `registry.ts` + a working stub that
 * surfaces a descriptive error if called.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import type { Logger } from "../logger.js";
import { buildCredentialScrubber } from "./credential-strip.js";
import { namespace } from "./namespacing.js";
import { createOAuthClientProvider } from "./oauth.js";
import type { TokenStore } from "./token-store.js";
import {
  type HttpMcpServerConfig,
  type McpCallToolResult,
  type McpClient,
  type McpClientEvent,
  type McpClientFactoryOptions,
  type McpClientListener,
  type McpClientStatus,
  McpNotReadyError,
  type McpTool,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export interface HttpMcpClientFactoryOptions extends McpClientFactoryOptions {
  /** Shared token store (one per engine). Injected by the registry. */
  readonly tokenStore?: TokenStore;
}

export function createHttpMcpClient(
  config: HttpMcpServerConfig,
  opts: HttpMcpClientFactoryOptions,
): McpClient {
  return new HttpMcpClient(config, opts);
}

class HttpMcpClient implements McpClient {
  readonly server: string;
  #status: McpClientStatus = "connecting";
  #tools: McpTool[] = [];
  #client: Client | undefined = undefined;
  #transport: StreamableHTTPClientTransport | undefined = undefined;
  readonly #listeners = new Set<McpClientListener>();
  readonly #logger: Logger;
  readonly #scrub: (s: string) => string;
  readonly #connectTimeoutMs: number;
  readonly #tokenStore: TokenStore | undefined;

  constructor(
    readonly config: HttpMcpServerConfig,
    opts: HttpMcpClientFactoryOptions,
  ) {
    this.server = config.name;
    this.#logger = opts.logger;
    this.#tokenStore = opts.tokenStore;
    this.#connectTimeoutMs =
      opts.connectTimeoutMs ?? config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    // Header values are user-supplied and MAY contain secrets (e.g.
    // static bearer tokens used instead of OAuth). Scrub those from
    // any thrown error messages.
    this.#scrub = buildCredentialScrubber(Object.values(config.headers ?? {}));
  }

  get status(): McpClientStatus {
    return this.#status;
  }

  get tools(): readonly McpTool[] {
    return this.#tools;
  }

  async start(): Promise<void> {
    const authProvider = this.config.oauth
      ? createOAuthClientProvider({
          server: this.config.name,
          url: this.config.url,
          oauth: this.config.oauth,
          logger: this.#logger,
          ...(this.#tokenStore ? { tokenStore: this.#tokenStore } : {}),
        })
      : undefined;

    const transportOpts: ConstructorParameters<typeof StreamableHTTPClientTransport>[1] = {
      requestInit: { headers: { ...this.config.headers } },
    };
    if (authProvider) {
      transportOpts.authProvider = authProvider;
    }
    this.#transport = new StreamableHTTPClientTransport(new URL(this.config.url), transportOpts);
    this.#client = new Client({ name: "jellyclaw-engine", version: "0.0.1" });
    this.#client.onclose = () => {
      if (this.#status !== "closed") {
        this.#status = "dead";
        this.#emit({
          type: "mcp.disconnected",
          server: this.server,
          reason: "transport closed",
        });
        this.#emit({ type: "mcp.dead", server: this.server, reason: "transport closed" });
      }
    };
    this.#client.onerror = (err) => {
      this.#logger.warn(
        { server: this.server, err: this.#scrub(err.message) },
        "mcp http: transport error",
      );
    };

    try {
      // SDK's StreamableHTTPClientTransport declares `sessionId: string | undefined`
      // while the base Transport interface declares `sessionId?: string`. Under
      // exactOptionalPropertyTypes these are nominally incompatible despite being
      // structurally identical. Single-point assertion confines the friction.
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
      this.#status = "ready";
      this.#emit({
        type: "mcp.connected",
        server: this.server,
        toolCount: this.#tools.length,
      });
    } catch (err) {
      this.#status = "dead";
      const reason = this.#scrub(err instanceof Error ? err.message : String(err));
      this.#emit({ type: "mcp.dead", server: this.server, reason });
      throw new Error(`mcp http '${this.server}': ${reason}`);
    }
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
      throw new Error(`mcp http '${this.server}' callTool('${name}'): ${msg}`);
    }
  }

  async stop(): Promise<void> {
    this.#status = "closed";
    try {
      await this.#client?.close();
    } catch {
      // best-effort teardown
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

  async #withTimeout<T>(p: Promise<T>, op: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`mcp http '${this.server}': ${op} timed out`)),
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
          "mcp http: listener error (isolated)",
        );
      }
    }
  }
}
