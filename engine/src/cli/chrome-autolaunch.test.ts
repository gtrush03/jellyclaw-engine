/**
 * Phase 07.5 T4-01 — Chrome auto-lifecycle tests.
 */

import { spawn } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger.js";
import type { McpServerConfig } from "../mcp/types.js";
import {
  countPageTabs,
  ensureChromeRunning,
  extractLocalCdpPorts,
  launchChrome,
  openBlankTab,
  probeCdp,
  waitForCdp,
} from "./chrome-autolaunch.js";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
  })),
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

describe("extractLocalCdpPorts", () => {
  it("returns empty set for empty configs", () => {
    const ports = extractLocalCdpPorts([]);
    expect(ports.size).toBe(0);
  });

  it("returns empty set for configs without --cdp-endpoint", () => {
    const configs: McpServerConfig[] = [
      {
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
      },
    ];
    const ports = extractLocalCdpPorts(configs);
    expect(ports.size).toBe(0);
  });

  it("extracts port from --cdp-endpoint http://127.0.0.1:9333", () => {
    const configs: McpServerConfig[] = [
      {
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest", "--cdp-endpoint", "http://127.0.0.1:9333"],
      },
    ];
    const ports = extractLocalCdpPorts(configs);
    expect(ports.has(9333)).toBe(true);
    expect(ports.size).toBe(1);
  });

  it("ignores remote CDP endpoints (not 127.0.0.1)", () => {
    const configs: McpServerConfig[] = [
      {
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["--cdp-endpoint", "http://some.host:9333"],
      },
    ];
    const ports = extractLocalCdpPorts(configs);
    expect(ports.size).toBe(0);
  });

  it("deduplicates multiple configs pointing at same port", () => {
    const configs: McpServerConfig[] = [
      {
        transport: "stdio",
        name: "playwright1",
        command: "npx",
        args: ["--cdp-endpoint", "http://127.0.0.1:9333"],
      },
      {
        transport: "stdio",
        name: "playwright2",
        command: "npx",
        args: ["--cdp-endpoint", "http://127.0.0.1:9333"],
      },
    ];
    const ports = extractLocalCdpPorts(configs);
    expect(ports.size).toBe(1);
    expect(ports.has(9333)).toBe(true);
  });

  it("ignores non-stdio transports", () => {
    const configs: McpServerConfig[] = [
      {
        transport: "http",
        name: "remote",
        url: "http://example.com",
      },
    ];
    const ports = extractLocalCdpPorts(configs);
    expect(ports.size).toBe(0);
  });

  it("handles missing args gracefully", () => {
    const configs: McpServerConfig[] = [
      {
        transport: "stdio",
        name: "playwright",
        command: "npx",
        // args is undefined
      },
    ];
    const ports = extractLocalCdpPorts(configs);
    expect(ports.size).toBe(0);
  });
});

describe("probeCdp", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns true when /json/version responds with 200", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    const result = await probeCdp(9333);
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9333/json/version",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns false when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const result = await probeCdp(9333);
    expect(result).toBe(false);
  });

  it("returns false when response is not ok", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const result = await probeCdp(9333);
    expect(result).toBe(false);
  });
});

describe("countPageTabs", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns count of tabs with type=page", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { type: "page", url: "about:blank" },
        { type: "page", url: "https://example.com" },
        { type: "background_page", url: "chrome://newtab" },
      ],
    });
    const count = await countPageTabs(9333);
    expect(count).toBe(2);
  });

  it("returns 0 when no page tabs", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ type: "background_page" }],
    });
    const count = await countPageTabs(9333);
    expect(count).toBe(0);
  });

  it("returns 0 when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const count = await countPageTabs(9333);
    expect(count).toBe(0);
  });
});

describe("openBlankTab", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("makes PUT request to /json/new?about:blank", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });
    await openBlankTab(9333);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://127.0.0.1:9333/json/new?about:blank",
      expect.objectContaining({ method: "PUT", signal: expect.any(AbortSignal) }),
    );
  });
});

describe("launchChrome", () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
  });

  it("spawns scripts/jellyclaw-chrome.sh with JELLYCLAW_CHROME_PORT env", () => {
    const mockChild = { unref: vi.fn() };
    vi.mocked(spawn).mockReturnValueOnce(mockChild as unknown as ReturnType<typeof spawn>);

    launchChrome(9333);

    expect(spawn).toHaveBeenCalledWith(
      "bash",
      [expect.stringContaining("scripts/jellyclaw-chrome.sh")],
      expect.objectContaining({
        env: expect.objectContaining({ JELLYCLAW_CHROME_PORT: "9333" }),
        detached: true,
        stdio: "ignore",
      }),
    );
    expect(mockChild.unref).toHaveBeenCalled();
  });
});

describe("waitForCdp", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("resolves immediately if CDP is already up", async () => {
    mockFetch.mockResolvedValue({ ok: true });
    await expect(waitForCdp(9333, 5000)).resolves.toBeUndefined();
  });

  it("throws if CDP never comes up within timeout", async () => {
    // Use a very short timeout to avoid actual waiting
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(waitForCdp(9333, 50)).rejects.toThrow(
      "chrome: CDP did not come up on :9333 within 50ms",
    );
  });
});

describe("ensureChromeRunning", () => {
  let logger: Logger;

  beforeEach(() => {
    mockFetch.mockReset();
    vi.mocked(spawn).mockClear();
    logger = createMockLogger();
  });

  it("is a no-op for empty configs", async () => {
    await ensureChromeRunning([], logger);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("is a no-op for configs without --cdp-endpoint", async () => {
    const configs: McpServerConfig[] = [
      {
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
      },
    ];
    await ensureChromeRunning(configs, logger);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn Chrome when CDP is already alive with tabs", async () => {
    // probeCdp returns true
    mockFetch
      .mockResolvedValueOnce({ ok: true }) // /json/version
      .mockResolvedValueOnce({
        // countPageTabs first call
        ok: true,
        json: async () => [{ type: "page" }],
      })
      .mockResolvedValueOnce({
        // countPageTabs second call (for logging)
        ok: true,
        json: async () => [{ type: "page" }],
      });

    const configs: McpServerConfig[] = [
      {
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["--cdp-endpoint", "http://127.0.0.1:9333"],
      },
    ];

    await ensureChromeRunning(configs, logger);

    expect(spawn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9333, tabs: 1 }),
      "chrome: ready on :9333",
    );
  });

  it("opens blank tab when CDP is alive but has 0 tabs", async () => {
    // probeCdp returns true
    mockFetch
      .mockResolvedValueOnce({ ok: true }) // /json/version
      .mockResolvedValueOnce({
        // countPageTabs first call - 0 tabs
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({ ok: true }) // openBlankTab PUT
      .mockResolvedValueOnce({
        // countPageTabs second call (for logging)
        ok: true,
        json: async () => [{ type: "page" }],
      });

    const configs: McpServerConfig[] = [
      {
        transport: "stdio",
        name: "playwright",
        command: "npx",
        args: ["--cdp-endpoint", "http://127.0.0.1:9333"],
      },
    ];

    await ensureChromeRunning(configs, logger);

    expect(spawn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9333 }),
      "chrome: no page tabs on :9333 — opening about:blank",
    );
  });
});
