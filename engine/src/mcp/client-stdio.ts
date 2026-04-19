/**
 * Phase 07 Prompt 01 — stdio MCP client.
 *
 * Wraps a `@modelcontextprotocol/sdk` `Client` over `StdioClientTransport`
 * with jellyclaw-specific concerns layered on top:
 *
 *   - Connect + `listTools` under a single timeout ladder.
 *   - Serialized SDK call queue so `listTools` and `callTool` never
 *     interleave JSON-RPC frames.
 *   - Exponential-backoff reconnect on unexpected child exit, cancellable
 *     by `stop()`.
 *   - stderr + error-message scrubbing through `buildCredentialScrubber`
 *     so env values from `StdioMcpServerConfig.env` never reach the
 *     logger in plaintext.
 *
 * The registry (Phase 07 Prompt 03) is the sole intended caller.
 */

import type { ChildProcess } from "node:child_process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import type { Logger } from "../logger.js";
import { buildCredentialScrubber } from "./credential-strip.js";
import {
  type McpCallToolResult,
  type McpClient,
  type McpClientEvent,
  type McpClientFactoryOptions,
  type McpClientListener,
  type McpClientStatus,
  McpNotReadyError,
  type McpTool,
  namespaceTool,
  type StdioMcpServerConfig,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_KILL_GRACE_MS = 3_000;
const DEFAULT_RECONNECT_SCHEDULE = Object.freeze([500, 1_000, 2_000, 4_000, 8_000]);
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;

type Scrub = (text: string) => string;

interface ToolFromSdk {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Race `p` against a `ms` timeout. On timeout, invokes `onTimeout()` and
 * rejects with an Error whose message is produced by `makeTimeoutMessage`.
 * The timer is cleared once `p` settles, so no leaked handles.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  makeTimeoutMessage: () => string,
  onTimeout: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        onTimeout();
      } catch {
        // swallow — cleanup best-effort.
      }
      reject(new Error(makeTimeoutMessage()));
    }, ms);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

class StdioMcpClient implements McpClient {
  readonly server: string;
  #status: McpClientStatus = "connecting";
  #tools: readonly McpTool[] = [];

  readonly #config: StdioMcpServerConfig;
  readonly #logger: Logger;
  readonly #scrub: Scrub;
  readonly #connectTimeoutMs: number;
  readonly #killGraceMs: number;
  readonly #reconnectSchedule: readonly number[];
  readonly #maxReconnectAttempts: number;

  #client: Client | null = null;
  #transport: StdioClientTransport | null = null;
  #listeners = new Set<McpClientListener>();

  /** Serialization of SDK calls. */
  #queue: Promise<unknown> = Promise.resolve();

  /** Cancellation handle for an in-flight reconnect backoff sleep. */
  #reconnectCancel: (() => void) | null = null;
  /** Prevents concurrent reconnect loops. */
  #reconnecting = false;

  constructor(config: StdioMcpServerConfig, opts: McpClientFactoryOptions) {
    this.server = config.name;
    this.#config = config;
    this.#logger = opts.logger;

    const secrets = config.env ? Object.values(config.env) : [];
    this.#scrub = buildCredentialScrubber(secrets);

    this.#connectTimeoutMs =
      opts.connectTimeoutMs ?? config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.#killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.#reconnectSchedule = opts.reconnectSchedule ?? DEFAULT_RECONNECT_SCHEDULE;
    this.#maxReconnectAttempts = opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
  }

  get status(): McpClientStatus {
    return this.#status;
  }

  get tools(): readonly McpTool[] {
    return this.#tools;
  }

  async start(): Promise<void> {
    this.#status = "connecting";
    const tools = await this.#spawnAndConnect();
    this.#tools = tools;
    this.#status = "ready";
    this.#emit({ type: "mcp.connected", server: this.server, toolCount: tools.length });
  }

