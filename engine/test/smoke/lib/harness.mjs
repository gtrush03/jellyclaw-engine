/**
 * Smoke-suite harness.
 *
 * Shared utilities for spawning `jellyclaw serve`, issuing HTTP requests, and
 * consuming SSE streams. Node stdlib + undici only — no new deps.
 *
 * Public exports:
 *   - readApiKey()
 *   - spawnServer({port, token, envOverrides})
 *   - createRun(baseUrl, token, body)
 *   - streamRunEvents(baseUrl, token, runId, onEvent, {timeoutMs})
 *   - withServer(fn)
 *   - assert(cond, msg)
 *   - freePort()
 *   - repoRoot(), cliJs(), serveBin()
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { fetch } from "undici";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Absolute path to the jellyclaw-engine repo root. */
export function repoRoot() {
  // engine/test/smoke/lib/harness.mjs → ../../../..
  return resolve(__dirname, "..", "..", "..", "..");
}

/** Absolute path to engine/dist/cli/main.js. */
export function cliJs() {
  return resolve(repoRoot(), "engine", "dist", "cli", "main.js");
}

/** Absolute path to engine/bin/jellyclaw-serve (node shim). */
export function serveBin() {
  return resolve(repoRoot(), "engine", "bin", "jellyclaw-serve");
}

/** Absolute path to engine/bin/jellyclaw (bun shim). */
export function cliBin() {
  return resolve(repoRoot(), "engine", "bin", "jellyclaw");
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

export class SmokeAssertError extends Error {
  constructor(label, details) {
    super(`${label}${details ? `: ${details}` : ""}`);
    this.name = "SmokeAssertError";
    this.label = label;
  }
}

export function assert(cond, msg, details) {
  if (!cond) throw new SmokeAssertError(msg, details);
}

// ---------------------------------------------------------------------------
// API key resolution
// ---------------------------------------------------------------------------

/**
 * Read ANTHROPIC_API_KEY. Precedence:
 *   1. process.env.ANTHROPIC_API_KEY
 *   2. JELLYCLAW_CREDENTIALS_PATH env override
 *   3. ~/.jellyclaw/credentials.json  (field: anthropicApiKey)
 *
 * Returns the raw key string or throws with a clear message.
 */
export function readApiKey() {
  const env = process.env.ANTHROPIC_API_KEY;
  if (typeof env === "string" && env.length > 0) return env;

  const override = process.env.JELLYCLAW_CREDENTIALS_PATH;
  const credsPath =
    typeof override === "string" && override.length > 0
      ? override
      : resolve(homedir(), ".jellyclaw", "credentials.json");

  if (!existsSync(credsPath)) {
    throw new Error(
      `readApiKey: ANTHROPIC_API_KEY not set and ${credsPath} does not exist. ` +
        `Run \`jellyclaw key\` to seed it, or export ANTHROPIC_API_KEY.`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(credsPath, "utf8"));
  } catch (err) {
    throw new Error(`readApiKey: failed to parse ${credsPath}: ${err?.message ?? err}`);
  }
  const key = parsed?.anthropicApiKey;
  if (typeof key !== "string" || key.length < 10) {
    throw new Error(
      `readApiKey: ${credsPath} has no valid anthropicApiKey field (need string length ≥ 10).`,
    );
  }
  return key;
}

// ---------------------------------------------------------------------------
// Free port allocation
// ---------------------------------------------------------------------------

/**
 * Ask the OS for an ephemeral free port. Not race-free (the port can be
 * stolen between release and `jellyclaw serve --port`) but the window is
 * small enough for smoke testing.
 */
export function freePort() {
  return new Promise((resolveP, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr !== "object" || addr === null) {
        srv.close();
        reject(new Error("freePort: unexpected address shape"));
        return;
      }
      const p = addr.port;
      srv.close(() => resolveP(p));
    });
  });
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Spawn `node engine/dist/cli/main.js serve --port <port> --auth-token <tok>`.
 * Waits up to 5s for "listening on" to appear on stderr, then resolves.
 *
 * Returns { proc, port, token, baseUrl, teardown, stderrBuf }.
 * `teardown()` is idempotent and always resolves.
 */
