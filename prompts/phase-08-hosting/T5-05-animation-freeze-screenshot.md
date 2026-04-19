# Phase 08 Hosting — Prompt T5-05: Session-end screenshot animation-freeze

**When to run:** Independent of other T5 prompts. Lands the final-piece screenshot reliability fix.
**Estimated duration:** 2–3 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

Phase 07.5 T4-02 shipped `engine/src/cli/session-screenshot.ts` — session-end captures of every open tab via direct CDP `Page.captureScreenshot`. It works for static pages (example.com, GitHub, docs sites). It **hangs** on heavy-JS sites — Mercedes S-Class configurator, Bentley configurator, any WebGL/Three.js/Unity-in-browser app. The existing 60-second timeout eventually fires; the PNG never materializes; the agent turn ends without the evidence it needed.

George hit this repeatedly and manually developed a working recipe: throw away `requestAnimationFrame`, hide every `<canvas>` / `<video>` / `<iframe>`, disable CSS animations/transitions, wait 1 second for the browser to settle, THEN call `Page.captureScreenshot`. The files at `/tmp/pw-bentley2.mjs` and `/tmp/pw-final.mjs` are the working proofs (~27 lines each; reproduce the Bentley + S-Class screenshots in <10s). This prompt bakes that recipe into `session-screenshot.ts` so the engine captures reliable final frames without the user scripting it.

The approach: inject a JS snippet into the page via CDP `Runtime.evaluate` BEFORE calling `Page.captureScreenshot`. The snippet freezes animations, hides canvases, kills CSS transitions. After the capture, revert the changes (best-effort — the tab is about to close anyway, so reversion is a nicety, not a correctness requirement).

## Research task

1. Read `engine/src/cli/session-screenshot.ts` end-to-end. The critical function is `captureViaTarget` (lines 90-215). Today's flow: attach → `Page.bringToFront` → `Page.captureScreenshot`. You insert the freeze step between bringToFront and captureScreenshot.
2. Read the working recipes: `/tmp/pw-bentley2.mjs` (27 lines) and `/tmp/pw-final.mjs` (36 lines). Both use `page.evaluate(() => { ... })` with the same freeze snippet. These are the ground truth.
3. Read the existing test `engine/src/cli/session-screenshot.test.ts` (if it exists; else search for it) — you extend it with a mocked-CDP test that verifies the freeze script is sent on the wire.
4. Look up CDP `Runtime.evaluate` — the method that lets you run arbitrary JS in a page context via CDP. Parameters: `expression` (string), `awaitPromise` (boolean), `returnByValue` (boolean), optionally `contextId`.
5. Read the existing direct-page-WebSocket mode in `captureViaTarget` (lines 105-161) — this is the code path you modify first; the browser-level-attach mode (lines 162-207) gets the same treatment.
6. Check `engine/src/cli/chrome-autolaunch.ts` `deepProbe` — that's the existing pattern for sending a CDP JSON-RPC over WebSocket; mirror its shape for consistency.
7. Re-read Phase 07.5 T4-02 prompt (`prompts/phase-07.5-fix/T4-02-session-end-screenshot.md`) to understand the original design choices. The 60s timeout stays; we just add the freeze step so the timeout rarely fires.

## Implementation task

Scope: extend `captureViaTarget` in `engine/src/cli/session-screenshot.ts` to inject an animation-freeze script via CDP `Runtime.evaluate` before the `Page.captureScreenshot` call. Add a post-capture revert (best-effort). Cover both the direct-page-WS path and the browser-WS-attach path. Drop the effective timeout from 60s to 10s (the freeze was the cause of hangs; with freeze, real pages capture in <5s).

### Files to create / modify

- `engine/src/cli/session-screenshot.ts` — MODIFY. Add `freezePage(ws, sessionId?)` step before `Page.captureScreenshot` in both code paths. Add `unfreezePage(ws, sessionId?)` best-effort cleanup. Lower `captureViaTarget` timeout from 60_000 to 10_000.
- `engine/src/cli/session-screenshot.test.ts` — MODIFY (or create). Add test: mocked CDP WebSocket asserts `Runtime.evaluate` with the freeze expression is sent before `Page.captureScreenshot`.
- `docs/chrome-setup.md` — short note in the Troubleshooting section: "Heavy-JS sites (configurators, WebGL apps) now capture reliably. The engine freezes animations + hides canvases before the screenshot — artifact appears within 10 s instead of timing out at 60 s."
- `COMPLETION-LOG.md` — append entry.

