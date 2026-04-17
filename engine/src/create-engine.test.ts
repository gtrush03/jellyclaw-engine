/**
 * Tests for createEngine().
 */

import { describe, expect, it, vi } from "vitest";

// Mock node:child_process BEFORE importing createEngine.
const spawnMock = vi.fn();
const forkMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  fork: forkMock,
}));

// Import after mock is set up.
const { createEngine } = await import("./create-engine.js");

// ---------------------------------------------------------------------------
// T1-08: no-child-process test
// ---------------------------------------------------------------------------

describe("createEngine: no-child-process", () => {
  it("does not spawn any child process during construction", async () => {
    // Reset mocks before test.
    spawnMock.mockClear();
    forkMock.mockClear();

    // Create engine with minimal config (no MCP servers to avoid spawn calls).
    const engine = await createEngine({
      config: {
        provider: { type: "anthropic" },
        mcp: [], // Explicitly no MCP servers
      },
    });

    try {
      // Assert spawn/fork were never called.
      expect(spawnMock).not.toHaveBeenCalled();
      expect(forkMock).not.toHaveBeenCalled();
    } finally {
      // Clean up.
      await engine.dispose();
    }
  });
});
