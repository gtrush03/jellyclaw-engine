/**
 * Bootstrap — spawn the opencode-ai binary as a headless HTTP server bound to
 * loopback, authenticated by a per-session minted password.
 *
 * This module is the runtime counterpart to CVE-MITIGATION §1 (CVE-2026-22812)
 * and SPEC §11 / §14. It enforces the hostname and port invariants that we
 * cannot enforce via a source patch, because `opencode-ai` on npm ships a
 * compiled standalone binary (see patches/README.md).
 *
 * Invariants enforced here (all violations exit the process or reject):
 *  - hostname is "127.0.0.1" — never 0.0.0.0, never localhost, never a LAN addr.
 *  - port lands in the IANA ephemeral range [49152, 65535].
 *  - opencode-ai version satisfies ">=1.4.4 <2" (CVE-22812 floor).
 *  - OPENCODE_SERVER_PASSWORD is 256 bits of randomness, never on argv,
 *    never written to disk by us.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class BindViolationError extends Error {
  constructor(observed: string) {
    super(
      `OpenCode bound to "${observed}" — jellyclaw refuses any non-loopback bind (CVE-22812). ` +
        `Exit code 3 per SPEC §19.`,
    );
    this.name = "BindViolationError";
  }
}

export class PortRangeError extends Error {
  constructor(port: number) {
    super(
      `OpenCode resolved port ${port} — outside the ephemeral range [49152, 65535] required by ` +
        `CVE-MITIGATION §1.3. Exit code 3.`,
    );
    this.name = "PortRangeError";
  }
}

export class OpenCodeVersionError extends Error {
  constructor(observed: string) {
    super(
      `opencode-ai version "${observed}" does not satisfy ">=1.4.4 <2" (CVE-22812 floor). ` +
        `Refusing to boot. Exit code 4, reason OPENCODE_VERSION_CVE_22812.`,
    );
    this.name = "OpenCodeVersionError";
  }
}

export class OpenCodeStartTimeoutError extends Error {
  constructor(ms: number, captured: string) {
    super(`opencode serve did not announce its port within ${ms}ms. Captured stdout:\n${captured}`);
    this.name = "OpenCodeStartTimeoutError";
  }
}

export class OpenCodeExitError extends Error {
  constructor(code: number | null, signal: NodeJS.Signals | null, stderr: string) {
    super(
      `opencode serve exited before announcing port (code=${code}, signal=${signal}). ` +
        `stderr:\n${stderr}`,
    );
    this.name = "OpenCodeExitError";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OpenCodeHandle {
  /** Full URL of the running server, always `http://127.0.0.1:<port>`. */
  readonly url: string;
  /** Host portion — kept separate for caller-side asserts. */
  readonly hostname: "127.0.0.1";
  /** Resolved listening port, always in [49152, 65535]. */
  readonly port: number;
  /** Basic-auth username. Fixed at "jellyclaw". */
  readonly username: "jellyclaw";
  /** Raw 64-char hex password (256 bits). */
  readonly password: string;
  /** Authorization header value: `Basic base64(username:password)`. */
  readonly authHeader: string;
  /** Spawned child's pid, for debugging only. */
  readonly pid: number;
  /** Resolved opencode-ai version (from its package.json). */
  readonly version: string;
  /** Terminate the child. Resolves when the process has exited. */
  kill(signal?: NodeJS.Signals): Promise<void>;
}

export interface StartOpenCodeOptions {
  /**
   * Port to request. `0` (default) asks the kernel for an ephemeral port; we still
   * assert it lands in [49152, 65535]. Any explicit non-zero value must already
   * be in that range or startup rejects.
   */
  port?: number;
  /** How long to wait for the "listening on http://..." stdout line. Default 15s. */
  timeoutMs?: number;
  /** Extra env for the spawned child. Merged over `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the child. Default: `process.cwd()`. */
  cwd?: string;
  /**
   * Override the binary invocation. Default: `[npxPath(), "opencode"]`.
   * Tests can inject a stub; production should never touch this.
   */
  command?: readonly [string, ...string[]];
}

const EPHEMERAL_MIN = 49152;
const EPHEMERAL_MAX = 65535;
const MIN_VERSION = "1.4.4";
const MAX_EXCLUSIVE_MAJOR = 2;
const DEFAULT_TIMEOUT_MS = 15_000;
const LOOPBACK: "127.0.0.1" = "127.0.0.1";

