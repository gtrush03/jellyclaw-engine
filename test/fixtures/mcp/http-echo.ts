#!/usr/bin/env bun
/**
 * In-process HTTP MCP server fixture for Phase 07 tests.
 *
 * Exposes a single `echo` tool that returns `{ msg }`. Transport is the
 * SDK's `StreamableHTTPServerTransport` (stateful, one transport per
 * session id) wired to a `Server` instance that mirrors the stdio fixture.
 *
 * Programmatic usage (from tests):
 *
 *   const { url, close, rejectWithStatus } = await startHttpEcho();
 *
 * Standalone smoke (Bun):
 *
 *   HTTP_ECHO_PORT=47420 bun run test/fixtures/mcp/http-echo.ts
 */

import { randomUUID } from "node:crypto";
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface StartHttpEchoOptions {
  /** If true, reject POSTs missing `Authorization: Bearer ...` with 401. */
  requireAuth?: boolean;
  /** Bind to a specific port. Default 0 (ephemeral). */
  port?: number;
}

export interface HttpEchoHandle {
  url: string;
  close(): Promise<void>;
  /** Arm a one-shot rejection: the next incoming request is answered with
   * `status` and a short JSON body. Useful for mid-session 401 simulation. */
  rejectWithStatus(status: number): void;
}

function makeMcpServer(): Server {
  const server = new Server(
    { name: "http-echo-server", version: "0.0.1" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [
        {
          name: "echo",
          description: "Echoes its {msg} argument back verbatim.",
          inputSchema: {
            type: "object",
            properties: { msg: { type: "string" } },
            required: ["msg"],
            additionalProperties: false,
          },
        },
      ],
    }),
  );

  server.setRequestHandler(CallToolRequestSchema, (req) => {
    if (req.params.name !== "echo") {
      return Promise.resolve({
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${req.params.name}` }],
      });
    }
    const msg = (req.params.arguments as { msg?: unknown } | undefined)?.msg;
    if (typeof msg !== "string") {
      return Promise.resolve({
        isError: true,
        content: [{ type: "text", text: "missing or non-string 'msg' argument" }],
      });
    }
    return Promise.resolve({
      content: [{ type: "text", text: JSON.stringify({ msg }) }],
      structuredContent: { msg },
    });
  });

  return server;
}

export async function startHttpEcho(opts: StartHttpEchoOptions = {}): Promise<HttpEchoHandle> {
  const requireAuth = opts.requireAuth === true;

  // One transport + one MCP Server per session id. Stateful mode so the
  // SDK's session-id validation matches real-world usage.
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, Server>();

  let pendingRejection: number | null = null;
  const inflight = new Set<Promise<unknown>>();

  const httpServer: HttpServer = createServer((req, res) => {
    const task = handle(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: String((err as Error).message ?? err) }));
      }
    });
    inflight.add(task);
    task.finally(() => inflight.delete(task));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // One-shot rejection: consumed regardless of path/method.
    if (pendingRejection !== null) {
      const status = pendingRejection;
      pendingRejection = null;
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: `forced status ${status}` }));
      return;
    }

    // Only serve the /mcp path — keeps the surface small.
    const url = req.url ?? "/";
    if (!url.startsWith("/mcp")) {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (requireAuth && req.method === "POST") {
      const auth = req.headers.authorization;
      if (!auth?.toLowerCase().startsWith("bearer ")) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.setHeader("www-authenticate", 'Bearer realm="mcp"');
        res.end(JSON.stringify({ error: "missing bearer token" }));
        return;
      }
    }

    // Parse body for POSTs so the SDK can peek at initialize requests
    // without us needing a second transport per request.
    let parsedBody: unknown;
    if (req.method === "POST") {
      parsedBody = await readJsonBody(req);
    }

    // Route by session id.
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;

    let transport: StreamableHTTPServerTransport | undefined = sessionId
      ? transports.get(sessionId)
      : undefined;

    if (!transport) {
      // New session — construct transport, wire to a fresh Server, and
      // remember it under the session id the SDK generates.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports.set(sid, transport as StreamableHTTPServerTransport);
        },
      });
      const mcp = makeMcpServer();
      // Cast required: SDK's `Transport` interface types `onclose?: () => void`
      // (no `| undefined`), but the concrete transport exposes it as
      // `(() => void) | undefined`. Under `exactOptionalPropertyTypes` the
      // structural check fails. Safe — SDK uses this transport at runtime.
      await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
      // connect() registers onclose — track server for cleanup.
      transport.onclose = () => {
        const sid = transport?.sessionId;
        if (sid) {
          transports.delete(sid);
          servers.delete(sid);
        }
      };
      if (transport.sessionId) {
        servers.set(transport.sessionId, mcp);
      }
    }

    await transport.handleRequest(req, res, parsedBody);
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(opts.port ?? 0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const addr = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/mcp`;

  return {
    url,
    rejectWithStatus(status: number) {
      pendingRejection = status;
    },
    async close() {
      // Close all transports (which closes their MCP servers).
      await Promise.all(
        Array.from(transports.values()).map((t) =>
          t.close().catch(() => {
            /* ignore */
          }),
        ),
      );
      transports.clear();
      servers.clear();

      // Stop accepting new connections.
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });

      // Drain in-flight handlers.
      await Promise.allSettled(Array.from(inflight));
    },
  };
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Standalone mode. Bun sets `import.meta.main` to true for the entrypoint;
// Node 20 does not, so we also check argv[1]. `main` isn't in the standard
// ImportMeta lib types — read it via a cast to avoid a global declaration
// that would clash with the sibling fixture.
const metaMain = (import.meta as unknown as { main?: boolean }).main;
const isEntrypoint =
  metaMain === true ||
  (typeof process !== "undefined" &&
    process.argv[1] !== undefined &&
    import.meta.url === `file://${process.argv[1]}`);

if (isEntrypoint) {
  const port = Number(process.env.HTTP_ECHO_PORT ?? 47420);
  const handle = await startHttpEcho({ port });
  process.stderr.write(`[http-echo] listening on ${handle.url}\n`);
  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
