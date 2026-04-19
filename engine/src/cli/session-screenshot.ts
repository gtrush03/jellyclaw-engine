/**
 * Phase 07.5 T4-02 — Final-state screenshot on session end.
 *
 * Captures screenshots of all active page tabs via direct CDP before MCP
 * shutdown. This bypasses playwright-mcp entirely (faster, no timeout quirks).
 *
 * T5-05: Freezes animations + hides canvas/video/iframe before capture to
 * reliably screenshot heavy-JS sites (WebGL configurators, etc.).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../logger.js";

// ---------------------------------------------------------------------------
// Animation freeze/unfreeze payloads (T5-05)
// ---------------------------------------------------------------------------

/**
 * Freeze animations, hide canvas/video/iframe, disable CSS transitions.
 * This is the proven recipe from /tmp/pw-bentley2.mjs and /tmp/pw-final.mjs.
 * @internal exported for testing
 */
export const FREEZE_EXPRESSION = `
(() => {
  window.__jcOriginalRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = () => 0;
  window.__jcHiddenEls = [];
  for (const el of document.querySelectorAll('canvas, video, iframe')) {
    try {
      window.__jcHiddenEls.push({ el, prev: el.style.visibility });
      el.style.visibility = 'hidden';
    } catch {}
  }
  const s = document.createElement('style');
  s.id = '__jc-freeze-style';
  s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;}';
  document.head.appendChild(s);
  return { hidden: window.__jcHiddenEls.length };
})()
`;

/**
 * Restore requestAnimationFrame, unhide elements, remove freeze style.
 * Best-effort cleanup — tab may be closing anyway.
 * @internal exported for testing
 */
export const UNFREEZE_EXPRESSION = `
(() => {
  if (window.__jcOriginalRaf) { window.requestAnimationFrame = window.__jcOriginalRaf; delete window.__jcOriginalRaf; }
  for (const { el, prev } of (window.__jcHiddenEls ?? [])) {
    try { el.style.visibility = prev; } catch {}
  }
  delete window.__jcHiddenEls;
  const s = document.getElementById('__jc-freeze-style');
  if (s && s.parentNode) s.parentNode.removeChild(s);
  return { ok: true };
})()
`;

interface Tab {
  id: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
  type: string;
}

interface BrowserInfo {
  webSocketDebuggerUrl: string;
}

/**
 * Capture screenshots of all page tabs (excluding chrome:// URLs) via CDP.
 * Returns list of saved PNG paths.
 */
export async function captureAllTabs(
  port: number,
  outDir: string,
  logger: Logger,
): Promise<string[]> {
  // Get browser WebSocket URL
  let browserWsUrl: string;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return [];
    const info = (await res.json()) as BrowserInfo;
    browserWsUrl = info.webSocketDebuggerUrl;
  } catch {
    return [];
  }

  // Get list of tabs
  let tabs: Tab[];
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return [];
    tabs = (await res.json()) as Tab[];
  } catch {
    return [];
  }

  const pages = tabs.filter((t) => t.type === "page" && !t.url.startsWith("chrome://"));
  logger.debug(
    {
      tabCount: tabs.length,
      pageCount: pages.length,
      pages: pages.map((p) => ({ id: p.id, url: p.url })),
    },
    "session: tabs found for screenshot",
  );
  if (pages.length === 0) return [];

  mkdirSync(outDir, { recursive: true });
  const saved: string[] = [];

  for (let i = 0; i < pages.length; i++) {
    const tab = pages[i];
    if (!tab) continue;
    const path = join(outDir, `final-${i.toString().padStart(2, "0")}-${sanitize(tab.title)}.png`);
    try {
      // Small delay before each capture to let CDP settle
      await new Promise((r) => setTimeout(r, 200));
      // Use direct page WebSocket if available (more reliable)
      await captureViaTarget(browserWsUrl, tab.id, path, tab.webSocketDebuggerUrl);
      saved.push(path);
      logger.info({ url: tab.url, path }, "session: final screenshot saved");
    } catch (err) {
      logger.warn({ err, url: tab.url }, "session: screenshot capture failed for tab");
    }
  }
  return saved;
}

/**
 * Capture a single tab via direct page WebSocket + Page.captureScreenshot.
 * Connects directly to the page's debugger WebSocket for simplicity.
 *
 * T5-05: Injects animation freeze via Runtime.evaluate before capture.
 * Flow: bringToFront → freeze → wait 1000ms → capture → unfreeze (best-effort) → close.
 */
