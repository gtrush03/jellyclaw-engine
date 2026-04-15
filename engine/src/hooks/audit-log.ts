/**
 * Hook audit log (Phase 08.02).
 *
 * Append-only JSON-lines file at `~/.jellyclaw/logs/hooks.jsonl`.
 *
 * One line per hook INVOCATION (not per event): an event that fires 3
 * matching hooks produces 3 lines. Entries are `HookAuditEntry` from
 * `./types.ts`.
 *
 * Invariants:
 *   - File created with mode `0600` on first use (user-only read/write).
 *     Rotated files inherit the mode (rename preserves perms).
 *   - Rotation is synchronous and cheap: `statSync` is cached for up to
 *     100 ms so a burst of hook invocations doesn't pay the stat cost on
 *     every append.
 *   - The default sink NEVER throws. The permissions-engine audit sink
 *     already follows this contract; we mirror it.
 *
 * Test-only override: setting the `HOOKS_LOG_PATH_OVERRIDE` environment
 * variable reroutes the log to a caller-chosen path. This exists for
 * `audit-log.test.ts` so tests never touch the real `~/.jellyclaw`.
 * Not documented for end-users; not a supported public API.
 */

import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { HookAuditEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path to `hooks.jsonl`. Honours
 * `process.env.HOOKS_LOG_PATH_OVERRIDE` for tests; falls back to
 * `~/.jellyclaw/logs/hooks.jsonl`.
 */
export function resolveHooksLogPath(): string {
  const override = process.env["HOOKS_LOG_PATH_OVERRIDE"];
  if (override && override.length > 0) return override;
  return join(homedir(), ".jellyclaw", "logs", "hooks.jsonl");
}

// ---------------------------------------------------------------------------
// Rotation defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024;
const DEFAULT_KEEP = 5;
const STAT_CACHE_TTL_MS = 100;

interface StatCacheEntry {
  readonly path: string;
  readonly size: number;
  readonly checkedAt: number;
}

let statCache: StatCacheEntry | null = null;

function cachedSize(path: string): number {
  const now = Date.now();
  if (statCache && statCache.path === path && now - statCache.checkedAt < STAT_CACHE_TTL_MS) {
    return statCache.size;
  }
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    size = 0;
  }
  statCache = { path, size, checkedAt: now };
  return size;
}

function invalidateStatCache(): void {
  statCache = null;
}

/**
 * Synchronous size-based rotation.
 *
 * If the current file is at or above `maxSizeBytes`, rename
 * `foo.jsonl.{keep-1}` → dropped, `foo.jsonl.{keep-2}` → `foo.jsonl.{keep-1}`,
 * …, `foo.jsonl` → `foo.jsonl.1`. The new writes land in a fresh
 * `foo.jsonl` file (created lazily by the next `defaultHookAuditSink` call).
 */
export function rotateIfNeeded(
  path?: string,
  opts?: { maxSizeBytes?: number; keep?: number },
): void {
  const p = path ?? resolveHooksLogPath();
  const maxSize = opts?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const keep = Math.max(1, opts?.keep ?? DEFAULT_KEEP);

  if (!existsSync(p)) return;
  const size = cachedSize(p);
  if (size < maxSize) return;

  // Drop the oldest, shift down, rotate current to `.1`.
  const oldest = `${p}.${keep}`;
  if (existsSync(oldest)) {
    try {
      unlinkSync(oldest);
    } catch {
      // best-effort; fall through
    }
  }
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${p}.${i}`;
    const to = `${p}.${i + 1}`;
    if (existsSync(from)) {
      try {
        renameSync(from, to);
      } catch {
        // best-effort
      }
    }
  }
  try {
    renameSync(p, `${p}.1`);
  } catch {
    // if we can't rotate, we fall through and keep appending
  }
  invalidateStatCache();
}

// ---------------------------------------------------------------------------
// Default sink
// ---------------------------------------------------------------------------

/**
 * Append one `HookAuditEntry` as a JSON line to the hooks audit log.
 * Creates the enclosing directory + file lazily. On FIRST creation the
 * file is chmod'd to `0o600`. Rotation runs before the append.
 *
 * This function swallows all errors internally — a broken audit sink
 * must never turn a hook result into a thrown exception. Errors are
 * reported via `process.stderr.write` so they surface in logs without
 * invoking a logger (to avoid circular imports).
 */
export function defaultHookAuditSink(entry: HookAuditEntry): void {
  try {
    const path = resolveHooksLogPath();
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true });

    const isCreate = !existsSync(path);
    if (isCreate) {
      // Open with exclusive-ish create + chmod; the `0o600` mode argument
      // is respected on create. Close immediately so the append below is
      // a plain append-open.
      const fd = openSync(path, "a", 0o600);
      closeSync(fd);
      // Belt-and-suspenders: umask can mask the mode arg on some platforms.
      try {
        chmodSync(path, 0o600);
      } catch {
        // best-effort; file exists either way
      }
      invalidateStatCache();
    } else {
      rotateIfNeeded(path);
    }

    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
    // Update cached size optimistically.
    if (statCache && statCache.path === path) {
      statCache = {
        path,
        size: statCache.size + Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8"),
        checkedAt: statCache.checkedAt,
      };
    }
  } catch (err) {
    // Never let an audit failure poison the caller.
    try {
      process.stderr.write(
        `jellyclaw: hook audit sink failed: ${(err as Error).message ?? String(err)}\n`,
      );
    } catch {
      // if even stderr is broken, give up silently
    }
  }
}

// ---------------------------------------------------------------------------
// Test helper — in-memory sink
// ---------------------------------------------------------------------------

/**
 * Build an in-memory sink + the array it writes to. Tests inject
 * `sink` into the runner/registry and inspect `entries` directly.
 */
export function createMemoryAuditSink(): {
  sink: (entry: HookAuditEntry) => void;
  entries: HookAuditEntry[];
} {
  const entries: HookAuditEntry[] = [];
  return {
    entries,
    sink: (entry) => {
      entries.push(entry);
    },
  };
}
