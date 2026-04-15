import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { ProviderRouter, shouldFailover } from "./router.js";
import type { Provider, ProviderChunk, ProviderRequest } from "./types.js";

type FakeName = "anthropic" | "openrouter";

class FakeProvider implements Provider {
  readonly name: FakeName;
  readonly stream: (req: ProviderRequest, signal?: AbortSignal) => AsyncIterable<ProviderChunk>;

  constructor(name: FakeName, behavior: (signal?: AbortSignal) => AsyncIterable<ProviderChunk>) {
    this.name = name;
    // Spy-able wrapper so we can assert call counts.
    this.stream = vi.fn((_req: ProviderRequest, signal?: AbortSignal) => behavior(signal));
  }
}

function makeLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const fake = {
    warn,
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
  return { logger: fake, warn };
}

const REQ: ProviderRequest = {
  model: "claude-opus-4-6",
  maxOutputTokens: 16,
  system: [],
  messages: [{ role: "user", content: "hi" }],
};

function chunk(type: string, extra: Record<string, unknown> = {}): ProviderChunk {
  return { type, ...extra };
}

async function collect(iter: AsyncIterable<ProviderChunk>): Promise<ProviderChunk[]> {
  const out: ProviderChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

function httpError(status: number): Error {
  const err = new Error(`http ${status}`);
  (err as { status: number }).status = status;
  return err;
}

function codeError(code: string): Error {
  const err = new Error(code);
  (err as { code: string }).code = code;
  return err;
}

function abortError(): Error {
  const err = new Error("aborted");
  (err as { name: string }).name = "AbortError";
  return err;
}

// biome-ignore lint/suspicious/useAwait: async generators are the target type; no await needed for canned chunks
async function* gen(chunks: ProviderChunk[]): AsyncIterable<ProviderChunk> {
  for (const c of chunks) yield c;
}

describe("ProviderRouter", () => {
  it("happy path — yields all primary chunks unchanged", async () => {
    const chunks = [chunk("a"), chunk("b"), chunk("c")];
    const primary = new FakeProvider("anthropic", () => gen(chunks));
    const secondary = new FakeProvider("openrouter", () => gen([]));
    const { logger } = makeLogger();

    const router = new ProviderRouter({ primary, secondary, logger });
    const out = await collect(router.stream(REQ));
    expect(out).toEqual(chunks);
    expect(secondary.stream).toHaveBeenCalledTimes(0);
  });

  it("pre-stream 500 on primary → failover to secondary", async () => {
    const secondaryChunks = [chunk("x"), chunk("y")];
    const primary = new FakeProvider("anthropic", () => {
      throw httpError(500);
    });
    const secondary = new FakeProvider("openrouter", () => gen(secondaryChunks));
    const { logger, warn } = makeLogger();

    const router = new ProviderRouter({ primary, secondary, logger });
    const out = await collect(router.stream(REQ));
    expect(out).toEqual(secondaryChunks);
    expect(secondary.stream).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    const [payload, msg] = warn.mock.calls[0] ?? [];
    expect(msg).toBe("provider.failover");
    expect(payload).toMatchObject({
      provider: "router",
      from: "anthropic",
      to: "openrouter",
    });
  });

  it("pre-stream 401 on primary → propagates, secondary never invoked", async () => {
    const primary = new FakeProvider("anthropic", () => {
      throw httpError(401);
    });
    const secondary = new FakeProvider("openrouter", () => gen([chunk("x")]));
    const { logger } = makeLogger();

    const router = new ProviderRouter({ primary, secondary, logger });
    await expect(collect(router.stream(REQ))).rejects.toMatchObject({
      status: 401,
    });
    expect(secondary.stream).toHaveBeenCalledTimes(0);
  });

  it("no secondary + 500 on primary → error propagates", async () => {
    const primary = new FakeProvider("anthropic", () => {
      throw httpError(500);
    });
    const { logger } = makeLogger();

    const router = new ProviderRouter({ primary, logger });
    await expect(collect(router.stream(REQ))).rejects.toMatchObject({
      status: 500,
    });
  });

  it("mid-stream error on primary after 1 chunk → rethrows, no failover", async () => {
    const primary = new FakeProvider(
      "anthropic", // biome-ignore lint/suspicious/useAwait: generator yields canned chunks then throws
      async function* () {
        yield chunk("a");
        throw httpError(500);
      },
    );
    const secondary = new FakeProvider("openrouter", () => gen([chunk("x")]));
    const { logger } = makeLogger();

    const router = new ProviderRouter({ primary, secondary, logger });
    const out: ProviderChunk[] = [];
    await expect(
      (async () => {
        for await (const c of router.stream(REQ)) out.push(c);
      })(),
    ).rejects.toMatchObject({ status: 500 });
    expect(out).toEqual([chunk("a")]);
    expect(secondary.stream).toHaveBeenCalledTimes(0);
  });

  it("mid-stream error on primary after many chunks → rethrows, no failover", async () => {
    const primary = new FakeProvider(
      "anthropic", // biome-ignore lint/suspicious/useAwait: generator yields canned chunks then throws
      async function* () {
        yield chunk("a");
        yield chunk("b");
        yield chunk("c");
        throw httpError(503);
      },
    );
    const secondary = new FakeProvider("openrouter", () => gen([chunk("x")]));
    const { logger } = makeLogger();

    const router = new ProviderRouter({ primary, secondary, logger });
    const out: ProviderChunk[] = [];
    await expect(
      (async () => {
        for await (const c of router.stream(REQ)) out.push(c);
      })(),
    ).rejects.toMatchObject({ status: 503 });
    expect(out).toEqual([chunk("a"), chunk("b"), chunk("c")]);
    expect(secondary.stream).toHaveBeenCalledTimes(0);
  });

  it("pre-stream ECONNRESET → failover", async () => {
    const primary = new FakeProvider("anthropic", () => {
      throw codeError("ECONNRESET");
    });
    const secondary = new FakeProvider("openrouter", () => gen([chunk("x")]));
    const { logger, warn } = makeLogger();

    const router = new ProviderRouter({ primary, secondary, logger });
    const out = await collect(router.stream(REQ));
    expect(out).toEqual([chunk("x")]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("pre-stream ETIMEDOUT → failover", async () => {
    const primary = new FakeProvider("anthropic", () => {
      throw codeError("ETIMEDOUT");
    });
    const secondary = new FakeProvider("openrouter", () => gen([chunk("y")]));
    const { logger } = makeLogger();

    const router = new ProviderRouter({ primary, secondary, logger });
    const out = await collect(router.stream(REQ));
    expect(out).toEqual([chunk("y")]);
  });

  it("AbortError pre-stream → propagates, no failover", async () => {
    const primary = new FakeProvider("anthropic", () => {
      throw abortError();
    });
    const secondary = new FakeProvider("openrouter", () => gen([chunk("x")]));
    const { logger } = makeLogger();

    const router = new ProviderRouter({ primary, secondary, logger });
    await expect(collect(router.stream(REQ))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(secondary.stream).toHaveBeenCalledTimes(0);
  });

  it("already-aborted signal → AbortError, primary never invoked", async () => {
    const primary = new FakeProvider("anthropic", () => gen([chunk("a")]));
    const secondary = new FakeProvider("openrouter", () => gen([chunk("x")]));
    const { logger } = makeLogger();

    const ac = new AbortController();
    ac.abort();

    const router = new ProviderRouter({ primary, secondary, logger });
    await expect(collect(router.stream(REQ, ac.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(primary.stream).toHaveBeenCalledTimes(0);
    expect(secondary.stream).toHaveBeenCalledTimes(0);
  });

  it("secondary also fails pre-stream with 500 → error propagates, no infinite loop", async () => {
    const primary = new FakeProvider("anthropic", () => {
      throw httpError(500);
    });
    const secondary = new FakeProvider("openrouter", () => {
      throw httpError(500);
    });
    const { logger } = makeLogger();

    const router = new ProviderRouter({ primary, secondary, logger });
    await expect(collect(router.stream(REQ))).rejects.toMatchObject({
      status: 500,
    });
    expect(secondary.stream).toHaveBeenCalledTimes(1);
  });

  it("mid-stream primary failure does not invoke secondary even if secondary would succeed", async () => {
    const primary = new FakeProvider(
      "anthropic", // biome-ignore lint/suspicious/useAwait: generator yields canned chunks then throws
      async function* () {
        yield chunk("a");
        throw httpError(500);
      },
    );
    const secondary = new FakeProvider("openrouter", () => gen([chunk("OK")]));
    const { logger } = makeLogger();

    const router = new ProviderRouter({ primary, secondary, logger });
    const out: ProviderChunk[] = [];
    await expect(
      (async () => {
        for await (const c of router.stream(REQ)) out.push(c);
      })(),
    ).rejects.toBeDefined();
    expect(out).toEqual([chunk("a")]);
    expect(secondary.stream).toHaveBeenCalledTimes(0);
  });
});

describe("shouldFailover", () => {
  it("matrix", () => {
    const statusCase = (status: number): Error => httpError(status);

    expect(shouldFailover(statusCase(429))).toBe(true);
    expect(shouldFailover(statusCase(500))).toBe(true);
    expect(shouldFailover(statusCase(502))).toBe(true);
    expect(shouldFailover(statusCase(503))).toBe(true);
    expect(shouldFailover(statusCase(504))).toBe(true);

    expect(shouldFailover(statusCase(400))).toBe(false);
    expect(shouldFailover(statusCase(401))).toBe(false);
    expect(shouldFailover(statusCase(403))).toBe(false);
    expect(shouldFailover(statusCase(404))).toBe(false);

    expect(shouldFailover(abortError())).toBe(false);

    expect(shouldFailover(codeError("ECONNRESET"))).toBe(true);
    expect(shouldFailover(codeError("ETIMEDOUT"))).toBe(true);
    expect(shouldFailover(codeError("EPIPE"))).toBe(true);

    expect(shouldFailover(new Error("generic"))).toBe(false);

    const connErr = new Error("conn");
    (connErr as { name: string }).name = "APIConnectionError";
    expect(shouldFailover(connErr)).toBe(true);

    const abortCode = new Error("aborted");
    (abortCode as { code: string }).code = "ABORT_ERR";
    expect(shouldFailover(abortCode)).toBe(false);

    expect(shouldFailover(null)).toBe(false);
    expect(shouldFailover(undefined)).toBe(false);
    expect(shouldFailover("oops")).toBe(false);
  });
});
