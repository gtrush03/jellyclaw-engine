# Phase 07.5 Fix — Prompt T4-02: Final-state screenshot on session end

**When to run:** After T4-01 ✅.
**Estimated duration:** 1–2 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

When a jellyclaw session ends, playwright-mcp exits and its working browser tabs close — meaning George can't see what the agent left on screen, and `browser_take_screenshot` during the session itself often times out on heavy sites like mbusa.com (5s default cap).

Fix: before jellyclaw session teardown closes MCP, capture a final PNG of every active page tab via **direct CDP `Page.captureScreenshot`** (bypasses playwright-mcp entirely, much faster + no timeout quirks). Save to a predictable path. Surface the path in the `session.completed` event so the user always has proof of what the agent did.

## Research task

1. Read `engine/src/cli/run.ts` around lines 355-365 — the `finally` block where `mcp?.stop()` runs today. New code goes BEFORE that stop.
2. Read `engine/src/events.ts` to find the `session.completed` event shape. Extending with `final_screenshots?: readonly string[]` field.
3. CDP `Page.captureScreenshot` takes no args for default behavior. Returns base64 PNG in `result.data`.
4. To take a screenshot per tab: enumerate `/json` for `type: "page"` tabs, open a WebSocket to each tab's `webSocketDebuggerUrl`, send `{"id":1,"method":"Page.captureScreenshot","params":{"format":"png"}}`, decode base64, save.
5. `ws` package is available in node_modules; use it. Or node 22+ has native WebSocket global.

## Implementation task

### Files to create / modify

- `engine/src/cli/session-screenshot.ts` — **new.** Exports `captureAllTabs(port, outDir, logger): Promise<string[]>`. Returns list of saved PNG paths.
- `engine/src/cli/run.ts` — invoke before `mcp.stop()` in `finally`. Use `session.paths.cwd` or `~/.jellyclaw/sessions/<id>/` as outDir.
- `engine/src/events.ts` — add optional `final_screenshots: readonly string[]` to `session.completed` event schema. Non-breaking (optional).
- `engine/src/agents/loop.ts` — plumb `final_screenshots` into the emitted `session.completed` event if present.
- `engine/src/cli/session-screenshot.test.ts` — unit tests (mocked fetch + ws).

### `session-screenshot.ts` contract

```ts
import { WebSocket } from "ws"; // or global WebSocket if node supports it
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Logger } from "../logger.js";

interface Tab {
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
  type: string;
}

export async function captureAllTabs(
  port: number,
  outDir: string,
  logger: Logger,
): Promise<string[]> {
  let tabs: Tab[];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return [];
    tabs = (await res.json()) as Tab[];
  } catch {
    return [];
  }
  const pages = tabs.filter((t) => t.type === "page" && !t.url.startsWith("chrome://"));
  if (pages.length === 0) return [];

  mkdirSync(outDir, { recursive: true });
  const saved: string[] = [];

  for (let i = 0; i < pages.length; i++) {
    const tab = pages[i]!;
    try {
      const path = join(outDir, `final-${i.toString().padStart(2, "0")}-${sanitize(tab.title)}.png`);
      await captureOne(tab.webSocketDebuggerUrl, path);
      saved.push(path);
      logger.info({ url: tab.url, path }, "session: final screenshot saved");
    } catch (err) {
      logger.warn({ err, url: tab.url }, "session: screenshot capture failed for tab");
    }
  }
  return saved;
}

async function captureOne(wsUrl: string, outPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("screenshot timeout after 30s"));
    }, 30_000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Page.captureScreenshot", params: { format: "png" } }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { id: number; result?: { data?: string }; error?: unknown };
      if (msg.id === 1) {
        clearTimeout(timeout);
        if (msg.error || !msg.result?.data) {
          ws.close();
          reject(new Error(`screenshot error: ${JSON.stringify(msg.error)}`));
          return;
        }
        writeFileSync(outPath, Buffer.from(msg.result.data, "base64"));
        ws.close();
        resolvePromise();
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9-]+/gi, "-").toLowerCase().slice(0, 60) || "untitled";
}
```

### Wire into run.ts

In the `finally` block:

```ts
try {
  const ports = extractLocalCdpPorts(mcpConfigs); // reuse helper from T4-01
  if (ports.size > 0) {
    const outDir = join(homedir(), ".jellyclaw", "sessions", sessionId, "screenshots");
    for (const port of ports) {
      const saved = await captureAllTabs(port, outDir, logger);
      if (saved.length > 0) {
        // Emit final event with paths - or attach to session.completed
        finalScreenshots.push(...saved);
      }
    }
  }
} catch (err) {
  logger.warn({ err }, "session: final-screenshot hook failed");
} finally {
  await mcp?.stop();
}
```

The emitted `session.completed` event should include `final_screenshots: string[]`.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/cli/session-screenshot.test.ts
bun run lint
bun run build

# Smoke
scripts/jellyclaw-chrome-stop.sh   # kill Chrome if any
# Run a prompt that navigates somewhere visible
echo "use mcp__playwright__browser_navigate to go to https://example.com then wait 2s" | \
  ./engine/bin/jellyclaw run --output-format stream-json --permission-mode bypassPermissions --max-turns 4
# Expect in session.completed event: final_screenshots field with at least 1 path
ls -la ~/.jellyclaw/sessions/*/screenshots/
# Expect: final-00-example-domain.png exists, is a valid PNG
file ~/.jellyclaw/sessions/*/screenshots/final-*.png | head -5
```

### Tests to add

- `session-screenshot.test.ts`:
  - `captureAllTabs(port, dir, logger)` returns `[]` when port not listening
  - returns `[]` when no page tabs (all chrome://)
  - returns saved paths when page tabs exist (mock fetch + WebSocket)
  - continues across per-tab failures (one failure doesn't bork the rest)
  - sanitize filename strips unsafe chars

### Common pitfalls

- **Never use playwright-mcp's screenshot tool here.** The whole point is to bypass it. Direct CDP over WebSocket.
- **Must happen BEFORE `mcp.stop()`.** Once MCP stops, the playwright-mcp process exits, which MAY close its last tab. We need to capture while tabs still exist.
- **30s per-tab timeout is generous.** Big pages render slow. But don't drop below 10s — mbusa.com alone takes 6+.
- **Skip chrome:// URLs.** New Tab Page, Omnibox Popup etc. aren't useful screenshots and the CDP may refuse them anyway.
- **The event extension MUST be backward-compat.** `final_screenshots?: string[]` — optional, missing on old events. Don't break consumers.
- **Path needs to be absolute.** Log the absolute path so the user can open it.

## Closeout

1. Update `COMPLETION-LOG.md` with `07.5.T4-02 ✅`.
2. Print `DONE: T4-02`.

On fatal failure: `FAIL: T4-02 <reason>`.
