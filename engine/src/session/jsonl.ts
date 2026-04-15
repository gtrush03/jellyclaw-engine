/**
 * Phase 09.02 — JSONL transcript writer.
 *
 * Append-only NDJSON log, one `AgentEvent` per line. Writes are serialized
 * through a local promise chain so concurrent callers never interleave bytes
 * mid-line. `flushTurn()` issues a single `fsync`; `maybeRotate()` may only
 * be called at turn boundary.
 *
 * Rotation shifts `<id>.jsonl` → `<id>.jsonl.1`, `.1` → `.2`, `.2` → `.3`, and
 * anything at `.N` (N ≥ 3) is gzipped (streamed; never held in memory) into
 * `<id>.jsonl.N.gz`. Existing `.N.gz` files shift up too. No retention cap.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, open, rename, unlink } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import type { Logger } from "pino";

import type { AgentEvent } from "../events.js";
import { createLogger } from "../logger.js";
import { DEFAULT_ROTATE_BYTES, type JsonlWriter, type OpenJsonlOptions } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the highest N such that `<base>.N` or `<base>.N.gz` exists. Returns 0
 * if neither form exists at any N ≥ 1.
 */
async function highestSuffix(base: string): Promise<number> {
  let n = 0;
  // Walk upward until we hit a gap; callers only ever increment, so the
  // sequence is dense in practice. Safeguard: stop at 10_000 to avoid a
  // pathological unbounded loop.
  for (let i = 1; i < 10_000; i++) {
    const plain = `${base}.${i}`;
    const gz = `${base}.${i}.gz`;
    if ((await exists(plain)) || (await exists(gz))) {
      n = i;
      continue;
    }
    break;
  }
  return n;
}

/**
 * Streaming gzip of `src` → `dst`, then unlink `src`. Never loads the file
 * into memory; works for arbitrarily large JSONL shards.
 */
async function gzipInPlace(src: string, dst: string): Promise<void> {
  await pipeline(createReadStream(src), createGzip(), createWriteStream(dst));
  await unlink(src);
}

// ---------------------------------------------------------------------------
// openJsonl
// ---------------------------------------------------------------------------

export async function openJsonl(opts: OpenJsonlOptions): Promise<JsonlWriter> {
  const { sessionId, projectHash, paths } = opts;
  const rotateBytes = opts.rotateBytes ?? DEFAULT_ROTATE_BYTES;
  const logger: Logger = opts.logger ?? createLogger({ name: "session-jsonl" });

  const dir = paths.projectDir(projectHash);
  await mkdir(dir, { recursive: true });

  const filePath = paths.sessionLog(projectHash, sessionId);
  let handle = await open(filePath, "a");
  let bytesWritten = (await handle.stat()).size;
  let closed = false;

  // Serialise writes + rotations via a local promise chain.
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn);
    queue = next.catch(() => undefined);
    return next;
  }

  async function doWrite(event: AgentEvent): Promise<void> {
    if (closed) {
      throw new Error(`jsonl writer closed (session ${sessionId})`);
    }
    let line: string;
    try {
      line = `${JSON.stringify(event)}\n`;
    } catch (err) {
      logger.error(
        { err: (err as Error).message, sessionId },
        "jsonl: JSON.stringify failed (circular reference?)",
      );
      throw err;
    }
    await handle.appendFile(line);
    bytesWritten += Buffer.byteLength(line, "utf8");
  }

  async function doFlush(): Promise<void> {
    if (closed) return;
    try {
      await handle.sync();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // tmpfs / special filesystems reject fsync with EINVAL. Not fatal.
      if (code === "EINVAL") {
        logger.warn(
          { sessionId, path: filePath },
          "jsonl: fsync returned EINVAL (non-regular file); continuing",
        );
        return;
      }
      throw err;
    }
  }

  async function doRotate(): Promise<void> {
    if (closed) return;
    if (bytesWritten < rotateBytes) return;

    // Close the current handle so renames are safe on every platform.
    await handle.close();

    const base = filePath; // `<id>.jsonl`
    const highest = await highestSuffix(base);

    // 1. Shift gz suffixes downward first (from highest → 4) so we don't
    //    collide. For any N ≥ 3, rename `.N.gz` → `.(N+1).gz`, OR gzip a
    //    plain `.N` into `.(N+1).gz`.
    for (let n = highest; n >= 3; n--) {
      const plain = `${base}.${n}`;
      const gz = `${base}.${n}.gz`;
      const nextGz = `${base}.${n + 1}.gz`;
      if (await exists(gz)) {
        await rename(gz, nextGz);
      } else if (await exists(plain)) {
        await gzipInPlace(plain, nextGz);
      }
    }

    // 2. Rename `.2` → `.3` (still plain; next rotation gzips it).
    if (await exists(`${base}.2`)) {
      await rename(`${base}.2`, `${base}.3`);
    }
    // 3. Rename `.1` → `.2`.
    if (await exists(`${base}.1`)) {
      await rename(`${base}.1`, `${base}.2`);
    }
    // 4. Rename `<id>.jsonl` → `.1`.
    if (await exists(base)) {
      await rename(base, `${base}.1`);
    }

    // 5. Reopen fresh handle.
    handle = await open(filePath, "a");
    bytesWritten = 0;

    logger.info({ sessionId, path: filePath, rotateBytes }, "jsonl: rotated log");
  }

  async function doClose(): Promise<void> {
    if (closed) return;
    closed = true;
    await handle.close();
  }

  const writer: JsonlWriter = {
    sessionId,
    projectHash,
    path: filePath,
    write(event) {
      return enqueue(() => doWrite(event));
    },
    flushTurn() {
      return enqueue(() => doFlush());
    },
    maybeRotate() {
      return enqueue(() => doRotate());
    },
    close() {
      return enqueue(() => doClose());
    },
  };

  return writer;
}
