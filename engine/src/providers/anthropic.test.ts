import {
  type AddressInfo,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger } from "../logger.js";
import { AnthropicProvider, BETA_CONTEXT_1M, BETA_EXTENDED_CACHE_TTL } from "./anthropic.js";
import type { ProviderRequest } from "./types.js";

/**
 * Local HTTP stand-in for api.anthropic.com. The @anthropic-ai/sdk posts to
 * `${baseURL}/v1/messages`; we capture the body + headers, then either
 * emit a canned SSE stream or an error status.
 */

interface Capture {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void | Promise<void>;

function makeServer(
  handler: Handler,
): Promise<{ server: Server; url: string; captures: Capture[] }> {
  const captures: Capture[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += String(c);
      });
      req.on("end", () => {
        captures.push({
          method: req.method ?? "",
          url: req.url ?? "",
          headers: req.headers,
          body: body ? JSON.parse(body) : undefined,
        });
        void handler(req, res, body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, captures });
    });
  });
}

function writeSSE(res: ServerResponse, events: Array<{ event: string; data: unknown }>): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  for (const e of events) {
    res.write(`event: ${e.event}\n`);
    res.write(`data: ${JSON.stringify(e.data)}\n\n`);
  }
  res.end();
}

const cannedHappyStream = [
  {
    event: "message_start",
    data: {
      type: "message_start",
      message: {
        id: "msg_test",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-opus-4-6",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 1,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
        },
      },
    },
  },
  {
    event: "content_block_start",
    data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  },
  {
    event: "content_block_delta",
    data: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hello" },
    },
  },
  {
    event: "content_block_stop",
    data: { type: "content_block_stop", index: 0 },
  },
  {
    event: "message_delta",
    data: {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 2 },
    },
  },
  {
    event: "message_stop",
    data: { type: "message_stop" },
  },
];

const logger = createLogger({ level: "silent" });

const baseReq = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: "claude-opus-4-6",
  maxOutputTokens: 256,
  system: [{ type: "text", text: "You are jellyclaw." }],
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
});