### Freeze / unfreeze payloads

```ts
// Exactly the recipe from /tmp/pw-bentley2.mjs and /tmp/pw-final.mjs.
// Kept as a string constant so the test can match the wire format verbatim.
const FREEZE_EXPRESSION = `
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

const UNFREEZE_EXPRESSION = `
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
```

### Direct-page-WS path — the new state machine

Today (lines 134-161): `bringToFront` → `captureScreenshot`. New: `bringToFront` → `Runtime.evaluate(freeze)` → wait 1000ms → `captureScreenshot` → `Runtime.evaluate(unfreeze)` (fire-and-forget) → close.

```ts
if (useDirect) {
  // msg.id === 1 → bringToFront response → send freeze
  if (msg.id === 1) {
    ws.send(JSON.stringify({
      id: ++msgId,
      method: "Runtime.evaluate",
      params: { expression: FREEZE_EXPRESSION, returnByValue: true, awaitPromise: false },
    }));
    return;
  }
  // msg.id === 2 → freeze ack → wait 1000ms → capture
  if (msg.id === 2) {
    setTimeout(() => {
      ws.send(JSON.stringify({
        id: ++msgId,
        method: "Page.captureScreenshot",
        params: { format: "png" },
      }));
    }, 1000);
    return;
  }
  // msg.id === 3 → capture response → write file → fire unfreeze (best-effort) → close
  if (msg.id === 3) {
    // Write the PNG first so a failing unfreeze can't lose the capture.
    if (msg.error) { clearTimeout(timeout); ws.close(); reject(new Error(`screenshot error: ${msg.error.message ?? JSON.stringify(msg.error)}`)); return; }
    if (!msg.result?.data) { clearTimeout(timeout); ws.close(); reject(new Error("screenshot error: no data returned")); return; }
    writeFileSync(outPath, Buffer.from(msg.result.data, "base64"));
    // Best-effort unfreeze — we don't await the response; if it fails, the tab is probably closing anyway.
    try {
      ws.send(JSON.stringify({
        id: ++msgId,
        method: "Runtime.evaluate",
        params: { expression: UNFREEZE_EXPRESSION, returnByValue: true, awaitPromise: false },
      }));
    } catch {}
    clearTimeout(timeout);
    ws.close();
    resolvePromise();
    return;
  }
}
```

### Browser-WS-attach path — mirror the change

Same insertion: after `Target.attachToTarget` ack, send `Runtime.evaluate(freeze)` WITH the `sessionId` param, wait 1000ms, send `Page.captureScreenshot` with `sessionId`, handle response + write file + fire unfreeze + detach + close.

This path has `sessionId` on every subsequent message — don't forget it on the freeze/unfreeze/capture calls.

### Timeout adjustment

Replace the existing 60_000 with 10_000. Heavy-JS pages with freeze captured reliably in 3-5s in George's manual testing. 10s is generous.

```ts
const timeout = setTimeout(() => {
  ws.close();
  reject(new Error("screenshot timeout after 10s"));
}, 10_000);
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/cli/session-screenshot.test.ts
bun run lint
bun run build

# Regression — static page still screenshots (example.com)
scripts/jellyclaw-chrome-stop.sh
cat > /tmp/jc-test-static.json <<'EOF'
{
  "mcp": [{
    "transport": "stdio",
    "name": "playwright",
    "command": "npx",
    "args": ["-y", "@playwright/mcp@latest", "--browser", "chrome", "--cdp-endpoint", "http://127.0.0.1:9333"]
  }]
}
EOF
cp /tmp/jc-test-static.json ~/.jellyclaw/jellyclaw.json
echo "navigate to https://example.com and just stay there" | \
  /Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw run \
    --output-format stream-json --permission-mode bypassPermissions --max-turns 3 2>&1 | \
  grep -iE "screenshot|final-" | head -5
ls -lh /Users/gtrush/.jellyclaw/sessions/*/screenshots/final-*.png 2>/dev/null | tail -3
# Expect: a PNG file, size > 10KB, reasonable capture of example.com

# Live smoke — heavy JS page (the load-bearing test for this prompt)
echo "navigate to https://www.mbusa.com/en/vehicles/build/s-class/sedan/s580e4 and then summarize what you see" | \
  /Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw run \
    --output-format stream-json --permission-mode bypassPermissions --max-turns 5 2>&1 | \
  grep -iE "screenshot|final-|freeze|10s|timeout" | head -10
ls -lh /Users/gtrush/.jellyclaw/sessions/*/screenshots/final-*.png 2>/dev/null | tail -3
# Expect: PNG file materializes in <10s (NOT 60s); size > 100KB (real content, not a blank frame);
# file timestamp within 10 seconds of the session-end log line
```

