# Phase 07.5 Fix — Prompt T4-01: Chrome auto-lifecycle

**When to run:** After Phase 07.5 (T0..T3-01) is complete. First prompt in the fix chain.
**Estimated duration:** 1–2 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

Right now `jellyclaw run` with a Chrome MCP config that uses `--cdp-endpoint http://127.0.0.1:9333` requires the USER to have already started Chrome on that port (via `scripts/jellyclaw-chrome.sh`). This is fragile:

1. User forgets → MCP connection fails silently
2. Prior Chrome process died → same failure
3. Chrome is up but has zero active tabs (happens after a prior MCP session exits) → Playwright reports `Browser.setDownloadBehavior: Browser context management is not supported`

We fix all three. After this prompt lands, `jellyclaw run` auto-detects CDP endpoints in MCP configs, probes them, and launches Chrome (via the existing `scripts/jellyclaw-chrome.sh`) if they're not up. It also ensures Chrome always has at least one tab (opens `about:blank` via CDP if tab count is zero) so Playwright attach always succeeds.

## Research task

1. Read `engine/src/cli/run.ts` around lines 198-216 (where `loadMcpConfigs` + `McpRegistry.start()` happen). Chrome autolaunch must run BEFORE `registry.start()`.
2. Read `engine/src/mcp/types.ts` — confirm the `StdioMcpServerConfig.args` is `readonly string[]` so we can scan for `--cdp-endpoint http://127.0.0.1:PORT` patterns.
3. Read `scripts/jellyclaw-chrome.sh` from T1-02 so you know the command to invoke.
4. Read `engine/src/mcp/registry.ts` — understand the start() lifecycle so your pre-hook runs in the right place.
5. Look up Chrome DevTools Protocol's `Target.createTarget` endpoint — a simple `curl -X PUT http://127.0.0.1:PORT/json/new?about:blank` also opens a tab.

## Implementation task

### Files to create / modify

- `engine/src/cli/chrome-autolaunch.ts` — **new.** Exports `ensureChromeRunning(configs, logger)`. Scans MCP configs for `--cdp-endpoint http://127.0.0.1:<port>` args, probes each port, spawns Chrome + ensures >=1 tab if needed.
- `engine/src/cli/chrome-autolaunch.test.ts` — unit tests with mocked fetch + spawn.
- `engine/src/cli/run.ts` — call `await ensureChromeRunning(mcpConfigs, logger)` AFTER `loadMcpConfigs` and BEFORE `registry.start()`.
- `docs/chrome-setup.md` — update Flow 2 section: note that `jellyclaw-chrome.sh` is now auto-invoked, user no longer has to start Chrome manually.

### `chrome-autolaunch.ts` contract

```ts
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

function extractLocalCdpPorts(configs: readonly McpServerConfig[]): Set<number> {
  const ports = new Set<number>();
  for (const cfg of configs) {
    if (cfg.transport !== "stdio") continue;
    for (let i = 0; i < cfg.args.length; i++) {
      if (CDP_ARG_RE.test(cfg.args[i] ?? "")) {
        const next = cfg.args[i + 1] ?? "";
        const m = CDP_URL_RE.exec(next);
        if (m) ports.add(Number(m[1]));
      }
    }
  }
  return ports;
}

async function ensurePort(port: number, logger: Logger): Promise<void> {
  // Probe CDP
  const alive = await probeCdp(port);
  if (!alive) {
    logger.info({ port }, `chrome: port ${port} not listening — auto-launching via scripts/jellyclaw-chrome.sh`);
    await launchChrome(port);
    await waitForCdp(port, 15_000);
  }
  // Ensure at least one page tab
  const tabCount = await countPageTabs(port);
  if (tabCount === 0) {
    logger.info({ port }, `chrome: no page tabs on :${port} — opening about:blank`);
    await openBlankTab(port);
  }
  logger.info({ port, tabs: await countPageTabs(port) }, `chrome: ready on :${port}`);
}

// probe /json/version, return true if 200
async function probeCdp(port: number): Promise<boolean> { /* fetch with 500ms AbortSignal */ }

// count tabs where type === "page"
async function countPageTabs(port: number): Promise<number> { /* fetch /json */ }

// PUT /json/new?about:blank
async function openBlankTab(port: number): Promise<void> { /* fetch PUT */ }

// spawn scripts/jellyclaw-chrome.sh as detached process
async function launchChrome(port: number): Promise<void> {
  const scriptPath = resolve(process.cwd(), "scripts/jellyclaw-chrome.sh");
  const child = spawn("bash", [scriptPath], {
    env: { ...process.env, JELLYCLAW_CHROME_PORT: String(port) },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function waitForCdp(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeCdp(port)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`chrome: CDP did not come up on :${port} within ${timeoutMs}ms`);
}
```

### Wire into run.ts

Insert after `loadMcpConfigs` and before the `new McpRegistry`:

```ts
if (mcpConfigs.length > 0) {
  await ensureChromeRunning(mcpConfigs, logger);
  mcp = new McpRegistry({ logger });
  // ...
}
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/cli/chrome-autolaunch.test.ts
bun run lint
bun run build

# Smoke (real Chrome + real jellyclaw)
scripts/jellyclaw-chrome-stop.sh     # kill any existing Chrome
echo "use mcp__playwright__browser_navigate to go to example.com and snapshot" | \
  ./engine/bin/jellyclaw run --output-format stream-json --permission-mode bypassPermissions --max-turns 4 2>&1 | \
  grep -E "chrome:|mcp:" | head -20
# Expect: "chrome: port 9333 not listening — auto-launching"
#         "chrome: ready on :9333"
#         "mcp: started 1 server(s)"
# AND: subsequent session (Chrome already up) does NOT relaunch
```

### Tests to add

- `chrome-autolaunch.test.ts`:
  - `ensureChromeRunning([])` is a no-op
  - config with no `--cdp-endpoint` → no-op
  - config with `--cdp-endpoint http://127.0.0.1:9333` AND CDP live with tab → no-op (only logs "ready")
  - config with CDP live but 0 tabs → calls openBlankTab
  - config with CDP dead → spawns Chrome + waits for CDP + opens blank tab
  - Multiple configs pointing at same port → single launch (port dedup via Set)
  - Remote CDP (e.g. `http://some.host:9333`) → ignored (local-only)
  - spawn failure → propagates error

### Common pitfalls

- **Don't block on Chrome startup if port was already alive.** Probe first; if up, skip spawn entirely. This is the hot path for "Chrome already running."
- **DO NOT kill Chrome on session exit.** Persistent profile + persistent logins are the whole point. Just leave Chrome running.
- **The `opens a blank tab` trick** fixes the "playwright-mcp can't attach with 0 tabs" bug George hit. The `openBlankTab` must run every session-start regardless, because prior playwright-mcp exits sometimes close the last tab.
- **`scripts/jellyclaw-chrome.sh` may print to stderr** — don't let that noise propagate. Use `stdio: "ignore"` + `detached: true` + `unref()` so the Chrome process outlives jellyclaw cleanly.
- **Timeout 15s is generous** for cold Chrome boot on macOS. Don't tighten.

## Closeout

1. Update `COMPLETION-LOG.md` with `07.5.T4-01 ✅`.
2. Print `DONE: T4-01`.

On fatal failure: `FAIL: T4-01 <reason>`.
