/**
 * Auto-memory injection (T3-04).
 *
 * Reads `~/.jellyclaw/projects/<cwd-hash>/memory/MEMORY.md` at session start
 * and injects it into the system prompt under a `# Memory` heading. This is
 * how user preferences, project-specific facts, and accumulated context
 * survive across sessions.
 *
 * The memory file path can be overridden via `JELLYCLAW_MEMORY_DIR` environment
 * variable. When set, the memory path uses `$JELLYCLAW_MEMORY_DIR/projects/<hash>/memory/MEMORY.md`
 * instead of `~/.jellyclaw`. This is primarily for testing.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Path computation
// ---------------------------------------------------------------------------

/**
 * SHA-256 of the absolute, normalized cwd, lowercased hex, first 16 chars.
 */
export function projectHash(cwd: string): string {
  const normalized = resolve(cwd);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Resolved absolute path to the memory file — DOES NOT check existence.
 * Uses `JELLYCLAW_MEMORY_DIR` if set, otherwise `~/.jellyclaw`.
 */
export function memoryPath(cwd: string): string {
  const baseDir = process.env.JELLYCLAW_MEMORY_DIR ?? join(homedir(), ".jellyclaw");
  return join(baseDir, "projects", projectHash(cwd), "memory", "MEMORY.md");
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Read the memory file if present; return null on ENOENT.
 * Throws on other errors (unreadable file is surfaced — don't hide silently).
 */
export async function loadMemory(cwd: string): Promise<string | null> {
  const path = memoryPath(cwd);
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format memory contents for injection into the system prompt.
 * Matches Claude Code's observed shape: `# Memory\n<contents>`.
 * Null or all-whitespace input → empty string.
 */
export function formatMemoryBlock(contents: string | null): string {
  if (contents === null) return "";
  const trimmed = contents.trim();
  if (trimmed.length === 0) return "";
  return `# Memory\n${trimmed}`;
}

// ---------------------------------------------------------------------------
// Writing (T3-05)
// ---------------------------------------------------------------------------

/**
 * Atomically write content to the memory file.
 * - Creates parent directories with mode 0o700.
 * - Writes to a temp file, then renames (atomic on POSIX).
 * - Final file mode is 0o600.
 */
export async function saveMemory(cwd: string, contents: string): Promise<void> {
  const finalPath = memoryPath(cwd);
  const dir = dirname(finalPath);

  // Ensure parent directories exist with secure mode.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    /* best-effort on platforms that reject chmod */
  }

  // Atomic write: tmp → chmod → rename.
  const tmpPath = join(dir, `.MEMORY.tmp.${randomUUID()}`);
  await writeFile(tmpPath, contents, { mode: 0o600, flag: "w" });
  try {
    await chmod(tmpPath, 0o600);
  } catch {
    /* best-effort */
  }
  await rename(tmpPath, finalPath);
  try {
    await chmod(finalPath, 0o600);
  } catch {
    /* best-effort */
  }
}

/**
 * Delete the memory file. Idempotent: ENOENT is swallowed.
 */
export async function deleteMemory(cwd: string): Promise<void> {
  const path = memoryPath(cwd);
  try {
    await unlink(path);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return; // Already gone — idempotent.
    }
    throw err;
  }
}
