import {
  type AddressInfo,
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger.js";
import { __resetOpenRouterWarningForTests, OpenRouterProvider } from "./openrouter.js";
import type { ProviderRequest } from "./types.js";

/**
 * Local HTTP stand-in for openrouter.ai. We POST `${baseURL}/chat/completions`;
 * server captures headers + body and either emits canned SSE or a status error.
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

function writeSSE(res: ServerResponse, frames: string[]): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  for (const f of frames) {
    res.write(f);
    if (!f.endsWith("\n\n")) res.write("\n\n");
  }
  res.end();
}

function dataFrame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const textOnlyFrames = (): string[] => [
  dataFrame({
    id: "gen-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  }),
  dataFrame({
    id: "gen-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: null }],
  }),
  ": OPENROUTER PROCESSING\n\n",
  dataFrame({
    id: "gen-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content: " world" }, finish_reason: null }],
  }),
  dataFrame({
    id: "gen-1",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }),
  "data: [DONE]\n\n",
];

const toolCallFrames = (): string[] => [
  dataFrame({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_abc",
              type: "function",
              function: { name: "get_weather", arguments: "" },
            },
          ],
        },
      },
    ],
  }),
  dataFrame({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '{"location":' } }],
        },
      },
    ],
  }),
  dataFrame({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }],
        },
      },
    ],
  }),
  dataFrame({
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  }),
  "data: [DONE]\n\n",
];

const logger = createLogger({ level: "silent" });

const baseReq = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: "qwen/qwen3-coder",
  maxOutputTokens: 256,
  system: [{ type: "text", text: "You are jellyclaw." }],
  messages: [{ role: "user", content: "hello" }],
  ...overrides,
});

function walkAssertNoCacheControl(obj: unknown, path = "$"): void {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) walkAssertNoCacheControl(obj[i], `${path}[${i}]`);
    return;
  }
  if (obj !== null && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (k === "cache_control") {
        throw new Error(`found cache_control at ${path}.${k}`);
      }
      walkAssertNoCacheControl(v, `${path}.${k}`);
    }
  }
}

beforeEach(() => {
  __resetOpenRouterWarningForTests();
});

describe("OpenRouterProvider.stream — body translation", () => {
  let server: Server;
  let url: string;
  let captures: Capture[];

  beforeEach(async () => {
    ({ server, url, captures } = await makeServer((_req, res) => {
      writeSSE(res, textOnlyFrames());
    }));
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("strips every cache_control from the outbound body", async () => {
    const prov = new OpenRouterProvider({ apiKey: "or-test", baseURL: url, logger });

    const req: ProviderRequest = {
      model: "qwen/qwen3-coder",
      maxOutputTokens: 128,
      system: [
        {
          type: "text",
          text: "sys",
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hi",
              // @ts-expect-error — extra field; we want to prove stripping is recursive
              cache_control: { type: "ephemeral" },
            },
          ],
        },
      ],
      tools: [
        {
          name: "a",
          description: "",
          input_schema: { type: "object" },
          // @ts-expect-error — Anthropic tool type doesn't include cache_control at this layer but OR layer must still strip
          cache_control: { type: "ephemeral" },
        },
      ],
    };

    for await (const _ of prov.stream(req)) {
      /* drain */
    }

    expect(captures).toHaveLength(1);
    const body = captures[0]?.body;
    expect(() => walkAssertNoCacheControl(body)).not.toThrow();
  });

  it("translates tool schema Anthropic → OpenAI-compat", async () => {
    const prov = new OpenRouterProvider({ apiKey: "or-test", baseURL: url, logger });
    const schema = {
      type: "object",
      properties: {
        location: { type: "string" },
        units: { type: "string", enum: ["c", "f"] },
      },
      required: ["location"],
    };

    for await (const _ of prov.stream(
      baseReq({
        tools: [{ name: "get_weather", description: "Get weather", input_schema: schema }],
      }),
    )) {
      /* drain */
    }

    const body = captures[0]?.body as { tools: unknown[] };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toEqual({
      type: "function",
      function: {
        name: "get_weather",
        description: "Get weather",
        parameters: schema,
      },
    });
  });

  it("sets stream: true, max_tokens, and model on the body", async () => {
    const prov = new OpenRouterProvider({ apiKey: "or-test", baseURL: url, logger });
    for await (const _ of prov.stream(
      baseReq({ model: "qwen/qwen3-coder", maxOutputTokens: 321 }),
    )) {
      /* drain */
    }
    const body = captures[0]?.body as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(321);
    expect(body.model).toBe("qwen/qwen3-coder");
  });

  it("sends HTTP-Referer, X-Title, Authorization on every request", async () => {
    const prov = new OpenRouterProvider({
      apiKey: "or-test",
      baseURL: url,
      logger,
      referer: "https://example.com/ref",
      title: "jellyclaw-test",
    });
    for await (const _ of prov.stream(baseReq())) {
      /* drain */
    }
    const hdrs = captures[0]?.headers;
    expect(hdrs?.["http-referer"]).toBe("https://example.com/ref");
    expect(hdrs?.["x-title"]).toBe("jellyclaw-test");
    expect(hdrs?.authorization).toBe("Bearer or-test");
    expect(String(hdrs?.accept)).toContain("text/event-stream");
  });
});