function captureViaTarget(
  browserWsUrl: string,
  targetId: string,
  outPath: string,
  pageWsUrl?: string,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // Use page WebSocket if available, otherwise fall back to browser-level attachment
    const wsUrl = pageWsUrl ?? browserWsUrl;
    const useDirect = !!pageWsUrl;
    const ws = new WebSocket(wsUrl);
    // T5-05: Lowered from 60s to 10s — freeze prevents hangs on heavy-JS sites.
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("screenshot timeout after 10s"));
    }, 10_000);

    let sessionId: string | null = null;
    let msgId = 0;

    ws.addEventListener("open", () => {
      if (useDirect) {
        // Direct page WebSocket - bring to front first
        ws.send(
          JSON.stringify({
            id: ++msgId,
            method: "Page.bringToFront",
          }),
        );
      } else {
        // Browser WebSocket - need to attach to target first
        ws.send(
          JSON.stringify({
            id: ++msgId,
            method: "Target.attachToTarget",
            params: { targetId, flatten: true },
          }),
        );
      }
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        result?: { sessionId?: string; data?: string };
        error?: { message?: string };
      };

      if (useDirect) {
        // Direct mode: id=1 bringToFront, id=2 freeze, id=3 capture, id=4 unfreeze (ignored)
        if (msg.id === 1) {
          // bringToFront completed → send freeze
          ws.send(
            JSON.stringify({
              id: ++msgId,
              method: "Runtime.evaluate",
              params: { expression: FREEZE_EXPRESSION, returnByValue: true, awaitPromise: false },
            }),
          );
          return;
        }
        if (msg.id === 2) {
          // freeze response → check for error, then wait 1000ms → capture
          if (msg.error) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error(`freeze failed: ${msg.error.message ?? JSON.stringify(msg.error)}`));
            return;
          }
          setTimeout(() => {
            ws.send(
              JSON.stringify({
                id: ++msgId,
                method: "Page.captureScreenshot",
                params: { format: "png" },
              }),
            );
          }, 1000);
          return;
        }
        if (msg.id === 3) {
          // capture response → write file → fire unfreeze (best-effort) → close
          if (msg.error) {
            clearTimeout(timeout);
            ws.close();
            reject(
              new Error(`screenshot error: ${msg.error.message ?? JSON.stringify(msg.error)}`),
            );
            return;
          }
          if (!msg.result?.data) {
            clearTimeout(timeout);
            ws.close();
            reject(new Error("screenshot error: no data returned"));
            return;
          }
          writeFileSync(outPath, Buffer.from(msg.result.data, "base64"));
          // Best-effort unfreeze — we don't await the response
          try {
            ws.send(
              JSON.stringify({
                id: ++msgId,
                method: "Runtime.evaluate",
                params: {
                  expression: UNFREEZE_EXPRESSION,
                  returnByValue: true,
                  awaitPromise: false,
                },
              }),
            );
          } catch {
            // Tab may be closing — ignore
          }
          clearTimeout(timeout);
          ws.close();
          resolvePromise();
        }
        return;
      }

      // Browser-level mode: id=1 attach, id=2 freeze, id=3 capture, id=4 unfreeze, id=5 detach
      if (msg.id === 1 && msg.result?.sessionId) {
        sessionId = msg.result.sessionId;
        // Send freeze with sessionId
        ws.send(
          JSON.stringify({
            id: ++msgId,
            sessionId,
            method: "Runtime.evaluate",
            params: { expression: FREEZE_EXPRESSION, returnByValue: true, awaitPromise: false },
          }),
        );
        return;
      }

      if (msg.id === 2 && sessionId) {
        // freeze response → check for error, then wait 1000ms → capture
        if (msg.error) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`freeze failed: ${msg.error.message ?? JSON.stringify(msg.error)}`));
          return;
        }
        setTimeout(() => {
          ws.send(
            JSON.stringify({
              id: ++msgId,
              sessionId,
              method: "Page.captureScreenshot",
              params: { format: "png" },
            }),
          );
        }, 1000);
        return;
      }

      if (msg.id === 3 && sessionId) {
        // capture response → write file → fire unfreeze → detach → close
        if (msg.error) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`screenshot error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
          return;
        }
        if (!msg.result?.data) {
          clearTimeout(timeout);
          ws.close();
          reject(new Error("screenshot error: no data returned"));
          return;
        }
        writeFileSync(outPath, Buffer.from(msg.result.data, "base64"));
        // Best-effort unfreeze
        try {
          ws.send(
            JSON.stringify({
              id: ++msgId,
              sessionId,
              method: "Runtime.evaluate",
              params: { expression: UNFREEZE_EXPRESSION, returnByValue: true, awaitPromise: false },
            }),
          );
        } catch {
          // Ignore
        }
        // Detach
        ws.send(
          JSON.stringify({
            id: ++msgId,
            method: "Target.detachFromTarget",
            params: { sessionId },
          }),
        );
        clearTimeout(timeout);
        ws.close();
        resolvePromise();
        return;
      }

      if (msg.id === 1 && msg.error) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(`attach error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket error"));
    });
  });
}

/**
 * Sanitize a string for use in filenames.
 */
export function sanitize(s: string): string {
  const sanitized = s
    .replace(/[^a-z0-9-]+/gi, "-")
    .replace(/^-+|-+$/g, "") // Remove leading/trailing hyphens
    .toLowerCase()
    .slice(0, 60);
  return sanitized || "untitled";
}