  callTool(name: string, input: unknown): Promise<McpCallToolResult> {
    if (this.#status !== "ready") {
      return Promise.reject(new McpNotReadyError(this.server, this.#status));
    }
    const client = this.#client;
    if (!client) {
      return Promise.reject(new McpNotReadyError(this.server, this.#status));
    }
    return this.#enqueue(async () => {
      try {
        const res = await client.callTool({
          name,
          arguments: input as Record<string, unknown> | undefined,
        });
        return {
          isError: Boolean(res.isError),
          content: (res.content ?? []) as McpCallToolResult["content"],
          ...(res.structuredContent !== undefined
            ? { structuredContent: res.structuredContent }
            : {}),
        };
      } catch (err) {
        throw new Error(this.#scrub(errMessage(err)));
      }
    });
  }

  async stop(): Promise<void> {
    if (this.#status === "closed") return;
    this.#status = "closed";

    // Cancel any backoff sleep.
    if (this.#reconnectCancel) {
      const cancel = this.#reconnectCancel;
      this.#reconnectCancel = null;
      cancel();
    }

    const client = this.#client;
    const transport = this.#transport;
    this.#client = null;
    this.#transport = null;

    if (client) {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
    await this.#killChild(transport);
  }

  subscribe(listener: McpClientListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  // --- internals -----------------------------------------------------------

  /**
   * Test-only accessor exposing the underlying child pid. Non-enumerable to
   * keep it out of `Object.keys()` / logs; intentionally named with
   * dunder-ish prefix so consumers know it's private.
   */
  get __testPid__(): number | null {
    const t = this.#transport;
    if (!t) return null;
    return t.pid ?? null;
  }

  #emit(event: McpClientEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        this.#logger.warn(
          { server: this.server },
          `mcp listener threw: ${this.#scrub(errMessage(err))}`,
        );
      }
    }
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.#queue;
    let release!: (v: unknown) => void;
    const next = new Promise<unknown>((r) => {
      release = r;
    });
    this.#queue = next;
    return (async () => {
      try {
        await prev;
      } catch {
        // Prior failure shouldn't poison subsequent calls.
      }
      try {
        return await fn();
      } finally {
        release(undefined);
      }
    })();
  }

  /** Spawn child + SDK connect + initial listTools. Caller sets status. */
  async #spawnAndConnect(): Promise<readonly McpTool[]> {
    const transport = new StdioClientTransport({
      command: this.#config.command,
      args: this.#config.args ? [...this.#config.args] : [],
      ...(this.#config.env ? { env: { ...this.#config.env } } : {}),
      ...(this.#config.cwd ? { cwd: this.#config.cwd } : {}),
      stderr: "pipe",
    });

    const client = new Client({ name: "jellyclaw-engine", version: "0.0.1" }, { capabilities: {} });

    // Wire lifecycle BEFORE connect so we don't miss early events.
    client.onerror = (err): void => {
      this.#logger.warn(
        { server: this.server },
        `mcp client error: ${this.#scrub(errMessage(err))}`,
      );
    };
    client.onclose = (): void => {
      // Ignore if we're the ones closing.
      if (this.#status === "closed") return;
      // Only trigger reconnect from a "live" state.
      if (this.#status === "reconnecting") return;
      void this.#handleUnexpectedClose("transport closed");
    };

    // Stderr piping: scrub + log as warn.
    const stderr = transport.stderr;
    if (stderr) {
      stderr.on("data", (chunk: Buffer | string): void => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        const scrubbed = this.#scrub(text).trimEnd();
        if (scrubbed.length === 0) return;
        this.#logger.warn({ server: this.server }, `mcp stderr: ${scrubbed}`);
      });
      stderr.on("error", (err: Error): void => {
        this.#logger.warn(
          { server: this.server },
          `mcp stderr error: ${this.#scrub(errMessage(err))}`,
        );
      });
    }

    this.#transport = transport;
    this.#client = client;

    const connectP = client.connect(transport);
    try {
      await withTimeout(
        connectP,
        this.#connectTimeoutMs,
        () => this.#scrub(`mcp connect timeout after ${this.#connectTimeoutMs}ms`),
        () => {
          // best-effort teardown; errors ignored.
          client.close().catch(() => undefined);
          void this.#killChild(transport);
        },
      );
    } catch (err) {
      // Ensure child is dead on any connect failure.
      await this.#killChild(transport).catch(() => undefined);
      this.#client = null;
      this.#transport = null;
      throw new Error(this.#scrub(errMessage(err)));
    }

    let sdkTools: readonly ToolFromSdk[];
    try {
      const res = await withTimeout(
        client.listTools({}),
        this.#connectTimeoutMs,
        () => this.#scrub(`mcp listTools timeout after ${this.#connectTimeoutMs}ms`),
        () => {
          client.close().catch(() => undefined);
          void this.#killChild(transport);
        },
      );
      sdkTools = res.tools as readonly ToolFromSdk[];
    } catch (err) {
      await this.#killChild(transport).catch(() => undefined);
      this.#client = null;
      this.#transport = null;
      throw new Error(this.#scrub(errMessage(err)));
    }

    const tools: McpTool[] = sdkTools.map((t) => {
      const tool: McpTool = {
        name: t.name,
        namespacedName: namespaceTool(this.server, t.name),
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.inputSchema as Record<string, unknown>,
        server: this.server,
      };
      return tool;
    });

    return tools;
  }

  async #handleUnexpectedClose(reason: string): Promise<void> {
    if (this.#status === "closed" || this.#status === "dead") return;
    if (this.#reconnecting) return;
    this.#reconnecting = true;
    const scrubbedReason = this.#scrub(reason);

    this.#status = "reconnecting";
    this.#emit({ type: "mcp.disconnected", server: this.server, reason: scrubbedReason });

    // Drop refs to the dead client/transport.
    this.#client = null;
    this.#transport = null;

    let lastReason = scrubbedReason;
    for (let attempt = 0; attempt < this.#maxReconnectAttempts; attempt++) {
      const delayIdx = Math.min(attempt, this.#reconnectSchedule.length - 1);
      const delay = this.#reconnectSchedule[delayIdx] ?? 1_000;

      const cancelled = await this.#cancellableSleep(delay);
      if (cancelled || (this.#status as McpClientStatus) === "closed") {
        this.#reconnecting = false;
        return;
      }

      try {
        const tools = await this.#spawnAndConnect();
        // Check we weren't stopped while connecting.
        if ((this.#status as McpClientStatus) === "closed") {
          await this.#killChild(this.#transport).catch(() => undefined);
          this.#reconnecting = false;
          return;
        }
        this.#tools = tools;
        this.#status = "ready";
        this.#emit({ type: "mcp.reconnected", server: this.server, toolCount: tools.length });
        this.#reconnecting = false;
        return;
      } catch (err) {
        lastReason = this.#scrub(errMessage(err));
        this.#logger.warn(
          { server: this.server },
          `mcp reconnect attempt ${attempt + 1} failed: ${lastReason}`,
        );
      }
    }

    // Exhausted.
    if ((this.#status as McpClientStatus) === "closed") {
      this.#reconnecting = false;
      return;
    }
    this.#status = "dead";
    this.#emit({ type: "mcp.dead", server: this.server, reason: lastReason });
    this.#reconnecting = false;
  }

  /**
   * Sleep `ms` ms, resolving `true` if cancelled via `stop()`, `false`
   * otherwise. Stores cancellation handle on `this.#reconnectCancel`.
   */
  #cancellableSleep(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.#reconnectCancel = null;
        resolve(false);
      }, ms);
      this.#reconnectCancel = (): void => {
        clearTimeout(timer);
        this.#reconnectCancel = null;
        resolve(true);
      };
    });
  }

  /**
   * SIGTERM → wait killGraceMs → SIGKILL. Resolves once child is exited
   * (or was never spawned). Safe to call multiple times.
   */
  async #killChild(transport: StdioClientTransport | null): Promise<void> {
    if (!transport) return;
    // Reach into the child. The SDK does not expose it directly; we use
    // `transport.pid` + the transport's own close() which already sends
    // SIGTERM. We additionally escalate to SIGKILL after the grace period
    // by reaching for the private `_process` if present. This is the only
    // place we touch SDK internals.
    const pid = transport.pid;
    try {
      await transport.close();
    } catch {
      // ignore
    }
    if (pid === null || pid === undefined) return;

    // Escalate if still alive. Reaching into SDK internals via `_process`
    // is the only available path to SIGKILL — the SDK does not expose it.
    const proc = (transport as unknown as { _process?: ChildProcess })._process;
    if (!proc || proc.exitCode !== null || proc.killed) return;

    await new Promise<void>((resolve) => {
      const onExit = (): void => {
        clearTimeout(t);
        resolve();
      };
      proc.once("exit", onExit);
      const t = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, this.#killGraceMs);
      // If already dead between checks:
      if (proc.exitCode !== null || proc.killed) {
        clearTimeout(t);
        proc.removeListener("exit", onExit);
        resolve();
      }
    });
  }
}

/**
 * Factory returning an `McpClient` backed by a stdio-spawned MCP server.
 * See module docstring for behavior.
 */
export function createStdioMcpClient(
  config: StdioMcpServerConfig,
  opts: McpClientFactoryOptions,
): McpClient {
  return new StdioMcpClient(config, opts);
}
