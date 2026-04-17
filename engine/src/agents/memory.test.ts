/**
 * Tests for auto-memory injection (T3-04).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatMemoryBlock, loadMemory, memoryPath, projectHash } from "./memory.js";

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let originalEnv: string | undefined;

beforeEach(() => {
  // Create a unique temp directory for each test
  testDir = join(
    tmpdir(),
    `jellyclaw-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// ---------------------------------------------------------------------------
// projectHash tests
// ---------------------------------------------------------------------------

describe("projectHash", () => {
  it("returns 16 lowercase hex chars", () => {
    const hash = projectHash("/tmp/test");
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns different hashes for different paths", () => {
    const hash1 = projectHash("/tmp/a");
    const hash2 = projectHash("/tmp/b");
    expect(hash1).not.toBe(hash2);
  });

  it("returns same hash for same path", () => {
    const hash1 = projectHash("/tmp/test");
    const hash2 = projectHash("/tmp/test");
    expect(hash1).toBe(hash2);
  });
});

// ---------------------------------------------------------------------------
// memoryPath tests
// ---------------------------------------------------------------------------

describe("memoryPath: memory-path-uses-cwd-hash", () => {
  it("uses cwd hash in the path", () => {
    const pathA = memoryPath("/tmp/a");
    const pathB = memoryPath("/tmp/b");

    // Both should be different
    expect(pathA).not.toBe(pathB);

    // Both should contain the hash segment (16 hex chars)
    const hashA = projectHash("/tmp/a");
    const hashB = projectHash("/tmp/b");

    expect(pathA).toContain(hashA);
    expect(pathB).toContain(hashB);
    expect(hashA).toMatch(/^[0-9a-f]{16}$/);
    expect(hashB).toMatch(/^[0-9a-f]{16}$/);
  });

  it("uses JELLYCLAW_MEMORY_DIR when set", () => {
    const path = memoryPath("/tmp/test");
    expect(path.startsWith(testDir)).toBe(true);
  });

  it("ends with MEMORY.md", () => {
    const path = memoryPath("/tmp/test");
    expect(path.endsWith("MEMORY.md")).toBe(true);
  });

  it("includes projects and memory directories", () => {
    const path = memoryPath("/tmp/test");
    expect(path).toContain("projects");
    expect(path).toContain("memory");
  });
});

// ---------------------------------------------------------------------------
// loadMemory tests
// ---------------------------------------------------------------------------

describe("loadMemory: memory-file-absent", () => {
  it("returns null when file does not exist", async () => {
    const result = await loadMemory("/nonexistent/path");
    expect(result).toBeNull();
  });

  it("does not throw when file is absent", async () => {
    await expect(loadMemory("/tmp/definitely-not-a-real-path")).resolves.toBeNull();
  });
});

describe("loadMemory: memory-file-present", () => {
  it("returns file contents when file exists", async () => {
    const cwd = "/tmp/test-project";
    const hash = projectHash(cwd);
    const memDir = join(testDir, "projects", hash, "memory");
    mkdirSync(memDir, { recursive: true });

    const expectedContent = "This is my memory content.\nLine 2.";
    writeFileSync(join(memDir, "MEMORY.md"), expectedContent, "utf8");

    const result = await loadMemory(cwd);
    expect(result).toBe(expectedContent);
  });

  it("returns exact contents including whitespace", async () => {
    const cwd = "/tmp/another-project";
    const hash = projectHash(cwd);
    const memDir = join(testDir, "projects", hash, "memory");
    mkdirSync(memDir, { recursive: true });

    const expectedContent = "  Leading whitespace\n\nBlank line above  ";
    writeFileSync(join(memDir, "MEMORY.md"), expectedContent, "utf8");

    const result = await loadMemory(cwd);
    expect(result).toBe(expectedContent);
  });
});

// ---------------------------------------------------------------------------
// formatMemoryBlock tests
// ---------------------------------------------------------------------------

describe("formatMemoryBlock", () => {
  it("returns empty string for null input", () => {
    expect(formatMemoryBlock(null)).toBe("");
  });

  it("returns empty string for empty string input", () => {
    expect(formatMemoryBlock("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(formatMemoryBlock("   \n\t  ")).toBe("");
  });

  it("formats non-empty content with # Memory heading", () => {
    const result = formatMemoryBlock("My memory content");
    expect(result).toBe("# Memory\nMy memory content");
  });

  it("trims leading and trailing whitespace from content", () => {
    const result = formatMemoryBlock("  trimmed content  \n");
    expect(result).toBe("# Memory\ntrimmed content");
  });

  it("preserves internal whitespace in content", () => {
    const result = formatMemoryBlock("line 1\n\nline 3");
    expect(result).toBe("# Memory\nline 1\n\nline 3");
  });
});

// ---------------------------------------------------------------------------
// Integration: formatMemoryBlock with loadMemory
// ---------------------------------------------------------------------------

describe("formatMemoryBlock with loadMemory integration", () => {
  it("memory-file-absent: formatMemoryBlock(null) returns empty string", async () => {
    const contents = await loadMemory("/nonexistent");
    expect(contents).toBeNull();
    expect(formatMemoryBlock(contents)).toBe("");
  });

  it("memory-file-present: produces # Memory block", async () => {
    const cwd = "/tmp/integration-test";
    const hash = projectHash(cwd);
    const memDir = join(testDir, "projects", hash, "memory");
    mkdirSync(memDir, { recursive: true });

    const memoryContent = "Project uses TypeScript.\nPrefer async/await.";
    writeFileSync(join(memDir, "MEMORY.md"), memoryContent, "utf8");

    const contents = await loadMemory(cwd);
    expect(contents).toBe(memoryContent);

    const block = formatMemoryBlock(contents);
    expect(block).toContain("# Memory");
    expect(block).toContain("Project uses TypeScript.");
    expect(block).toContain("Prefer async/await.");
  });
});
