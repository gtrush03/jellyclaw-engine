// tester.mjs — run the acceptance tests declared in a prompt's frontmatter.
//
// Inputs:
//   - sessionDir: absolute path to .autobuild/sessions/<sid>/
//   - prompt:     the parsed prompt object (prompt-parser.mjs output)
//   - opts.cwd:   repo root where tests execute
//
// Each test has a `kind`:
//   - shell           → run a command, check exit code + optional stdout
//   - jellyclaw-run   → spawn a long-running command, poll stderr for a token,
//                       then kill
//   - smoke-suite     → spawn `node engine/test/smoke/run-smoke.mjs` (if it
//                       exists — in this repo smoke tests are vitest TS so we
//                       fall back to `bun run test`-style shell)
//   - http-roundtrip  → launch jellyclaw serve on port 0, curl /v1/health, kill
//
// We write test-results.json alongside the session and return the overall
// verdict so the dispatcher can transition the run to passed/failed.

import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { shellCommand, runCommand } from "./lib/jellyclaw-driver.mjs";
import { setTimeout as sleep } from "node:timers/promises";
import { createServer } from "node:net";

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function runShellTest(test, opts) {
  return shellCommand({
    command: test.command,
    expectExit: test.expect_exit ?? 0,
    expectStdout: test.expect_stdout,
    timeoutSec: test.timeout_sec ?? 30,
    cwd: opts.cwd,
    env: test.env,
  });
}

async function runJellyclawRunTest(test, opts) {
  return runCommand({
    command: test.command,
    waitForStderr: test.wait_for_stderr,
    timeoutSec: test.timeout_sec ?? 15,
    cwd: opts.cwd,
    env: test.env,
  });
}

async function runSmokeSuiteTest(test, opts) {
  const nodeScript = join(opts.cwd, "engine", "test", "smoke", "run-smoke.mjs");
  const cmd = existsSync(nodeScript) ? `node ${JSON.stringify(nodeScript)}` : "bun run test";
  return shellCommand({
    command: cmd,
    expectExit: 0,
    timeoutSec: test.timeout_sec ?? 300,
    cwd: opts.cwd,
  });
}

async function runHttpRoundtripTest(test, opts) {
  const port = await pickFreePort();
  const started = Date.now();
  const serveCmd = test.command
    ? test.command.replace(/\$\{PORT\}/g, String(port))
    : `node engine/bin/jellyclaw-serve --port ${port}`;
  const child = execa(serveCmd, {
    shell: true,
    cwd: opts.cwd,
    env: { ...process.env, ...(test.env || {}) },
    reject: false,
  });
  try {
    // Wait for server to come up.
    const url = test.url || `http://127.0.0.1:${port}/v1/health`;
    const deadline = started + (test.timeout_sec ?? 15) * 1000;
    let lastErr = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (res.ok || (test.accept_non_200 && res.status < 500)) {
          return {
            passed: true,
            duration_ms: Date.now() - started,
            output: `HTTP ${res.status}`,
            error: null,
          };
        }
        lastErr = `status=${res.status}`;
      } catch (err) {
        lastErr = err.message;
      }
      await sleep(200);
    }
    return {
      passed: false,
      duration_ms: Date.now() - started,
      output: null,
      error: `no healthy response from ${url}: ${lastErr || "?"}`,
    };
  } finally {
    try {
      child.kill("SIGTERM");
      await sleep(200);
      if (child.exitCode === null) child.kill("SIGKILL");
    } catch {}
  }
}

const HANDLERS = {
  shell: runShellTest,
  "jellyclaw-run": runJellyclawRunTest,
  "smoke-suite": runSmokeSuiteTest,
  "http-roundtrip": runHttpRoundtripTest,
};

export async function runTests(prompt, { sessionDir, cwd }) {
  const results = [];
  for (const test of prompt.tests) {
    const handler = HANDLERS[test.kind];
    if (!handler) {
      results.push({
        name: test.name || "(unnamed)",
        kind: test.kind,
        passed: false,
        duration_ms: 0,
        output: null,
        error: `unknown test kind: ${test.kind}`,
      });
      continue;
    }
    const verdict = await handler(test, { cwd });
    results.push({
      name: test.name || "(unnamed)",
      kind: test.kind,
      passed: verdict.passed,
      duration_ms: verdict.duration_ms,
      output: verdict.output,
      error: verdict.error,
    });
  }
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const summary = { total, passed, failed, pending: 0, by_test: results };
  writeFileSync(join(sessionDir, "test-results.json"), JSON.stringify(summary, null, 2));
  return { overall: failed === 0, summary };
}
