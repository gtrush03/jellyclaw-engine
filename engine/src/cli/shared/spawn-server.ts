/**
 * Phase 10.5 Prompt 03 — embedded-server spawn helper.
 *
 * `spawnEmbeddedServer` forks a child `node dist/cli/main.js serve` on a free
 * port with a freshly-minted bearer token, pipes its stdout/stderr through the
 * engine logger, and returns a handle the TUI CLI can teardown cleanly. The
 * child is a real `jellyclaw serve` process — we do not in-process-import the
 * server factory here because the TUI deliberately owns a separate listener
 * that dies with the TUI (see `prompts/phase-10.5/03-tui-command.md`, "Common
 * pitfalls → Double-spawning the engine server").
 *
 * `waitForHealth` polls `GET /v1/health` (unauthenticated probe is fine — the
 * server exposes `/healthz` / `/v1/health` at status-only level) and throws
 * `TuiHealthTimeoutError` when the embedded server doesn't come up in time.
 *
 * This module MUST NOT call `process.exit`; per CLAUDE.md only `cli/main.ts`
 * may do that. All error paths throw typed errors instead.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { execaNode } from "execa";

import type { Logger } from "../../logger.js";
import { logger as defaultLogger } from "../../logger.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EmbeddedServerHandle {
  /** Base URL of the embedded server, e.g. `http://127.0.0.1:54321`. */
  readonly baseUrl: string;
  /** In-memory bearer token (never written to logs or disk). */
  readonly token: string;
  /** Idempotent shutdown: kills the child and awaits its exit. */
  readonly stop: () => Promise<void>;
}

export interface SpawnEmbeddedServerOptions {
  readonly cwd?: string;
  readonly port?: number;
  readonly token?: string;
  readonly verbose?: boolean;
  readonly logger?: Logger;
}

export class TuiHealthTimeoutError extends Error {
  override readonly name = "TuiHealthTimeoutError";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Small sleep helper used by `waitForHealth`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Resolve the path to the built CLI entry. At runtime this module is loaded
 * from `dist/cli/shared/spawn-server.js`, so `../../main.js` is the sibling
 * CLI entry. In tests (pre-build) we fall back to the TS entry point via the
 * vitest resolver — callers can override by passing `cliEntry` if needed.
 */
function resolveCliEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // tsup bundles spawn-server into cli/main.js (no code-splitting), so at
  // runtime `import.meta.url` points at dist/cli/main.js and main.js sits in
  // the same directory. In unbundled (vitest / ts-node) runs, spawn-server
  // lives at cli/shared/spawn-server.ts so main.js sits one level up.
  const bundled = resolve(here, "main.js");
  const unbundled = resolve(here, "..", "main.js");
  return existsSync(bundled) ? bundled : unbundled;
}

/** Find a free TCP port by asking the OS for one. */
async function pickFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return await new Promise<number>((resolvePromise, rejectPromise) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectPromise);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address === null || typeof address === "string") {
        srv.close();
        rejectPromise(new Error("failed to assign a free port"));
        return;
      }
      const { port } = address;
      srv.close((closeErr) => {
        if (closeErr) {
          rejectPromise(closeErr);
          return;
        }
        resolvePromise(port);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// spawnEmbeddedServer
// ---------------------------------------------------------------------------

export async function spawnEmbeddedServer(
  opts: SpawnEmbeddedServerOptions = {},
): Promise<EmbeddedServerHandle> {
  const log = (opts.logger ?? defaultLogger).child({ component: "tui-spawn-server" });
  const port = opts.port ?? (await pickFreePort());
  const token = opts.token ?? randomBytes(32).toString("hex");
  const cliEntry = resolveCliEntry();

  const args: string[] = [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--auth-token",
    token,
  ];
  if (opts.verbose === true) args.push("--verbose");

  // Run via execaNode — a forked node child with the CLI entry. stdio is piped
  // so we can shuttle logs through pino without leaking the bearer token onto
  // the parent's stdout.
  // Force node even when parent is bun · bun has SSE+chunked-encoding bug.
  // Also clear nodeOptions — execa defaults to process.execArgv which under
  // bun contains bun-specific flags that node(1) rejects with "bad option".
  const child = execaNode(cliEntry, args, {
    nodePath: "node",
    nodeOptions: [],
    cwd: opts.cwd ?? process.cwd(),
    env: {
      ...process.env,
      // Explicit token channels; the child's resolveAuthToken will pick up
      // --auth-token first, but we set these so other code paths (e.g. a
      // future `--use-env`) are consistent.
      OPENCODE_SERVER_PASSWORD: token,
    },
    stdio: ["ignore", "pipe", "pipe"],
    reject: false,
  });

  // Pipe the child's stdout/stderr into the structured logger. Line-buffered.
  const pipe = (stream: NodeJS.ReadableStream | null, level: "info" | "error"): void => {
    if (stream === null) return;
    stream.setEncoding("utf8");
    let buf = "";
    stream.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length === 0) continue;
        if (level === "error") log.error({ line }, "embedded-server stderr");
        else log.info({ line }, "embedded-server stdout");
      }
    });
  };
  pipe(child.stdout, "info");
  pipe(child.stderr, "error");

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    try {
      await child;
    } catch {
      // `reject: false` means execa resolves even on non-zero exit. Swallow
      // anything left (kill-induced signal, race with child already dead).
    }
  };

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    token,
    stop,
  };
}

// ---------------------------------------------------------------------------
// waitForHealth
// ---------------------------------------------------------------------------

export async function waitForHealth(
  baseUrl: string,
  tokenOrTimeout?: string | number,
  maybeTimeoutMs?: number,
): Promise<void> {
  // Backwards-compat overload: (baseUrl, timeoutMs) still works for tests.
  const token = typeof tokenOrTimeout === "string" ? tokenOrTimeout : undefined;
  const timeoutMs =
    typeof tokenOrTimeout === "number"
      ? tokenOrTimeout
      : typeof maybeTimeoutMs === "number"
        ? maybeTimeoutMs
        : 15_000;

  const deadline = Date.now() + timeoutMs;
  const headers: Record<string, string> = {};
  if (token !== undefined && token.length > 0) headers.Authorization = `Bearer ${token}`;

  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/v1/health`, { headers });
      if (res.status === 200) return;
      lastErr = new Error(`/v1/health returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await sleep(100);
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new TuiHealthTimeoutError(
    `embedded server did not become ready within ${timeoutMs}ms: ${detail}`,
  );
}
