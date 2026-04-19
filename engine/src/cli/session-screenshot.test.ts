/**
 * Phase 07.5 T4-02 — Session screenshot tests.
 *
 * Note: WebSocket-based capture tests are covered by smoke tests with real Chrome.
 * Unit tests here focus on the helpers and error paths that don't require WebSocket.
 */

// fs imports mocked below
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import {
  captureAllTabs,
  FREEZE_EXPRESSION,
  sanitize,
  UNFREEZE_EXPRESSION,
} from "./session-screenshot.js";

// Mock fs - use vi.hoisted to avoid initialization order issues
const { mockMkdirSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockMkdirSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));
vi.mock("node:fs", () => ({
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: "info",
  } as unknown as Logger;
}

describe("sanitize", () => {
  it("replaces unsafe chars with hyphens", () => {
    expect(sanitize("Hello World!")).toBe("hello-world");
  });

  it("lowercases the string", () => {
    expect(sanitize("UPPERCASE")).toBe("uppercase");
  });

  it("truncates to 60 chars", () => {
    const long = "a".repeat(100);
    expect(sanitize(long).length).toBe(60);
  });

  it("returns 'untitled' for empty string", () => {
    expect(sanitize("")).toBe("untitled");
  });

  it("returns 'untitled' for all-special-chars string", () => {
    expect(sanitize("!!!")).toBe("untitled");
  });

  it("preserves hyphens and alphanumerics", () => {
    expect(sanitize("my-page-123")).toBe("my-page-123");
  });

  it("removes leading and trailing hyphens", () => {
    expect(sanitize("---test---")).toBe("test");
  });

  it("handles URL-like titles", () => {
    // Note: multiple consecutive non-alphanumeric chars become multiple hyphens
    // which are then collapsed by leading/trailing removal but not internal
    const result = sanitize("Example Domain - https://example.com");
    expect(result).toMatch(/^example-domain.*https.*example.*com$/);
    expect(result.length).toBeLessThanOrEqual(60);
  });
});

describe("captureAllTabs", () => {
  let logger: Logger;

  beforeEach(() => {
    mockFetch.mockReset();
    mockMkdirSync.mockReset();
    logger = createMockLogger();
  });

  it("returns empty array when port not listening (ECONNREFUSED)", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await captureAllTabs(9333, "/tmp/out", logger);
    expect(result).toEqual([]);
  });

  it("returns empty array when fetch returns non-ok status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const result = await captureAllTabs(9333, "/tmp/out", logger);
    expect(result).toEqual([]);
  });

  it("returns empty array when no page tabs exist", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { type: "background_page", url: "chrome://extensions", title: "Extensions" },
        { type: "service_worker", url: "chrome://serviceworker", title: "SW" },
      ],
    });
    const result = await captureAllTabs(9333, "/tmp/out", logger);
    expect(result).toEqual([]);
  });

  it("returns empty array when all page tabs are chrome:// URLs", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          type: "page",
          url: "chrome://newtab",
          title: "New Tab",
          webSocketDebuggerUrl: "ws://...",
        },
        {
          type: "page",
          url: "chrome://settings",
          title: "Settings",
          webSocketDebuggerUrl: "ws://...",
        },
      ],
    });
    const result = await captureAllTabs(9333, "/tmp/out", logger);
    expect(result).toEqual([]);
  });

  it("returns empty array when tabs array is empty", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });
    const result = await captureAllTabs(9333, "/tmp/out", logger);
    expect(result).toEqual([]);
  });

  it("returns empty array when fetch times out", async () => {
    mockFetch.mockRejectedValueOnce(new DOMException("Aborted", "AbortError"));
    const result = await captureAllTabs(9333, "/tmp/out", logger);
    expect(result).toEqual([]);
  });

  it("creates output directory when valid pages exist (before attempting capture)", async () => {
    // Mock WebSocket to reject immediately
    const originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class MockWS {
      constructor() {
        setTimeout(() => {
          // Simulate error
        }, 0);
      }
      addEventListener(event: string, handler: () => void) {
        if (event === "error") {
          setTimeout(() => handler(), 0);
        }
      }
      send() {}
      close() {}
    } as unknown as typeof WebSocket;

    // First call: /json/version
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/abc",
      }),
    });
    // Second call: /json
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: "page123",
          type: "page",
          url: "https://example.com",
          title: "Example",
          webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/abc",
        },
      ],
    });

    // Will fail on WebSocket but should still create directory
    await captureAllTabs(9333, "/tmp/screenshots", logger);

    globalThis.WebSocket = originalWebSocket;

    expect(mockMkdirSync).toHaveBeenCalledWith("/tmp/screenshots", { recursive: true });
  });
});

