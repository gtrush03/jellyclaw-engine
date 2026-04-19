/**
 * Phase 07.5 T4-01 — Chrome auto-lifecycle.
 *
 * For MCP configs with local CDP endpoints, ensures Chrome is running and
 * has at least one tab before the MCP registry starts. This prevents:
 * 1. User forgetting to start Chrome manually
 * 2. Prior Chrome process having died
 * 3. Chrome running but with zero active tabs (Playwright attach fails)
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { Logger } from "../logger.js";
import type { McpServerConfig } from "../mcp/types.js";

const CDP_ARG_RE = /^--cdp-endpoint$/i;
const CDP_URL_RE = /^https?:\/\/127\.0\.0\.1:(\d+)/;

/**
 * For each MCP config with a local CDP endpoint, ensure Chrome is running and
 * has at least one tab. Mutations: none — this is a pre-hook that spawns Chrome
 * as a detached process and returns once CDP is responsive.
 *
 * No-op if the port is already serving /json/version AND has >=1 page tab.
 */
export async function ensureChromeRunning(
  configs: readonly McpServerConfig[],
  logger: Logger,
): Promise<void> {
  const ports = extractLocalCdpPorts(configs);
  for (const port of ports) {
    await ensurePort(port, logger);
  }
}

/**
 * Extract all local CDP ports (127.0.0.1 only) from MCP configs.
 * Remote endpoints are ignored — we only auto-launch local Chrome.
 */
export function extractLocalCdpPorts(configs: readonly McpServerConfig[]): Set<number> {
  const ports = new Set<number>();
  for (const cfg of configs) {
    if (cfg.transport !== "stdio") continue;
    const args = cfg.args ?? [];
    for (let i = 0; i < args.length; i++) {
      if (CDP_ARG_RE.test(args[i] ?? "")) {
        const next = args[i + 1] ?? "";
        const m = CDP_URL_RE.exec(next);
        if (m) ports.add(Number(m[1]));
      }
    }
  }
  return ports;
}

async function ensurePort(port: number, logger: Logger): Promise<void> {
  const shallow = await probeCdp(port);
  const deep = shallow ? await deepProbe(port) : false;

  if (shallow && !deep) {
    logger.warn(
      { port },
      `chrome: port ${port} responds HTTP but CDP is hung — killing and relaunching`,
    );
    await killChrome(port);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!shallow || !deep) {
    logger.info({ port }, `chrome: launching via scripts/jellyclaw-chrome.sh`);
    launchChrome(port);
    await waitForCdp(port, 15_000);
  }
  // Ensure at least one page tab
  const tabCount = await countPageTabs(port);
  if (tabCount === 0) {
    logger.info({ port }, `chrome: no page tabs on :${port} — opening about:blank`);
    await openBlankTab(port);
  }
  // Bring Chrome window to foreground (macOS only)
  if (process.platform === "darwin") {
    try {
      const c = spawn("osascript", ["-e", 'tell application "Google Chrome" to activate'], {
        stdio: "ignore",
        detached: true,
      });
      c.unref();
    } catch {
      // Automation permission may be denied; non-fatal
    }
  }
  logger.info({ port, tabs: await countPageTabs(port) }, `chrome: ready on :${port}`);
}

/**
 * Deep health check — sends a real CDP command via WebSocket.
 * Returns false if Chrome's CDP is hung / not responding to commands.
 */
export async function deepProbe(port: number): Promise<boolean> {
  let wsUrl: string | undefined;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 1000);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    wsUrl = (await res.json() as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
  } catch {
    return false;
  }
  if (!wsUrl) return false;
  return new Promise<boolean>((resolvePromise) => {
    const ws = new WebSocket(wsUrl as string);
    const timeout = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolvePromise(false); }, 3000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      clearTimeout(timeout);
      try {
        const msg = JSON.parse(String(ev.data)) as { id: number; error?: unknown };
        ws.close();
        resolvePromise(msg.id === 1 && !msg.error);
      } catch {
        resolvePromise(false);
      }
    });
    ws.addEventListener("error", () => { clearTimeout(timeout); resolvePromise(false); });
  });
}

/**
 * Kill Chrome via scripts/jellyclaw-chrome-stop.sh.
 */
async function killChrome(port: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    const scriptPath = resolve(process.cwd(), "scripts/jellyclaw-chrome-stop.sh");
    const child = spawn("bash", [scriptPath], {
      env: { ...process.env, JELLYCLAW_CHROME_PORT: String(port) },
      stdio: "ignore",
    });
    const t = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolvePromise(); }, 7000);
    child.on("close", () => { clearTimeout(t); resolvePromise(); });
  });
}

/**
 * Probe /json/version, return true if 200.
 */
export async function probeCdp(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 500);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Count tabs where type === "page".
 */
export async function countPageTabs(port: number): Promise<number> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 500);
    const res = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) return 0;
    const tabs = (await res.json()) as Array<{ type?: string }>;
    return tabs.filter((t) => t.type === "page").length;
  } catch {
    return 0;
  }
}

/**
 * PUT /json/new?about:blank to open a blank tab.
 */
export async function openBlankTab(port: number): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 2000);
  try {
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Spawn scripts/jellyclaw-chrome.sh as a detached process.
 */
export function launchChrome(port: number): void {
  const scriptPath = resolve(process.cwd(), "scripts/jellyclaw-chrome.sh");
  const child = spawn("bash", [scriptPath], {
    env: { ...process.env, JELLYCLAW_CHROME_PORT: String(port) },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

/**
 * Wait for CDP to respond, polling every 300ms.
 */
export async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeCdp(port)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`chrome: CDP did not come up on :${port} within ${timeoutMs}ms`);
}
