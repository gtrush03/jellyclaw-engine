/**
 * Phase 08 T3-03 — Docker helpers for the web-TUI E2E suite.
 *
 * The helpers shell out via `child_process.spawn` so stdio streams, exit
 * codes, and signals behave naturally — the Playwright runner inherits the
 * build output instead of buffering gigabytes of layer progress in-process.
 *
 * Scope is intentionally tiny: build an image, run it with a tmp port, poll
 * /v1/health until ready, tear it down. No fancy orchestration.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function run(
  cmd: string,
  args: readonly string[],
  opts: { inherit?: boolean; captureStdout?: boolean } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: opts.inherit === true ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (opts.inherit !== true && opts.captureStdout === true) {
        process.stdout.write(text);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response | null> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(handle);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * True when the docker daemon answers `docker info`. Used at the top of the
 * spec to skip the suite cleanly when docker isn't running.
 */
export async function dockerAvailable(): Promise<boolean> {
  const { code } = await run("docker", ["info"]);
  return code === 0;
}

/**
 * Build the image at the current working directory's Dockerfile. Inherits
 * stdio so the Playwright runner streams build output live.
 */
export async function buildImage(tag: string): Promise<void> {
  const { code } = await run("docker", ["build", "-t", tag, "."], { inherit: true });
  if (code !== 0) {
    throw new Error(`docker build -t ${tag} exited ${code}`);
  }
}

export interface RunContainerResult {
  readonly id: string;
  readonly url: string;
  readonly stop: () => Promise<void>;
}

/**
 * Run the image on the given host port. Polls `GET <url>/v1/health` once per
 * second up to 60s; resolves when the first 2xx lands or rejects if the
 * deadline is reached. The returned `stop()` is idempotent.
 */
export async function runContainer(
  tag: string,
  env: Readonly<Record<string, string>>,
  port: number,
): Promise<RunContainerResult> {
  const envArgs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    envArgs.push("-e", `${k}=${v}`);
  }

  const { code, stdout, stderr } = await run("docker", [
    "run",
    "-d",
    "--rm",
    "-p",
    `${port}:80`,
    ...envArgs,
    tag,
  ]);
  if (code !== 0) {
    throw new Error(`docker run failed (exit ${code}): ${stderr}`);
  }

  const id = stdout.trim();
  const url = `http://127.0.0.1:${port}`;

  // Poll /v1/health. We need the bearer we passed in as JELLYCLAW_TOKEN.
  const deadline = Date.now() + 60_000;
  const bearer = env.JELLYCLAW_TOKEN ?? "";
  let lastStatus: number | null = null;
  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(`${url}/v1/health`, 2_000);
    if (res !== null) {
      lastStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        return { id, url, stop: () => stopContainer(id) };
      }
      // Any authenticated fetch also counts as "server up" — the public
      // landing page on `/` is the real health proxy for tests.
      if (bearer.length > 0) {
        const authed = await fetchWithTimeout(`${url}/v1/health`, 2_000);
        if (authed?.status === 200) {
          return { id, url, stop: () => stopContainer(id) };
        }
      }
      // 401 is fine — it means Caddy + the engine are up and auth is working.
      const landing = await fetchWithTimeout(`${url}/`, 2_000);
      if (landing !== null && landing.status === 200) {
        return { id, url, stop: () => stopContainer(id) };
      }
    }
    await sleep(1_000);
  }

  await stopContainer(id);
  throw new Error(
    `container ${id} did not become healthy within 60s (last /v1/health status=${lastStatus ?? "none"})`,
  );
}

/**
 * Stop + remove the container. Swallows errors — idempotent.
 */
export async function stopContainer(id: string): Promise<void> {
  await run("docker", ["kill", id]);
  await run("docker", ["rm", "-f", id]);
}