describe("OpenRouterProvider — warning emission", () => {
  it("warns exactly once across multiple instances for anthropic/* models", async () => {
    const { server, url } = await makeServer((_req, res) => {
      writeSSE(res, textOnlyFrames());
    });

    const warn = vi.fn();
    const mockLogger = {
      warn,
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as Logger;

    try {
      const p1 = new OpenRouterProvider({ apiKey: "or", baseURL: url, logger: mockLogger });
      const p2 = new OpenRouterProvider({ apiKey: "or", baseURL: url, logger: mockLogger });

      for await (const _ of p1.stream(baseReq({ model: "anthropic/claude-sonnet-4.6" }))) {
        /* drain */
      }
      for await (const _ of p2.stream(baseReq({ model: "anthropic/claude-sonnet-4.6" }))) {
        /* drain */
      }

      const cachingWarns = warn.mock.calls.filter((args: unknown[]) => {
        const msg = typeof args[1] === "string" ? args[1] : "";
        return msg.includes("Prompt caching is currently broken");
      });
      expect(cachingWarns).toHaveLength(1);
      expect(String(cachingWarns[0]?.[1])).toContain("#1245, #17910");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("does NOT warn for non-Anthropic models", async () => {
    const { server, url } = await makeServer((_req, res) => {
      writeSSE(res, textOnlyFrames());
    });

    const warn = vi.fn();
    const mockLogger = {
      warn,
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as Logger;

    try {
      const prov = new OpenRouterProvider({ apiKey: "or", baseURL: url, logger: mockLogger });
      for await (const _ of prov.stream(baseReq({ model: "qwen/qwen3-coder" }))) {
        /* drain */
      }
      const cachingWarns = warn.mock.calls.filter((args: unknown[]) => {
        const msg = typeof args[1] === "string" ? args[1] : "";
        return msg.includes("Prompt caching is currently broken");
      });
      expect(cachingWarns).toHaveLength(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("OpenRouterProvider — retry behavior", () => {
  it("retries on 500 twice then succeeds", async () => {
    let calls = 0;
    const { server, url, captures } = await makeServer((_req, res) => {
      calls++;
      if (calls <= 2) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      writeSSE(res, textOnlyFrames());
    });

    try {
      const prov = new OpenRouterProvider({
        apiKey: "or-test",
        baseURL: url,
        logger,
        retry: { maxAttempts: 5, budgetMs: 10_000, baseMs: 5, capMs: 20 },
      });
      const events: unknown[] = [];
      for await (const e of prov.stream(baseReq())) events.push(e);
      expect(captures.length).toBe(3);
      // message_start + content_block_delta*2 + message_delta + message_stop = 5
      expect(events.length).toBeGreaterThanOrEqual(5);
      expect((events[0] as { type: string }).type).toBe("message_start");
      expect((events.at(-1) as { type: string }).type).toBe("message_stop");
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
      res.end(JSON.stringify({ error: { message: "bad key" } }));
    });

    try {
      const prov = new OpenRouterProvider({
        apiKey: "or-test",
        baseURL: url,
        logger,
        retry: { maxAttempts: 5, budgetMs: 10_000, baseMs: 5, capMs: 20 },
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

  it("does NOT retry on 402 (payment required)", async () => {
    let calls = 0;
    const { server, url } = await makeServer((_req, res) => {
      calls++;
      res.statusCode = 402;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "credit balance low" } }));
    });

    try {
      const prov = new OpenRouterProvider({
        apiKey: "or-test",
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
});

describe("OpenRouterProvider — SSE parsing", () => {
  it("ignores `: OPENROUTER PROCESSING` comments and yields text deltas in order", async () => {
    const { server, url } = await makeServer((_req, res) => {
      writeSSE(res, textOnlyFrames());
    });

    try {
      const prov = new OpenRouterProvider({ apiKey: "or", baseURL: url, logger });
      const texts: string[] = [];
      let sawStop = false;
      for await (const e of prov.stream(baseReq())) {
        if (
          e.type === "content_block_delta" &&
          (e as { delta: { type: string } }).delta.type === "text_delta"
        ) {
          texts.push((e as { delta: { text: string } }).delta.text);
        }
        if (e.type === "message_stop") sawStop = true;
      }
      expect(texts.join("")).toBe("Hello world");
      expect(sawStop).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("translates tool-call streams to content_block_start + input_json_delta", async () => {
    const { server, url } = await makeServer((_req, res) => {
      writeSSE(res, toolCallFrames());
    });

    try {
      const prov = new OpenRouterProvider({ apiKey: "or", baseURL: url, logger });
      const events: Array<{ type: string; [k: string]: unknown }> = [];
      for await (const e of prov.stream(baseReq())) {
        events.push(e as { type: string; [k: string]: unknown });
      }

      const starts = events.filter((e) => e.type === "content_block_start");
      expect(starts).toHaveLength(1);
      expect(
        (starts[0] as { content_block: { type: string; id: string; name: string } }).content_block,
      ).toEqual({ type: "tool_use", id: "call_abc", name: "get_weather", input: {} });

      const jsonDeltas = events
        .filter(
          (e) =>
            e.type === "content_block_delta" &&
            (e as { delta: { type: string } }).delta.type === "input_json_delta",
        )
        .map((e) => (e as { delta: { partial_json: string } }).delta.partial_json);
      expect(jsonDeltas.join("")).toBe('{"location":"SF"}');

      const msgDelta = events.find((e) => e.type === "message_delta");
      expect((msgDelta as { delta: { stop_reason: string } }).delta.stop_reason).toBe("tool_use");
      expect(events.at(-1)?.type).toBe("message_stop");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("stops cleanly on `data: [DONE]`", async () => {
    // Emit frames AFTER [DONE] — the parser must ignore them.
    const { server, url } = await makeServer((_req, res) => {
      writeSSE(res, [
        dataFrame({
          choices: [{ index: 0, delta: { content: "A" }, finish_reason: null }],
        }),
        "data: [DONE]\n\n",
        dataFrame({
          choices: [{ index: 0, delta: { content: "SHOULD_NOT_APPEAR" }, finish_reason: null }],
        }),
      ]);
    });

    try {
      const prov = new OpenRouterProvider({ apiKey: "or", baseURL: url, logger });
      let acc = "";
      for await (const e of prov.stream(baseReq())) {
        if (
          e.type === "content_block_delta" &&
          (e as { delta: { type: string } }).delta.type === "text_delta"
        ) {
          acc += (e as { delta: { text: string } }).delta.text;
        }
      }
      expect(acc).toBe("A");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("OpenRouterProvider — abort", () => {
  it("throws when aborted pre-stream without making any network call", async () => {
    let calls = 0;
    const { server, url } = await makeServer((_req, res) => {
      calls++;
      writeSSE(res, textOnlyFrames());
    });

    try {
      const prov = new OpenRouterProvider({ apiKey: "or", baseURL: url, logger });
      const ctrl = new AbortController();
      ctrl.abort();
      const run = async (): Promise<void> => {
        for await (const _ of prov.stream(baseReq(), ctrl.signal)) {
          /* drain */
        }
      };
      await expect(run()).rejects.toBeDefined();
      expect(calls).toBe(0);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("stops iteration when aborted mid-stream", async () => {
    // Server holds the connection open after one chunk so abort has
    // something to interrupt.
    const { server, url } = await makeServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/event-stream");
      res.write(
        dataFrame({
          choices: [{ index: 0, delta: { content: "A" }, finish_reason: null }],
        }),
      );
      // Intentionally leave the socket open; abort will tear it down.
    });

    try {
      const prov = new OpenRouterProvider({ apiKey: "or", baseURL: url, logger });
      const ctrl = new AbortController();
      const run = async (): Promise<number> => {
        let n = 0;
        for await (const e of prov.stream(baseReq(), ctrl.signal)) {
          n++;
          if (
            e.type === "content_block_delta" &&
            (e as { delta: { type: string } }).delta.type === "text_delta"
          ) {
            ctrl.abort();
          }
        }
        return n;
      };
      await expect(run()).rejects.toBeDefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