export async function spawnServer({ port, token, envOverrides = {}, timeoutMs = 5000 } = {}) {
  const chosenPort = port ?? (await freePort());
  const chosenToken = token ?? `smoke-${process.pid}-${Date.now().toString(36)}`;
  const apiKey = readApiKey();

  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: apiKey,
    // Silence Bun warning path; we are explicitly using node.
    NODE_ENV: "test",
    ...envOverrides,
  };

  const proc = spawn(
    process.execPath, // node
    [
      cliJs(),
      "serve",
      "--port",
      String(chosenPort),
      "--host",
      "127.0.0.1",
      "--auth-token",
      chosenToken,
    ],
    {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  let stderrBuf = "";
  let stdoutBuf = "";
  proc.stderr.on("data", (c) => {
    stderrBuf += c.toString("utf8");
  });
  proc.stdout.on("data", (c) => {
    stdoutBuf += c.toString("utf8");
  });

  const baseUrl = `http://127.0.0.1:${chosenPort}`;

  let torn = false;
  const teardown = async () => {
    if (torn) return;
    torn = true;
    try {
      if (!proc.killed) proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    // Wait up to 3s for graceful exit; then SIGKILL.
    await new Promise((r) => {
      const t = setTimeout(() => {
        try {
          if (!proc.killed) proc.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        r();
      }, 3000);
      proc.once("exit", () => {
        clearTimeout(t);
        r();
      });
    });
  };

  // Wait for "listening on" or early exit.
  try {
    await new Promise((resolveP, rejectP) => {
      const timer = setTimeout(() => {
        rejectP(
          new Error(
            `spawnServer: timed out after ${timeoutMs}ms waiting for "listening on". ` +
              `stderr so far:\n${stderrBuf.slice(-2000)}`,
          ),
        );
      }, timeoutMs);

      const checkReady = () => {
        if (stderrBuf.includes("listening on") || stdoutBuf.includes("listening on")) {
          clearTimeout(timer);
          resolveP();
        }
      };

      proc.stderr.on("data", checkReady);
      proc.stdout.on("data", checkReady);
      proc.once("exit", (code, signal) => {
        clearTimeout(timer);
        rejectP(
          new Error(
            `spawnServer: process exited before ready (code=${code}, signal=${signal}). ` +
              `stderr:\n${stderrBuf.slice(-2000)}\nstdout:\n${stdoutBuf.slice(-1000)}`,
          ),
        );
      });

      // Also check immediately in case buffers already hold "listening on".
      checkReady();
    });
  } catch (err) {
    await teardown();
    throw err;
  }

  return {
    proc,
    port: chosenPort,
    token: chosenToken,
    baseUrl,
    teardown,
    get stderr() {
      return stderrBuf;
    },
    get stdout() {
      return stdoutBuf;
    },
  };
}

/**
 * Scope a function with a live server. Always tears down, even on throw.
 */
export async function withServer(fn, opts) {
  const srv = await spawnServer(opts);
  try {
    return await fn(srv);
  } finally {
    await srv.teardown();
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * POST /v1/runs. Returns { runId, sessionId } on 201.
 * Throws with the HTTP status + body otherwise.
 */
export async function createRun(baseUrl, token, body) {
  const res = await fetch(`${baseUrl}/v1/runs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status !== 201) {
    throw new Error(`createRun: expected 201, got ${res.status}. body=${text}`);
  }
  const parsed = JSON.parse(text);
  return { runId: parsed.runId, sessionId: parsed.sessionId };
}

// ---------------------------------------------------------------------------
// SSE consumer
// ---------------------------------------------------------------------------

/**
 * Stream `/v1/runs/:id/events` until the server emits `event: done` or the
 * timeout fires. Invokes `onEvent(name, data)` for each frame — `name` is
 * the SSE `event:` field ("event" or "done"), `data` is the parsed JSON.
 *
 * Resolves with { events: [...], kindCounts: Record<string, number> } where
 * events is the ordered list of AgentEvent objects (the "event" frames) plus
 * the terminal done payload tagged with type="__done__".
 */
export async function streamRunEvents(
  baseUrl,
  token,
  runId,
  onEvent,
  { timeoutMs = 120_000 } = {},
) {
  const ac = new AbortController();
  const timer = setTimeout(
    () => ac.abort(new Error(`streamRunEvents: timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );

  let res;
  try {
    res = await fetch(`${baseUrl}/v1/runs/${runId}/events`, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
      },
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
  if (res.status !== 200) {
    clearTimeout(timer);
    const body = await res.text().catch(() => "");
    throw new Error(`streamRunEvents: expected 200, got ${res.status}. body=${body}`);
  }
  if (!res.body) {
    clearTimeout(timer);
    throw new Error("streamRunEvents: missing response body");
  }

  const events = [];
  const kindCounts = Object.create(null);
  const bump = (k) => {
    kindCounts[k] = (kindCounts[k] ?? 0) + 1;
  };

  let buf = "";
  let pendingEvent = "message";
  let pendingData = "";

  const dispatch = () => {
    if (pendingData.length === 0) return;
    let parsed;
    try {
      parsed = JSON.parse(pendingData);
    } catch {
      pendingEvent = "message";
      pendingData = "";
      return;
    }
    const name = pendingEvent;
    if (name === "done") {
      const entry = { ...parsed, type: "__done__" };
      events.push(entry);
      bump("__done__");
      try {
        onEvent?.("done", parsed);
      } catch {
        /* onEvent must not break the pump */
      }
    } else {
      events.push(parsed);
      if (typeof parsed?.type === "string") bump(parsed.type);
      try {
        onEvent?.(name, parsed);
      } catch {
        /* ignore */
      }
    }
    pendingEvent = "message";
    pendingData = "";
  };

  try {
    for await (const chunk of res.body) {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      // Process any complete frames (separated by blank line).
      while (true) {
        const idx = buf.indexOf("\n\n");
        const altIdx = buf.indexOf("\r\n\r\n");
        const sepIdx = idx === -1 ? altIdx : altIdx === -1 ? idx : Math.min(idx, altIdx);
        if (sepIdx === -1) break;
        const frame = buf.slice(0, sepIdx);
        buf = buf.slice(sepIdx + (buf[sepIdx] === "\r" ? 4 : 2));

        pendingEvent = "message";
        pendingData = "";
        for (const rawLine of frame.split(/\r?\n/)) {
          if (rawLine.length === 0 || rawLine.startsWith(":")) continue;
          const colon = rawLine.indexOf(":");
          const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
          let value = colon === -1 ? "" : rawLine.slice(colon + 1);
          if (value.startsWith(" ")) value = value.slice(1);
          if (field === "event") pendingEvent = value;
          else if (field === "data") pendingData += (pendingData.length > 0 ? "\n" : "") + value;
          // ignore id:, retry:, unknown fields
        }
        dispatch();

        // Short-circuit on terminal frame.
        if (kindCounts.__done__ > 0) {
          clearTimeout(timer);
          try {
            ac.abort();
          } catch {
            /* ignore */
          }
          return { events, kindCounts };
        }
      }
    }
  } catch (err) {
    clearTimeout(timer);
    if (ac.signal.aborted && kindCounts.__done__ > 0) {
      return { events, kindCounts };
    }
    throw err;
  }

  clearTimeout(timer);
  return { events, kindCounts };
}

// ---------------------------------------------------------------------------
// Convenience: extract the highest input_tokens seen across usage.updated.
// ---------------------------------------------------------------------------

export function maxInputTokens(events) {
  let max = 0;
  for (const ev of events) {
    if (ev?.type === "usage.updated" && typeof ev.input_tokens === "number") {
      if (ev.input_tokens > max) max = ev.input_tokens;
    }
  }
  return max;
}
