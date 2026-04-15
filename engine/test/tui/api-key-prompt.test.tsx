/**
 * Phase 99-06 — ApiKeyPrompt component test suite.
 *
 * Uses `ink-testing-library` to drive the component, mocks `fetch` and the
 * persistence callback, and shunts the credentials path to a tmp file via
 * `JELLYCLAW_CREDENTIALS_PATH`.
 */

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiKeyPrompt } from "../../src/tui/components/api-key-prompt.js";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const VALID_KEY = "sk-ant-this-is-long-enough-to-pass-validation";

function makeOkResponse(): Response {
  return new Response(JSON.stringify({ id: "msg_test", content: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeErrorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function flush(): Promise<void> {
  // Allow microtasks + ink's useEffect listener wiring to settle. Ink's
  // `useInput` subscribes inside a `useEffect` — if we fire `stdin.write`
  // before that effect runs, the data is dropped on the floor. We therefore
  // run several macrotask ticks both AFTER `render()` (initial subscribe)
  // and AFTER each `stdin.write` (state -> re-render -> resubscribe).
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function mount(element: React.ReactElement): Promise<ReturnType<typeof render>> {
  const instance = render(element);
  await flush();
  return instance;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let tmpCredsPath: string;

beforeEach(() => {
  tmpCredsPath = join(
    tmpdir(),
    `jellyclaw-test-${String(process.hrtime.bigint())}-${String(Math.random()).slice(2, 8)}.json`,
  );
  process.env.JELLYCLAW_CREDENTIALS_PATH = tmpCredsPath;
});

afterEach(async () => {
  delete process.env.JELLYCLAW_CREDENTIALS_PATH;
  await rm(tmpCredsPath, { force: true }).catch(() => {});
  await rm(`${tmpCredsPath}.tmp`, { force: true }).catch(() => {});
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ApiKeyPrompt", () => {
  it("renders the prompting state with masked input + paste instructions", async () => {
    const onAccepted = vi.fn();
    const fetchImpl = vi.fn();
    const saveImpl = vi.fn();
    const { lastFrame, unmount } = await mount(
      <ApiKeyPrompt
        onAccepted={onAccepted}
        fetchImpl={fetchImpl as unknown as typeof fetch}
        saveImpl={saveImpl}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("jellyclaw — first-run setup");
    expect(frame).toContain("Paste your Anthropic API key");
    expect(frame).toContain("https://console.anthropic.com/settings/keys");
    expect(frame).toContain("Enter to submit");
    expect(frame).toContain("Esc to quit");
    unmount();
  });

  it("masks typed characters as bullets, never plaintext", async () => {
    const onAccepted = vi.fn();
    const fetchImpl = vi.fn();
    const saveImpl = vi.fn();
    const { lastFrame, stdin, unmount } = await mount(
      <ApiKeyPrompt
        onAccepted={onAccepted}
        fetchImpl={fetchImpl as unknown as typeof fetch}
        saveImpl={saveImpl}
      />,
    );
    stdin.write("sk-ant-xxx");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("sk-ant-xxx");
    expect(frame).toContain("•");
    unmount();
  });

  it("submitting empty input transitions to rejected with 'empty'", async () => {
    const onAccepted = vi.fn();
    const fetchImpl = vi.fn();
    const saveImpl = vi.fn();
    const { lastFrame, stdin, unmount } = await mount(
      <ApiKeyPrompt
        onAccepted={onAccepted}
        fetchImpl={fetchImpl as unknown as typeof fetch}
        saveImpl={saveImpl}
      />,
    );
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗");
    expect(frame).toContain("empty");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(saveImpl).not.toHaveBeenCalled();
    unmount();
  });

  it("submitting a too-short key is rejected without firing fetch", async () => {
    const onAccepted = vi.fn();
    const fetchImpl = vi.fn();
    const saveImpl = vi.fn();
    const { lastFrame, stdin, unmount } = await mount(
      <ApiKeyPrompt
        onAccepted={onAccepted}
        fetchImpl={fetchImpl as unknown as typeof fetch}
        saveImpl={saveImpl}
      />,
    );
    stdin.write("short");
    await flush();
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗");
    expect(frame).toContain("too short");
    expect(fetchImpl).not.toHaveBeenCalled();
    unmount();
  });

  it("rejects keys wrapped in quotes", async () => {
    const onAccepted = vi.fn();
    const fetchImpl = vi.fn();
    const saveImpl = vi.fn();
    const { lastFrame, stdin, unmount } = await mount(
      <ApiKeyPrompt
        onAccepted={onAccepted}
        fetchImpl={fetchImpl as unknown as typeof fetch}
        saveImpl={saveImpl}
      />,
    );
    stdin.write(`"${VALID_KEY}"`);
    await flush();
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗");
    expect(frame).toContain("paste without quotes");
    expect(fetchImpl).not.toHaveBeenCalled();
    unmount();
  });

  it("on 200 OK transitions to saved, calls saveImpl + onAccepted exactly once", async () => {
    const onAccepted = vi.fn();
    const fetchImpl = vi.fn(async () => makeOkResponse());
    const saveImpl = vi.fn(async () => undefined);
    const { lastFrame, stdin, unmount } = await mount(
      <ApiKeyPrompt
        onAccepted={onAccepted}
        fetchImpl={fetchImpl as unknown as typeof fetch}
        saveImpl={saveImpl}
      />,
    );
    stdin.write(VALID_KEY);
    await flush();
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✓");
    expect(frame).toContain("key saved");
    expect(saveImpl).toHaveBeenCalledTimes(1);
    expect(saveImpl).toHaveBeenCalledWith(VALID_KEY);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledWith(VALID_KEY);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(VALID_KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    unmount();
  });

  it("on 401 with error.message body, rejected state surfaces the message", async () => {
    const onAccepted = vi.fn();
    const fetchImpl = vi.fn(async () => makeErrorResponse(401, "invalid_api_key"));
    const saveImpl = vi.fn(async () => undefined);
    const { lastFrame, stdin, unmount } = await mount(
      <ApiKeyPrompt
        onAccepted={onAccepted}
        fetchImpl={fetchImpl as unknown as typeof fetch}
        saveImpl={saveImpl}
      />,
    );
    stdin.write(VALID_KEY);
    await flush();
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗");
    expect(frame).toContain("invalid_api_key");
    expect(saveImpl).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
    unmount();
  });

  it("when fetch throws (network error), rejected state shows the error message", async () => {
    const onAccepted = vi.fn();
    const fetchImpl = vi.fn(() => Promise.reject(new Error("ECONNRESET boom")));
    const saveImpl = vi.fn(async () => undefined);
    const { lastFrame, stdin, unmount } = await mount(
      <ApiKeyPrompt
        onAccepted={onAccepted}
        fetchImpl={fetchImpl as unknown as typeof fetch}
        saveImpl={saveImpl}
      />,
    );
    stdin.write(VALID_KEY);
    await flush();
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗");
    expect(frame).toContain("ECONNRESET boom");
    expect(saveImpl).not.toHaveBeenCalled();
    unmount();
  });

  it("when saveImpl rejects, rejected state surfaces the save error", async () => {
    const onAccepted = vi.fn();
    const fetchImpl = vi.fn(async () => makeOkResponse());
    const saveImpl = vi.fn(() => Promise.reject(new Error("disk full")));
    const { lastFrame, stdin, unmount } = await mount(
      <ApiKeyPrompt
        onAccepted={onAccepted}
        fetchImpl={fetchImpl as unknown as typeof fetch}
        saveImpl={saveImpl}
      />,
    );
    stdin.write(VALID_KEY);
    await flush();
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("✗");
    expect(frame).toContain("save failed");
    expect(frame).toContain("disk full");
    expect(onAccepted).not.toHaveBeenCalled();
    unmount();
  });

  it("Esc in the prompting state invokes onCancelled and does not persist", async () => {
    const onAccepted = vi.fn();
    const onCancelled = vi.fn();
    const fetchImpl = vi.fn();
    const saveImpl = vi.fn();
    const { stdin, unmount } = await mount(
      <ApiKeyPrompt
        onAccepted={onAccepted}
        onCancelled={onCancelled}
        fetchImpl={fetchImpl as unknown as typeof fetch}
        saveImpl={saveImpl}
      />,
    );
    stdin.write("\u001b");
    await flush();
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(saveImpl).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    unmount();
  });

  it("after rejection, pressing Enter resets back to prompting with empty value", async () => {
    const onAccepted = vi.fn();
    const fetchImpl = vi.fn();
    const saveImpl = vi.fn();
    const { lastFrame, stdin, unmount } = await mount(
      <ApiKeyPrompt
        onAccepted={onAccepted}
        fetchImpl={fetchImpl as unknown as typeof fetch}
        saveImpl={saveImpl}
      />,
    );
    stdin.write("\r");
    await flush();
    expect(lastFrame() ?? "").toContain("✗");
    stdin.write("\r");
    await flush();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("jellyclaw — first-run setup");
    expect(frame).not.toContain("✗");
    unmount();
  });
});