export async function startOpenCode(options: StartOpenCodeOptions = {}): Promise<OpenCodeHandle> {
  const version = resolveOpenCodeVersion();
  assertVersion(version);

  // CVE-MITIGATION §1.3 point 3 — draw from the ephemeral range ourselves rather
  // than relying on opencode's `--port 0` behavior, which actively falls back to
  // 4096 per packages/opencode/src/cli/network.ts@v1.4.5. We probe via a
  // throwaway listener on 127.0.0.1, release it, and hand the number to
  // opencode. There is a small TOCTOU window between close and spawn; we retry
  // once on EADDRINUSE at the caller level (opencode itself reports a clear
  // error and we surface it).
  const requestedPort =
    options.port && options.port !== 0 ? options.port : await pickEphemeralPort();
  if (!isEphemeral(requestedPort)) {
    throw new PortRangeError(requestedPort);
  }

  const password = randomBytes(32).toString("hex");
  const username = "jellyclaw" as const;
  const authHeader = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const [cmd, ...baseArgs] = options.command ?? (["npx", "opencode"] as const);
  const args = [...baseArgs, "serve", "--hostname", LOOPBACK, "--port", String(requestedPort)];

  const child = spawn(cmd, args, {
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...options.env,
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
  });

  const url = await waitForListening(
    child,
    () => stdoutBuf,
    () => stderrBuf,
    timeoutMs,
  );
  const port = parsePort(url);
  if (!isEphemeral(port)) {
    await hardKill(child);
    throw new PortRangeError(port);
  }
  const hostname = parseHostname(url);
  if (hostname !== LOOPBACK) {
    await hardKill(child);
    throw new BindViolationError(hostname);
  }

  return {
    url: `http://${LOOPBACK}:${port}`,
    hostname: LOOPBACK,
    port,
    username,
    password,
    authHeader,
    pid: child.pid ?? -1,
    version,
    async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
      await gracefulKill(child, signal);
    },
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function resolveOpenCodeVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require("opencode-ai/package.json") as { version?: unknown };
  const v = typeof pkg.version === "string" ? pkg.version : "unknown";
  return v;
}

function assertVersion(v: string): void {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new OpenCodeVersionError(v);
  const [, majS, minS, patS] = m;
  const major = Number(majS);
  const minor = Number(minS);
  const patch = Number(patS);
  const [minMaj, minMin, minPat] = MIN_VERSION.split(".").map(Number) as [number, number, number];
  const atLeast =
    major > minMaj ||
    (major === minMaj && minor > minMin) ||
    (major === minMaj && minor === minMin && patch >= minPat);
  if (!atLeast || major >= MAX_EXCLUSIVE_MAJOR) throw new OpenCodeVersionError(v);
}

function isEphemeral(p: number): boolean {
  return Number.isInteger(p) && p >= EPHEMERAL_MIN && p <= EPHEMERAL_MAX;
}

function pickEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, LOOPBACK, () => {
      const addr = srv.address();
      if (!addr || typeof addr === "string") {
        srv.close();
        reject(new Error("ephemeral-port probe returned no address"));
        return;
      }
      const port = addr.port;
      srv.close(() => {
        if (!isEphemeral(port)) {
          reject(new PortRangeError(port));
          return;
        }
        resolve(port);
      });
    });
  });
}

function parsePort(url: string): number {
  const m = url.match(/:(\d+)(?:\/|$)/);
  if (!m?.[1]) throw new BindViolationError(url);
  return Number(m[1]);
}

function parseHostname(url: string): string {
  const m = url.match(/^https?:\/\/([^:/]+)/);
  if (!m?.[1]) throw new BindViolationError(url);
  return m[1];
}

const LISTENING_RE =
  /opencode server listening on (https?:\/\/(?:\d+\.\d+\.\d+\.\d+|\[[^\]]+\]|[a-zA-Z0-9.-]+):\d+)/;

async function waitForListening(
  child: ChildProcess,
  getStdout: () => string,
  getStderr: () => string,
  timeoutMs: number,
): Promise<string> {
  const started = Date.now();
  let exitReason: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exitReason = { code, signal };
  };
  child.once("exit", onExit);

  try {
    for (;;) {
      const m = getStdout().match(LISTENING_RE);
      if (m?.[1]) return m[1];
      if (exitReason) {
        throw new OpenCodeExitError(exitReason.code, exitReason.signal, getStderr());
      }
      if (Date.now() - started > timeoutMs) {
        await hardKill(child);
        throw new OpenCodeStartTimeoutError(timeoutMs, getStdout());
      }
      await delay(50);
    }
  } finally {
    child.removeListener("exit", onExit);
  }
}

async function gracefulKill(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  const exited = await Promise.race([
    new Promise<true>((resolve) => child.once("exit", () => resolve(true))),
    delay(5_000).then(() => false as const),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
}

async function hardKill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