describe("FREEZE_EXPRESSION", () => {
  it("contains load-bearing substring: requestAnimationFrame stub", () => {
    expect(FREEZE_EXPRESSION).toContain("requestAnimationFrame = () => 0");
  });

  it("contains load-bearing substring: canvas selector", () => {
    expect(FREEZE_EXPRESSION).toContain("document.querySelectorAll('canvas");
  });

  it("disables CSS animations and transitions", () => {
    expect(FREEZE_EXPRESSION).toContain("animation:none!important");
    expect(FREEZE_EXPRESSION).toContain("transition:none!important");
  });

  it("stores original requestAnimationFrame for restore", () => {
    expect(FREEZE_EXPRESSION).toContain("window.__jcOriginalRaf");
  });
});

describe("UNFREEZE_EXPRESSION", () => {
  it("restores requestAnimationFrame from backup", () => {
    expect(UNFREEZE_EXPRESSION).toContain("window.__jcOriginalRaf");
    expect(UNFREEZE_EXPRESSION).toContain("window.requestAnimationFrame = window.__jcOriginalRaf");
  });

  it("removes the freeze style element", () => {
    expect(UNFREEZE_EXPRESSION).toContain("__jc-freeze-style");
    expect(UNFREEZE_EXPRESSION).toContain("removeChild");
  });

  it("restores hidden element visibility", () => {
    expect(UNFREEZE_EXPRESSION).toContain("__jcHiddenEls");
    expect(UNFREEZE_EXPRESSION).toContain("el.style.visibility = prev");
  });
});

