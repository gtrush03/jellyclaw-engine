/**
 * Tests for sidecar client (T4-06).
 */

import { describe, expect, it } from "vitest";

import {
  getSidecarInfo,
  type InvokeFn,
  isSidecarRunning,
  restartSidecar,
  SidecarError,
  SidecarInfoSchema,
  shutdownSidecar,
} from "./sidecar.js";

// ---------------------------------------------------------------------------
// Mock invoke helpers
// ---------------------------------------------------------------------------

function createMockInvoke(responses: Record<string, unknown | (() => unknown)>): InvokeFn {
  return <T>(cmd: string, _args?: Record<string, unknown>): Promise<T> => {
    const response = responses[cmd];
    if (response === undefined) {
      return Promise.reject(new Error(`Unmocked command: ${cmd}`));
    }
    if (typeof response === "function") {
      return Promise.resolve(response() as T);
    }
    return Promise.resolve(response as T);
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SidecarInfoSchema", () => {
  it("accepts valid sidecar info", () => {
    const result = SidecarInfoSchema.safeParse({
      port: 8080,
      token: "abc123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid port (too low)", () => {
    const result = SidecarInfoSchema.safeParse({
      port: 0,
      token: "abc123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid port (too high)", () => {
    const result = SidecarInfoSchema.safeParse({
      port: 70000,
      token: "abc123",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty token", () => {
    const result = SidecarInfoSchema.safeParse({
      port: 8080,
      token: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing fields", () => {
    const result = SidecarInfoSchema.safeParse({
      port: 8080,
    });
    expect(result.success).toBe(false);
  });
});

describe("sidecar-handshake", () => {
  it("getSidecarInfo returns port and token on success", async () => {
    const mockInvoke = createMockInvoke({
      get_sidecar_info: {
        port: 12345,
        token: "test-token-abc123",
      },
    });

    const info = await getSidecarInfo(mockInvoke);

    expect(info.port).toBe(12345);
    expect(info.token).toBe("test-token-abc123");
  });

  it("getSidecarInfo retries on transient failures", async () => {
    let attempts = 0;
    const mockInvoke = createMockInvoke({
      get_sidecar_info: () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Sidecar not ready");
        }
        return { port: 54321, token: "finally-ready" };
      },
    });

    const info = await getSidecarInfo(mockInvoke, {
      maxAttempts: 5,
      initialDelayMs: 10, // Fast for tests
    });

    expect(attempts).toBe(3);
    expect(info.port).toBe(54321);
    expect(info.token).toBe("finally-ready");
  });

  it("getSidecarInfo throws after max retries", async () => {
    const mockInvoke = createMockInvoke({
      get_sidecar_info: () => {
        throw new Error("Permanently broken");
      },
    });

    await expect(
      getSidecarInfo(mockInvoke, {
        maxAttempts: 3,
        initialDelayMs: 10,
      }),
    ).rejects.toThrow(SidecarError);
  });

  it("getSidecarInfo validates response schema", async () => {
    const mockInvoke = createMockInvoke({
      get_sidecar_info: {
        port: "not-a-number",
        token: 123,
      },
    });

    await expect(
      getSidecarInfo(mockInvoke, { maxAttempts: 1 }),
    ).rejects.toThrow(SidecarError);
  });
});

describe("isSidecarRunning", () => {
  it("returns true when sidecar is running", async () => {
    const mockInvoke = createMockInvoke({
      is_sidecar_running: true,
    });

    const result = await isSidecarRunning(mockInvoke);
    expect(result).toBe(true);
  });

  it("returns false when sidecar is not running", async () => {
    const mockInvoke = createMockInvoke({
      is_sidecar_running: false,
    });

    const result = await isSidecarRunning(mockInvoke);
    expect(result).toBe(false);
  });
});

describe("restartSidecar", () => {
  it("returns new sidecar info after restart", async () => {
    const mockInvoke = createMockInvoke({
      restart_sidecar: {
        port: 9999,
        token: "new-token",
      },
    });

    const info = await restartSidecar(mockInvoke);
    expect(info.port).toBe(9999);
    expect(info.token).toBe("new-token");
  });
});

describe("shutdownSidecar", () => {
  it("calls shutdown command", async () => {
    let called = false;
    const mockInvoke = createMockInvoke({
      shutdown_sidecar: () => {
        called = true;
        return undefined;
      },
    });

    await shutdownSidecar(mockInvoke);
    expect(called).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration-style tests (would need real Tauri environment)
// ---------------------------------------------------------------------------

describe("no-orphan-on-parent-exit", () => {
  // This test is more of a documentation placeholder.
  // The actual test requires:
  // 1. Launch Tauri dev binary in subprocess
  // 2. Get sidecar PID via IPC
  // 3. SIGTERM the parent Tauri process
  // 4. Wait 3 seconds
  // 5. Assert sidecar PID is no longer running

  it.skip("sidecar terminates when parent process exits", async () => {
    // This test must be run with the actual Tauri binary.
    // See scripts/test-orphan.sh for the shell-based implementation.
    //
    // In the real test:
    // - Start Tauri app in subprocess
    // - Call get_sidecar_info via IPC to ensure sidecar is running
    // - Get the sidecar PID (from ps output or another IPC command)
    // - Send SIGTERM to the Tauri process
    // - Wait 3 seconds
    // - Check if sidecar PID still exists
    // - Assert it does not
  });
});