### Expected output

- Unit tests pass, including the new mocked-CDP assertion that `Runtime.evaluate` with the freeze expression precedes every `Page.captureScreenshot`.
- Static-page screenshots (example.com) still work — no regression.
- Heavy-JS pages (Mercedes S-Class configurator, Bentley configurator, any WebGL app) now produce a valid PNG within 10 s.
- Timeout lowered from 60 s to 10 s; the 60-second-hang-then-empty-file failure mode is gone.
- Freeze + unfreeze fire per-tab; no permanent mutation to page state.

### Tests to add

- `engine/src/cli/session-screenshot.test.ts`:
  - New case: mock WebSocket intercepts all messages; assert the order is `Page.bringToFront` → `Runtime.evaluate` (with FREEZE_EXPRESSION) → `Page.captureScreenshot` → (optionally `Runtime.evaluate` unfreeze).
  - Assert the freeze expression contains `"requestAnimationFrame = () => 0"` and `"document.querySelectorAll('canvas"` — the two load-bearing substrings.
  - Capture response with error → function rejects with `screenshot error: ...`; no PNG written.
  - Capture response with empty data → rejects with `no data returned`.
  - Timeout path: if no response arrives in 10s, rejects with `screenshot timeout after 10s`.
  - Regression case: static page capture still works when the mock returns a base64 PNG on the first capture call.

### Common pitfalls

- **Don't await the unfreeze response.** The tab may be closing (session ends right after the capture). If you wait for the unfreeze ack, you add 200-500ms to every screenshot for no benefit. Fire-and-forget.
- **The 1000ms wait AFTER freeze matters.** Less than 1000ms and WebGL contexts sometimes haven't finished flushing. George's recipe uses 1000ms explicitly — don't shorten it.
- **Don't freeze twice.** If two tabs share a session (unlikely but possible in some CDP states), the `__jcOriginalRaf` key would be overwritten. The snippet doesn't defend against this because per-tab isolation is Chrome's job — the `(() => { ... })()` IIFE runs in one tab's realm.
- **`awaitPromise: false` is correct.** The freeze snippet returns a sync value (`{ hidden: N }`). Don't flip to `true` — it's a round-trip for no reason.
- **`returnByValue: true`.** Required if the return value is used; we don't use it, but CDP will send the result anyway. Include for future-proofing.
- **Canvas hiding doesn't prevent the screenshot from seeing the canvas.** `Page.captureScreenshot` captures the composited frame, which is what the freeze leaves on screen when animations stop. Hiding the canvas via `style.visibility = 'hidden'` removes IT from the final frame — that's desirable for WebGL configurators where the canvas is the JS-driven re-render source; the static background chrome (wheel selector UI, specs panel, etc.) is what we want to capture. If a user complains the captured image "is missing the 3D car," they can disable via env var — NOT in this prompt.
- **`style.visibility` not `display: none`.** `display: none` reflows layout and changes the captured image's geometry. `visibility: hidden` preserves layout.
- **Don't mutate `document.head` if it doesn't exist.** Edge case for pages that haven't parsed the head yet. Guard with `if (document.head)` in the snippet — actually, by the time `bringToFront` returned OK, head exists. Skip the guard.
- **Browser-level attach path vs direct page WS.** Both code paths need the freeze step. The direct path is simpler (no sessionId); the attach path threads sessionId through every CDP call. Don't forget the attach path.
- **Test uses mocked WebSocket.** Don't spawn a real Chrome in the unit test. Mock `global.WebSocket` or refactor `captureViaTarget` to accept a `ws` factory (DI seam). The existing test file may already have this structure — mirror it.
- **Error case: freeze fails.** If `Runtime.evaluate` returns `{error: ...}`, DON'T proceed to capture — the page is in an unknown state. Reject with `freeze failed: <msg>`. Add this as a test case.

## Closeout

1. Update `COMPLETION-LOG.md` with `08.T5-05 ✅` — note which live smoke URLs were tested, PNG sizes, capture times.
2. Print `DONE: T5-05`.

On fatal failure: `FAIL: T5-05 <reason>`.
