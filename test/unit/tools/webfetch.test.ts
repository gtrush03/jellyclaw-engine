/**
 * Unit tests for the WebFetch tool.
 *
 * Happy-path tests bind a real `node:http` server to `127.0.0.1:0` (random
 * port). Because 127.0.0.1 is loopback and therefore blocked by the SSRF
 * preflight by default, happy-path tests use `allowAll` permissions — which
 * grants `webfetch.localhost` and exercises the loopback override code path.
 *
 * SSRF-rejection tests use literal IPs (or `localhost`) + `denyAll` so no
 * network I/O occurs past the preflight.
 */

import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../../../engine/src/logger.js";
import { getTool } from "../../../engine/src/tools/index.js";
import { allowAll, denyAll } from "../../../engine/src/tools/permissions.js";
import {
  SsrfBlockedError,
  type ToolContext,
  ToolError,
  WebFetchProtocolError,
  WebFetchSizeError,
} from "../../../engine/src/tools/types.js";
import { webfetchTool } from "../../../engine/src/tools/webfetch.js";
import webfetchSchema from "../../fixtures/tools/claude-code-schemas/webfetch.json" with {
  type: "json",
};

function makeCtx(opts: { allow?: boolean } = {}): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: "test-session-webfetch",
    readCache: new Set<string>(),
    abort: new AbortController().signal,
    logger: createLogger({ level: "silent" }),
    permissions: opts.allow ? allowAll : denyAll,
  };
}

interface StartedServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  readonly received: { headers: IncomingHttpHeaders | null };
  close(): Promise<void>;
}