describe("captureAllTabs with WebSocket mocking", () => {
  let logger: Logger;
  let capturedMessages: string[];

  beforeEach(() => {
    mockFetch.mockReset();
    mockWriteFileSync.mockReset();
    mockMkdirSync.mockReset();
    logger = createMockLogger();
    capturedMessages = [];
  });

  function setupFetchMocks() {
    // First call: /json/version
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/abc",
      }),
    });
    // Second call: /json
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: "page123",
          type: "page",
          url: "https://example.com",
          title: "Example",
          webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/page/abc",
        },
      ],
    });
  }

  it("sends CDP messages in correct order: bringToFront → freeze → capture", async () => {
    const originalWebSocket = globalThis.WebSocket;
    let messageHandler: ((event: MessageEvent) => void) | null = null;

    // Class-based mock that properly triggers lifecycle events
    globalThis.WebSocket = class MockWS {
      constructor() {
        // Trigger open after a small delay (after event listeners are attached)
        setTimeout(() => {
          const openEvent = new Event("open");
          this.onopen?.(openEvent as unknown as Event);
        }, 10);
      }
      onopen: ((ev: Event) => void) | null = null;
      addEventListener(event: string, handler: unknown) {
        if (event === "open") {
          this.onopen = handler as (ev: Event) => void;
        }
        if (event === "message") {
          messageHandler = handler as (event: MessageEvent) => void;
        }
      }
      send(msg: string) {
        capturedMessages.push(msg);
        // Auto-respond to messages for the full flow
        const parsed = JSON.parse(msg);
        setTimeout(() => {
          if (!messageHandler) return;
          if (parsed.method === "Page.bringToFront") {
            messageHandler({ data: JSON.stringify({ id: parsed.id, result: {} }) } as MessageEvent);
          } else if (
            parsed.method === "Runtime.evaluate" &&
            parsed.params.expression.includes("__jcOriginalRaf = window.requestAnimationFrame")
          ) {
            messageHandler({
              data: JSON.stringify({ id: parsed.id, result: { value: { hidden: 0 } } }),
            } as MessageEvent);
          } else if (parsed.method === "Page.captureScreenshot") {
            const base64Data = Buffer.from("fake-png-data").toString("base64");
            messageHandler({
              data: JSON.stringify({ id: parsed.id, result: { data: base64Data } }),
            } as MessageEvent);
          }
          // Ignore unfreeze response - best-effort
        }, 5);
      }
      close() {}
    } as unknown as typeof WebSocket;

    setupFetchMocks();
    const result = await captureAllTabs(9333, "/tmp/screenshots", logger);

    globalThis.WebSocket = originalWebSocket;

    // Verify message order
    expect(capturedMessages.length).toBeGreaterThanOrEqual(3);

    const msg1 = JSON.parse(capturedMessages[0] ?? "{}");
    expect(msg1.method).toBe("Page.bringToFront");
    expect(msg1.id).toBe(1);

    const msg2 = JSON.parse(capturedMessages[1] ?? "{}");
    expect(msg2.method).toBe("Runtime.evaluate");
    expect(msg2.id).toBe(2);
    expect(msg2.params.expression).toContain("requestAnimationFrame = () => 0");
    expect(msg2.params.expression).toContain("document.querySelectorAll('canvas");

    const msg3 = JSON.parse(capturedMessages[2] ?? "{}");
    expect(msg3.method).toBe("Page.captureScreenshot");
    expect(msg3.id).toBe(3);

    // Unfreeze should be sent after capture
    if (capturedMessages.length >= 4) {
      const msg4 = JSON.parse(capturedMessages[3] ?? "{}");
      expect(msg4.method).toBe("Runtime.evaluate");
      expect(msg4.params.expression).toContain("__jcOriginalRaf");
    }

    expect(result.length).toBe(1);
  }, 15000); // Extended timeout for the 1000ms freeze delay

  it("rejects with 'screenshot error' when capture response has error", async () => {
    const originalWebSocket = globalThis.WebSocket;
    let messageHandler: ((event: MessageEvent) => void) | null = null;

    globalThis.WebSocket = class MockWS {
      constructor() {
        setTimeout(() => {
          this.onopen?.(new Event("open") as unknown as Event);
        }, 10);
      }
      onopen: ((ev: Event) => void) | null = null;
      addEventListener(event: string, handler: unknown) {
        if (event === "open") this.onopen = handler as (ev: Event) => void;
        if (event === "message") messageHandler = handler as (event: MessageEvent) => void;
      }
      send(msg: string) {
        const parsed = JSON.parse(msg);
        setTimeout(() => {
          if (!messageHandler) return;
          if (parsed.method === "Page.bringToFront") {
            messageHandler({ data: JSON.stringify({ id: parsed.id, result: {} }) } as MessageEvent);
          } else if (
            parsed.method === "Runtime.evaluate" &&
            parsed.params.expression.includes("__jcOriginalRaf = window.requestAnimationFrame")
          ) {
            messageHandler({
              data: JSON.stringify({ id: parsed.id, result: { value: { hidden: 0 } } }),
            } as MessageEvent);
          } else if (parsed.method === "Page.captureScreenshot") {
            // Return error instead of success
            messageHandler({
              data: JSON.stringify({ id: parsed.id, error: { message: "Page crashed" } }),
            } as MessageEvent);
          }
        }, 5);
      }
      close() {}
    } as unknown as typeof WebSocket;

    setupFetchMocks();
    await captureAllTabs(9333, "/tmp/screenshots", logger);

    globalThis.WebSocket = originalWebSocket;
    expect(logger.warn).toHaveBeenCalled();
  }, 15000);

  it("rejects with 'no data returned' when capture response has no data", async () => {
    const originalWebSocket = globalThis.WebSocket;
    let messageHandler: ((event: MessageEvent) => void) | null = null;

    globalThis.WebSocket = class MockWS {
      constructor() {
        setTimeout(() => {
          this.onopen?.(new Event("open") as unknown as Event);
        }, 10);
      }
      onopen: ((ev: Event) => void) | null = null;
      addEventListener(event: string, handler: unknown) {
        if (event === "open") this.onopen = handler as (ev: Event) => void;
        if (event === "message") messageHandler = handler as (event: MessageEvent) => void;
      }
      send(msg: string) {
        const parsed = JSON.parse(msg);
        setTimeout(() => {
          if (!messageHandler) return;
          if (parsed.method === "Page.bringToFront") {
            messageHandler({ data: JSON.stringify({ id: parsed.id, result: {} }) } as MessageEvent);
          } else if (
            parsed.method === "Runtime.evaluate" &&
            parsed.params.expression.includes("__jcOriginalRaf = window.requestAnimationFrame")
          ) {
            messageHandler({
              data: JSON.stringify({ id: parsed.id, result: { value: { hidden: 0 } } }),
            } as MessageEvent);
          } else if (parsed.method === "Page.captureScreenshot") {
            // Return result without data
            messageHandler({ data: JSON.stringify({ id: parsed.id, result: {} }) } as MessageEvent);
          }
        }, 5);
      }
      close() {}
    } as unknown as typeof WebSocket;

    setupFetchMocks();
    await captureAllTabs(9333, "/tmp/screenshots", logger);

    globalThis.WebSocket = originalWebSocket;
    expect(logger.warn).toHaveBeenCalled();
  }, 15000);

  it("rejects with 'freeze failed' when Runtime.evaluate returns error", async () => {
    const originalWebSocket = globalThis.WebSocket;
    let messageHandler: ((event: MessageEvent) => void) | null = null;

    globalThis.WebSocket = class MockWS {
      constructor() {
        setTimeout(() => {
          this.onopen?.(new Event("open") as unknown as Event);
        }, 10);
      }
      onopen: ((ev: Event) => void) | null = null;
      addEventListener(event: string, handler: unknown) {
        if (event === "open") this.onopen = handler as (ev: Event) => void;
        if (event === "message") messageHandler = handler as (event: MessageEvent) => void;
      }
      send(msg: string) {
        const parsed = JSON.parse(msg);
        setTimeout(() => {
          if (!messageHandler) return;
          if (parsed.method === "Page.bringToFront") {
            messageHandler({ data: JSON.stringify({ id: parsed.id, result: {} }) } as MessageEvent);
          } else if (parsed.method === "Runtime.evaluate") {
            // Return error for freeze
            messageHandler({
              data: JSON.stringify({
                id: parsed.id,
                error: { message: "Execution context destroyed" },
              }),
            } as MessageEvent);
          }
        }, 5);
      }
      close() {}
    } as unknown as typeof WebSocket;

    setupFetchMocks();
    await captureAllTabs(9333, "/tmp/screenshots", logger);

    globalThis.WebSocket = originalWebSocket;
    expect(logger.warn).toHaveBeenCalled();
  });

  it("writes PNG file when capture succeeds", async () => {
    const originalWebSocket = globalThis.WebSocket;
    let messageHandler: ((event: MessageEvent) => void) | null = null;

    globalThis.WebSocket = class MockWS {
      constructor() {
        setTimeout(() => {
          this.onopen?.(new Event("open") as unknown as Event);
        }, 10);
      }
      onopen: ((ev: Event) => void) | null = null;
      addEventListener(event: string, handler: unknown) {
        if (event === "open") this.onopen = handler as (ev: Event) => void;
        if (event === "message") messageHandler = handler as (event: MessageEvent) => void;
      }
      send(msg: string) {
        const parsed = JSON.parse(msg);
        setTimeout(() => {
          if (!messageHandler) return;
          if (parsed.method === "Page.bringToFront") {
            messageHandler({ data: JSON.stringify({ id: parsed.id, result: {} }) } as MessageEvent);
          } else if (
            parsed.method === "Runtime.evaluate" &&
            parsed.params.expression.includes("__jcOriginalRaf = window.requestAnimationFrame")
          ) {
            messageHandler({
              data: JSON.stringify({ id: parsed.id, result: { value: { hidden: 0 } } }),
            } as MessageEvent);
          } else if (parsed.method === "Page.captureScreenshot") {
            const base64Data = Buffer.from("fake-png-data").toString("base64");
            messageHandler({
              data: JSON.stringify({ id: parsed.id, result: { data: base64Data } }),
            } as MessageEvent);
          }
        }, 5);
      }
      close() {}
    } as unknown as typeof WebSocket;

    setupFetchMocks();
    const result = await captureAllTabs(9333, "/tmp/screenshots", logger);

    globalThis.WebSocket = originalWebSocket;

    expect(mockWriteFileSync).toHaveBeenCalled();
    expect(result.length).toBe(1);
    expect(result[0]).toContain("final-00-example.png");
  }, 15000);
});
