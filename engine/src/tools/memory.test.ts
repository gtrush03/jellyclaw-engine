/**
 * Tests for Memory tool (T3-05).
 */

import { mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import memoryFixture from "../../../test/fixtures/tools/claude-code-schemas/Memory.json" with {
  type: "json",
};
import { loadMemory, projectHash } from "../agents/memory.js";
import { listTools } from "./index.js";
import { memoryJsonSchema, memoryTool } from "./memory.js";
import type { PermissionService, ToolContext } from "./types.js";

const SILENT_LOGGER = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  // Create a unique temp directory for each test
  testDir = join(
    tmpdir(),
    `jellyclaw-memory-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });

  // Save original env and set override
  originalEnv = process.env.JELLYCLAW_MEMORY_DIR;
  process.env.JELLYCLAW_MEMORY_DIR = testDir;
});

afterEach(() => {
  // Restore original env
  if (originalEnv === undefined) {
    delete process.env.JELLYCLAW_MEMORY_DIR;
  } else {
    process.env.JELLYCLAW_MEMORY_DIR = originalEnv;
  }

  // Clean up temp directory
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

function makeTestContext(cwd: string): ToolContext {
  const permissions: PermissionService = {
    isAllowed: () => true,
  };
  return {
    cwd,
    sessionId: "test-session",
    readCache: new Set(),
    abort: new AbortController().signal,
    logger: SILENT_LOGGER,
    permissions,
  };
}

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("Memory: registered", () => {
  it("listTools() contains Memory", () => {
    const tools = listTools();
    const found = tools.find((t) => t.name === "Memory");
    expect(found).toBeDefined();
  });

  it("schema matches the fixture", () => {
    const toolSchema = memoryJsonSchema;

    expect(toolSchema.type).toBe(memoryFixture.type);
    expect(toolSchema.additionalProperties).toBe(memoryFixture.additionalProperties);
    expect(toolSchema.required).toEqual(memoryFixture.required);
    expect(toolSchema.properties.action).toEqual(memoryFixture.properties.action);
    expect(toolSchema.properties.content).toEqual(memoryFixture.properties.content);
  });
});

// ---------------------------------------------------------------------------
// Write tests
// ---------------------------------------------------------------------------

describe("Memory: write-new-entry", () => {
  it("creates MEMORY.md atomically with the given content", async () => {
    const cwd = "/tmp/test-write-project";
    const ctx = makeTestContext(cwd);

    const result = await memoryTool.handler({ action: "write", content: "hello" }, ctx);

    expect(result).toContain("memory updated");
    expect(result).toContain("5 bytes");

    // Verify file exists
    const hash = projectHash(cwd);
    const memDir = join(testDir, "projects", hash, "memory");
    const memPath = join(memDir, "MEMORY.md");

    const stat = statSync(memPath);
    expect(stat.isFile()).toBe(true);
    // Check mode (on Unix systems, mode includes file type bits)
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);

    // Verify content
    const content = await loadMemory(cwd);
    expect(content).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// Persistence tests
// ---------------------------------------------------------------------------

describe("Memory: persists-across-sessions", () => {
  it("after Memory write, a fresh loadMemory() call returns the written content byte-for-byte", async () => {
    const cwd = "/tmp/test-persist-project";
    const ctx = makeTestContext(cwd);

    // Write in first "session"
    await memoryTool.handler({ action: "write", content: "alpha" }, ctx);

    // Simulate fresh session: just call loadMemory directly
    const loaded = await loadMemory(cwd);
    expect(loaded).toBe("alpha");
  });
});

// ---------------------------------------------------------------------------
// Delete tests
// ---------------------------------------------------------------------------

describe("Memory: delete-clears-file", () => {
  it("Memory { action: 'delete' } removes the file; subsequent loadMemory returns null", async () => {
    const cwd = "/tmp/test-delete-project";
    const ctx = makeTestContext(cwd);

    // First write something
    await memoryTool.handler({ action: "write", content: "to-be-deleted" }, ctx);

    // Verify it exists
    const contentBefore = await loadMemory(cwd);
    expect(contentBefore).toBe("to-be-deleted");

    // Delete
    const result = await memoryTool.handler({ action: "delete" }, ctx);
    expect(result).toBe("memory deleted");

    // Verify it's gone
    const contentAfter = await loadMemory(cwd);
    expect(contentAfter).toBeNull();
  });

  it("delete is idempotent - calling on non-existent file does not throw", async () => {
    const cwd = "/tmp/test-delete-nonexistent";
    const ctx = makeTestContext(cwd);

    // Delete without prior write
    const result = await memoryTool.handler({ action: "delete" }, ctx);
    expect(result).toBe("memory deleted");
  });
});

// ---------------------------------------------------------------------------
// Read tests
// ---------------------------------------------------------------------------

describe("Memory: read", () => {
  it("returns content when memory exists", async () => {
    const cwd = "/tmp/test-read-project";
    const ctx = makeTestContext(cwd);

    await memoryTool.handler({ action: "write", content: "read-test" }, ctx);

    const result = await memoryTool.handler({ action: "read" }, ctx);
    expect(result).toBe("read-test");
  });

  it("returns (empty) when memory does not exist", async () => {
    const cwd = "/tmp/test-read-empty";
    const ctx = makeTestContext(cwd);

    const result = await memoryTool.handler({ action: "read" }, ctx);
    expect(result).toBe("(empty)");
  });
});

// ---------------------------------------------------------------------------
// Append tests
// ---------------------------------------------------------------------------

describe("Memory: append", () => {
  it("appends to existing memory", async () => {
    const cwd = "/tmp/test-append-project";
    const ctx = makeTestContext(cwd);

    await memoryTool.handler({ action: "write", content: "line1" }, ctx);
    const result = await memoryTool.handler({ action: "append", content: "line2" }, ctx);

    expect(result).toBe("memory appended");

    const content = await loadMemory(cwd);
    expect(content).toBe("line1\nline2");
  });

  it("creates memory if it does not exist", async () => {
    const cwd = "/tmp/test-append-new";
    const ctx = makeTestContext(cwd);

    const result = await memoryTool.handler({ action: "append", content: "first-line" }, ctx);

    expect(result).toBe("memory appended");

    const content = await loadMemory(cwd);
    expect(content).toBe("first-line");
  });
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe("Memory: validation", () => {
  it("write with empty content is rejected by zod", async () => {
    const cwd = "/tmp/test-validation";
    const ctx = makeTestContext(cwd);

    await expect(memoryTool.handler({ action: "write", content: "" }, ctx)).rejects.toThrow();
  });

  it("write without content is rejected by zod", async () => {
    const cwd = "/tmp/test-validation-2";
    const ctx = makeTestContext(cwd);

    await expect(memoryTool.handler({ action: "write" } as unknown, ctx)).rejects.toThrow();
  });

  it("read with content is rejected by zod", async () => {
    const cwd = "/tmp/test-validation-3";
    const ctx = makeTestContext(cwd);

    await expect(
      memoryTool.handler({ action: "read", content: "bad" } as unknown, ctx),
    ).rejects.toThrow();
  });

  it("delete with content is rejected by zod", async () => {
    const cwd = "/tmp/test-validation-4";
    const ctx = makeTestContext(cwd);

    await expect(
      memoryTool.handler({ action: "delete", content: "bad" } as unknown, ctx),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Concurrency stress test
// ---------------------------------------------------------------------------

describe("Memory: atomic-write-stress", () => {
  it("parallel saveMemory calls result in a complete file (no partial writes)", async () => {
    const cwd = "/tmp/test-stress";
    const ctx = makeTestContext(cwd);

    // Generate 10 distinct contents
    const contents = Array.from({ length: 10 }, (_, i) => `content-${i}-${"x".repeat(1000)}`);

    // Fire all writes in parallel
    await Promise.all(
      contents.map((content) => memoryTool.handler({ action: "write", content }, ctx)),
    );

    // Final file should contain exactly ONE of the inputs (no interleaving)
    const final = await loadMemory(cwd);
    expect(final).not.toBeNull();
    expect(contents).toContain(final);
  });
});
