// jellyclaw-driver.mjs — spawn `jellyclaw run/serve` and scrape its stream.
//
// Two shapes of invocation are supported today:
//
//   runCommand({ command, waitForStderr, timeoutSec })
//     - Spawns an arbitrary shell command.
//     - Polls stderr for a regex/substring. As soon as we see it, we consider
//       the test passed. We then kill the process.
//     - Used for kind: jellyclaw-run.
//
//   shellCommand({ command, expectExit, expectStdout, timeoutSec })
//     - One-shot execution. Asserts exit code and optional stdout substring.
//     - Used for kind: shell.
//
// Both return { passed, duration_ms, output, error } objects so the tester
// can slot them directly into test-results.json.

import { execa } from "execa";
import { setTimeout as sleep } from "node:timers/promises";

export async function shellCommand({
  command,
  expectExit = 0,
  expectStdout,
  timeoutSec = 30,
  cwd,
  env,
}) {
  const started = Date.now();
  try {
    const result = await execa(command, {
      shell: true,
      timeout: timeoutSec * 1000,
      cwd,
      env: { ...process.env, ...(env || {}) },
      reject: false,
    });
    const duration_ms = Date.now() - started;
    const exitMatches = result.exitCode === expectExit;
    const stdoutMatches = expectStdout
      ? (result.stdout || "").includes(expectStdout)
      : true;
    const passed = exitMatches && stdoutMatches;
    return {
      passed,
      duration_ms,
      output: truncate(result.stdout || ""),
      error: passed
        ? null
        : `exit=${result.exitCode} (expected ${expectExit}); stdoutOk=${stdoutMatches}`,
    };
  } catch (err) {
    return {
      passed: false,
      duration_ms: Date.now() - started,
      output: null,
      error: err.message || String(err),
    };
  }
}

export async function runCommand({
  command,
  waitForStderr,
  timeoutSec = 10,
  cwd,
  env,
}) {
  const started = Date.now();
  const child = execa(command, {
    shell: true,
    cwd,
    env: { ...process.env, ...(env || {}) },
    reject: false,
    stripFinalNewline: false,
  });

  let stderrBuf = "";
  let matched = false;
  const onStderr = (chunk) => {
    stderrBuf += chunk.toString("utf8");
    if (waitForStderr && stderrBuf.includes(waitForStderr)) matched = true;
  };
  child.stderr?.on("data", onStderr);

  const deadline = started + timeoutSec * 1000;
  try {
    while (!matched && Date.now() < deadline && child.exitCode === null) {
      await sleep(50);
    }
    if (!matched) {
      // Timed out. Kill the child.
      child.kill("SIGTERM");
      await sleep(200);
      if (child.exitCode === null) child.kill("SIGKILL");
      return {
        passed: false,
        duration_ms: Date.now() - started,
        output: truncate(stderrBuf),
        error: `did not see waitForStderr="${waitForStderr}" within ${timeoutSec}s`,
      };
    }
    // Matched. Kill the child gracefully.
    child.kill("SIGTERM");
    await sleep(150);
    if (child.exitCode === null) child.kill("SIGKILL");
    return {
      passed: true,
      duration_ms: Date.now() - started,
      output: truncate(stderrBuf),
      error: null,
    };
  } catch (err) {
    try {
      child.kill("SIGKILL");
    } catch {}
    return {
      passed: false,
      duration_ms: Date.now() - started,
      output: truncate(stderrBuf),
      error: err.message || String(err),
    };
  }
}

function truncate(s, max = 8000) {
  if (!s) return s;
  return s.length <= max ? s : `${s.slice(0, max)}\n…(${s.length - max} bytes elided)`;
}