async function startServer(
  handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void | Promise<void>,
): Promise<StartedServer> {
  const received: { headers: IncomingHttpHeaders | null } = { headers: null };
  const server = createServer((req, res) => {
    received.headers = req.headers;
    void handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}`,
    received,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections?.();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("webfetchTool", () => {
  let servers: StartedServer[] = [];

  beforeEach(() => {
    servers = [];
  });

  afterEach(async () => {
    for (const s of servers) {
      try {
        await s.close();
      } catch {
        // ignore
      }
    }
    servers = [];
  });

  it("converts HTML to Markdown on the happy path", async () => {
    const s = await startServer((_req, res) => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end("<h1>Hello</h1><p>World</p>");
    });
    servers.push(s);

    const out = await webfetchTool.handler(
      { url: s.url, prompt: "summarize" },
      makeCtx({ allow: true }),
    );

    expect(out.content).toContain("# Hello");
    expect(out.content).toContain("World");
    expect(out.content_type).toBe("text/html");
    expect(out.final_url.startsWith(s.url)).toBe(true);
    expect(out.bytes).toBeGreaterThan(0);
  });

  it("passes text/plain through as-is", async () => {
    const s = await startServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("plain body");
    });
    servers.push(s);

    const out = await webfetchTool.handler({ url: s.url, prompt: "x" }, makeCtx({ allow: true }));
    expect(out.content).toBe("plain body");
    expect(out.content_type).toBe("text/plain");
  });

  it("passes application/json through as-is", async () => {
    const s = await startServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"a":1}');
    });
    servers.push(s);

    const out = await webfetchTool.handler({ url: s.url, prompt: "x" }, makeCtx({ allow: true }));
    expect(out.content).toBe('{"a":1}');
    expect(out.content_type).toBe("application/json");
  });

  it("rejects unsupported content-type", async () => {
    const s = await startServer((_req, res) => {
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.from([0, 1, 2, 3]));
    });
    servers.push(s);

    await expect(
      webfetchTool.handler({ url: s.url, prompt: "x" }, makeCtx({ allow: true })),
    ).rejects.toMatchObject({ code: "UnsupportedContentType" });
  });

  it("blocks 127.0.0.1 literal under denyAll", async () => {
    await expect(
      webfetchTool.handler({ url: "http://127.0.0.1:9999/", prompt: "x" }, makeCtx()),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks localhost hostname under denyAll", async () => {
    await expect(
      webfetchTool.handler({ url: "http://localhost/", prompt: "x" }, makeCtx()),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks RFC1918 literal (10.0.0.1) even with allowAll", async () => {
    await expect(
      webfetchTool.handler({ url: "http://10.0.0.1/", prompt: "x" }, makeCtx({ allow: true })),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks AWS metadata link-local (169.254.169.254)", async () => {
    await expect(
      webfetchTool.handler(
        { url: "http://169.254.169.254/", prompt: "x" },
        makeCtx({ allow: true }),
      ),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks IPv6 loopback [::1] under denyAll", async () => {
    await expect(
      webfetchTool.handler({ url: "http://[::1]/", prompt: "x" }, makeCtx()),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("blocks IPv6 ULA [fc00::1] even with allowAll", async () => {
    await expect(
      webfetchTool.handler({ url: "http://[fc00::1]/", prompt: "x" }, makeCtx({ allow: true })),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("rejects file: protocol", async () => {
    await expect(
      webfetchTool.handler({ url: "file:///etc/passwd", prompt: "x" }, makeCtx()),
    ).rejects.toBeInstanceOf(WebFetchProtocolError);
  });

  it("rejects javascript: protocol", async () => {
    // zod URL parser may reject `javascript:alert(1)` as non-URL; either error
    // is acceptable here (both are refusals).
    await expect(
      webfetchTool.handler({ url: "javascript:alert(1)", prompt: "x" }, makeCtx()),
    ).rejects.toBeDefined();
  });

  it("re-applies SSRF check on redirects — refuses redirect to 10.0.0.1", async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(302, { location: "http://10.0.0.1/next" });
      res.end();
    });
    servers.push(s);

    await expect(
      webfetchTool.handler({ url: s.url, prompt: "x" }, makeCtx({ allow: true })),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it("does NOT forward authorization/cookie/proxy-authorization headers", async () => {
    const s = await startServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("ok");
    });
    servers.push(s);

    await webfetchTool.handler({ url: s.url, prompt: "x" }, makeCtx({ allow: true }));

    const h = s.received.headers;
    expect(h).not.toBeNull();
    if (h === null) throw new Error("no headers captured");
    expect(h.authorization).toBeUndefined();
    expect(h.cookie).toBeUndefined();
    expect(h["proxy-authorization"]).toBeUndefined();
    // Sanity: our whitelisted headers DID go out.
    expect(h["user-agent"]).toContain("jellyclaw");
    expect(h.accept).toBeDefined();
  });

  it("aborts + throws WebFetchSizeError when body exceeds 10MB", async () => {
    const s = await startServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      // Stream 11MB worth of 'a's in 1MB chunks. Writing on error throws; swallow.
      const chunk = Buffer.alloc(1024 * 1024, 97);
      let written = 0;
      const pump = (): void => {
        while (written < 11) {
          written += 1;
          if (!res.write(chunk)) {
            res.once("drain", pump);
            return;
          }
        }
        res.end();
      };
      pump();
      res.on("error", () => {
        // swallow — client aborted
      });
    });
    servers.push(s);

    await expect(
      webfetchTool.handler({ url: s.url, prompt: "x" }, makeCtx({ allow: true })),
    ).rejects.toBeInstanceOf(WebFetchSizeError);
  });

  it("loopback override permits 127.0.0.1 only when webfetch.localhost allowed", async () => {
    const s = await startServer((_req, res) => {
      res.setHeader("content-type", "text/plain");
      res.end("ok");
    });
    servers.push(s);

    // denyAll → blocked
    await expect(
      webfetchTool.handler({ url: s.url, prompt: "x" }, makeCtx()),
    ).rejects.toBeInstanceOf(SsrfBlockedError);

    // allowAll → permitted (grants webfetch.localhost)
    const out = await webfetchTool.handler({ url: s.url, prompt: "x" }, makeCtx({ allow: true }));
    expect(out.content).toBe("ok");
  });

  it("inputSchema deep-equals the Claude Code fixture", () => {
    expect(webfetchTool.inputSchema).toEqual(webfetchSchema);
  });

  it("is registered as 'WebFetch' in the tool registry", () => {
    expect(getTool("WebFetch")).toBe(webfetchTool);
  });

  it("surfaces 4xx HTTP responses as WebFetchHttpError", async () => {
    const s = await startServer((_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    });
    servers.push(s);

    await expect(
      webfetchTool.handler({ url: s.url, prompt: "x" }, makeCtx({ allow: true })),
    ).rejects.toBeInstanceOf(ToolError);
  });
});