describe("AnthropicProvider.stream — request construction", () => {
  let server: Server;
  let url: string;
  let captures: Capture[];

  beforeEach(async () => {
    ({ server, url, captures } = await makeServer((_req, res) => {
      writeSSE(res, cannedHappyStream);
    }));
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("posts cache_control on last system block and last tool", async () => {
    const prov = new AnthropicProvider({ apiKey: "sk-test", baseURL: url, logger });
    const events: unknown[] = [];
    for await (const e of prov.stream(
      baseReq({
        tools: [
          { name: "a", description: "", input_schema: { type: "object" } },
          { name: "b", description: "", input_schema: { type: "object" } },
        ],
      }),
    )) {
      events.push(e);
    }

    expect(captures).toHaveLength(1);
    const body = captures[0]?.body as Record<string, unknown>;
    const system = body?.system as Array<{ cache_control?: unknown }>;
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

    const tools = body?.tools as Array<{ cache_control?: unknown; name: string }>;
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual({ type: "ephemeral", ttl: "5m" });

    // All 6 canned events yielded.
    expect(events.length).toBe(6);
    expect((events[0] as { type: string }).type).toBe("message_start");
    expect((events.at(-1) as { type: string }).type).toBe("message_stop");
  });

  it("sets the extended-cache-ttl beta header when any 1h breakpoint exists", async () => {
    const prov = new AnthropicProvider({ apiKey: "sk-test", baseURL: url, logger });
    for await (const _ of prov.stream(baseReq())) {
      /* drain */
    }
    const beta = captures[0]?.headers["anthropic-beta"];
    expect(beta).toBeDefined();
    expect(String(beta)).toContain(BETA_EXTENDED_CACHE_TTL);
  });

  it("sets the 1M context beta header for the 4-6 family", async () => {
    const prov = new AnthropicProvider({ apiKey: "sk-test", baseURL: url, logger });
    for await (const _ of prov.stream(baseReq({ model: "claude-opus-4-6" }))) {
      /* drain */
    }
    const beta = captures[0]?.headers["anthropic-beta"];
    expect(beta).toBeDefined();
    expect(String(beta)).toContain(BETA_CONTEXT_1M);
  });

  it("sets the 1M context beta header for the 4-7 family", async () => {
    const prov = new AnthropicProvider({ apiKey: "sk-test", baseURL: url, logger });
    for await (const _ of prov.stream(baseReq({ model: "claude-opus-4-7" }))) {
      /* drain */
    }
    const beta = captures[0]?.headers["anthropic-beta"];
    expect(beta).toBeDefined();
    expect(String(beta)).toContain(BETA_CONTEXT_1M);
  });

  it("omits the beta header when systemTTL=5m", async () => {
    const prov = new AnthropicProvider({
      apiKey: "sk-test",
      baseURL: url,
      logger,
      cache: { enabled: true, skillsTopN: 12, systemTTL: "5m" },
    });
    for await (const _ of prov.stream(baseReq())) {
      /* drain */
    }
    const beta = captures[0]?.headers["anthropic-beta"];
    // header may be undefined OR (if the SDK adds its own defaults) must not
    // contain our extended-cache marker.
    if (beta) {
      expect(String(beta)).not.toContain(BETA_EXTENDED_CACHE_TTL);
    } else {
      expect(beta).toBeUndefined();
    }
  });
});

describe("AnthropicProvider.stream — retry behavior", () => {
  it("retries on 500 then succeeds on 200", async () => {
    let calls = 0;
    const { server, url, captures } = await makeServer((_req, res, _body) => {
      calls++;
      if (calls <= 2) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: "boom" } }));
        return;
      }
      writeSSE(res, cannedHappyStream);
    });

    try {
      const prov = new AnthropicProvider({
        apiKey: "sk-test",
        baseURL: url,
        logger,
        retry: { maxAttempts: 5, budgetMs: 10_000, baseMs: 10, capMs: 50 },
      });
      const events: unknown[] = [];
      for await (const e of prov.stream(baseReq())) events.push(e);
      expect(events.length).toBe(6);
      expect(captures.length).toBe(3);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("does NOT retry on 401", async () => {
    let calls = 0;
    const { server, url } = await makeServer((_req, res) => {
      calls++;
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "bad key" },
        }),
      );
    });

    try {
      const prov = new AnthropicProvider({
        apiKey: "sk-test",
        baseURL: url,
        logger,
        retry: { maxAttempts: 5, budgetMs: 10_000, baseMs: 10, capMs: 50 },
      });
      const run = async (): Promise<void> => {
        for await (const _ of prov.stream(baseReq())) {
          /* drain */
        }
      };
      await expect(run()).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("does NOT retry on 400", async () => {
    let calls = 0;
    const { server, url } = await makeServer((_req, res) => {
      calls++;
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "invalid_request_error", message: "bad" },
        }),
      );
    });

    try {
      const prov = new AnthropicProvider({
        apiKey: "sk-test",
        baseURL: url,
        logger,
        retry: { maxAttempts: 3, budgetMs: 5_000, baseMs: 5, capMs: 20 },
      });
      const run = async (): Promise<void> => {
        for await (const _ of prov.stream(baseReq())) {
          /* drain */
        }
      };
      await expect(run()).rejects.toThrow();
      expect(calls).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("respects Retry-After header when present", async () => {
    let calls = 0;
    const timings: number[] = [];
    const start = Date.now();
    const { server, url } = await makeServer((_req, res) => {
      calls++;
      timings.push(Date.now() - start);
      if (calls === 1) {
        res.statusCode = 429;
        res.setHeader("Retry-After", "0");
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "slow down" },
          }),
        );
        return;
      }
      writeSSE(res, cannedHappyStream);
    });

    try {
      const prov = new AnthropicProvider({
        apiKey: "sk-test",
        baseURL: url,
        logger,
        retry: { maxAttempts: 3, budgetMs: 10_000, baseMs: 5, capMs: 20 },
      });
      for await (const _ of prov.stream(baseReq())) {
        /* drain */
      }
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("AnthropicProvider.stream — abort", () => {
  it("aborts cleanly when signal fires before first attempt", async () => {
    const { server, url } = await makeServer((_req, res) => {
      writeSSE(res, cannedHappyStream);
    });

    try {
      const prov = new AnthropicProvider({ apiKey: "sk-test", baseURL: url, logger });
      const ctrl = new AbortController();
      ctrl.abort();
      const run = async (): Promise<void> => {
        for await (const _ of prov.stream(baseReq(), ctrl.signal)) {
          /* drain */
        }
      };
      await expect(run()).rejects.toBeDefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
