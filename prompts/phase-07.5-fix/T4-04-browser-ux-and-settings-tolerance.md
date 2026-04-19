# Phase 07.5 Fix — Prompt T4-04: Browser UX + settings-loader tolerance

**When to run:** After T4-02 ✅. (T4-03 deferred.)
**Estimated duration:** 2–3 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

Four shipping gaps George hit while using jellyclaw's Chrome MCP against real sites:

1. **Chrome window not visible** — `scripts/jellyclaw-chrome.sh` launches Chrome headed, but the window sometimes stays in the background / minimized, so he can't watch the agent work.
2. **"New session every time"** — Chrome's persistent profile survives runs (logins + cookies), but **tabs do NOT restore** across runs. Every `jellyclaw run` lands on an empty browser.
3. **No auto-restart on hang** — if Chrome is up but wedged (CDP responds to `/json/version` but hangs on real commands), jellyclaw's autolaunch probe decides "ready" and then MCP fails. Need a deeper health check + auto-kill-and-relaunch.
4. **Settings-loader is too strict** — `~/.claude/settings.json` validation failures abort the whole load → falls back to strict mode → Bash blocked. George had to hand-patch `defaultMode: "dontAsk"` → `"bypassPermissions"` AND flatten `hooks.Stop`'s nested `{hooks: […]}` wrapper because jellyclaw's zod wants flat `[{command: …}]`. Also emits warnings for legitimate Claude Code tool names like `mcp__plugin_compound-engineering_pw__*` (underscore in server slug).

After this prompt lands, none of these pain points remain.

## Research task

1. Re-read T4-01's `chrome-autolaunch.ts` + `scripts/jellyclaw-chrome.sh`. These are the files we modify.
2. Read `engine/src/config/settings-loader.ts` in full. Understand how it validates + what it does on schema failure. The key sections: hook schema, MCP permission rule validation, error-handling.
3. Read Claude Code's hook shape — it supports BOTH flat `[{command: "…"}]` AND nested `[{hooks: [{type: "command", command: "…"}]}]`. Jellyclaw currently only accepts flat. We extend the schema to accept either (preserving backward compat).
4. Verify macOS `osascript` is available and the `tell application "Google Chrome" to activate` incantation works.
5. Grep for existing CDP probe logic in `chrome-autolaunch.ts` — we extend it.

## Implementation task

### Files to create / modify

- `scripts/jellyclaw-chrome.sh` — add `--restore-last-session`, activate-window step
- `engine/src/cli/chrome-autolaunch.ts` — deeper health check (real CDP command, not just `/json/version` HTTP probe) + osascript activate hook
- `engine/src/config/settings-loader.ts` — lenient hook shapes, lenient MCP name regex (allow underscores in server slug), partial-success (skip invalid entries instead of aborting whole file)
- `engine/src/config/settings-loader.test.ts` — cover both hook shapes, nested + flat, underscore MCP names, partial-file validity

### `jellyclaw-chrome.sh` changes

After the `exec` line that launches Chrome, wrap it so we also activate:

```bash
# ... existing launch, but as background + sleep + activate ...
"$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --restore-last-session \
  --no-first-run \
  --no-default-browser-check \
  "$@" &
CHROME_PID=$!
# Wait for Chrome to settle, then raise to foreground
sleep 2
osascript -e 'tell application "Google Chrome" to activate' 2>/dev/null || true
# Detach - script exits, Chrome keeps running
disown "$CHROME_PID" 2>/dev/null || true
```

Note the addition of `--restore-last-session` — Chrome will reopen the last run's tabs instead of a blank profile.

### `chrome-autolaunch.ts` changes

Add a `deepProbe` function that sends a real CDP command via WebSocket and times out fast (3s). If `deepProbe` fails on an otherwise-up port, kill Chrome and relaunch:

```ts
async function deepProbe(port: number): Promise<boolean> {
  // Connect to /json/version to get browser WS URL
  const ver = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
  if (!ver.ok) return false;
  const wsUrl = (await ver.json() as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
  if (!wsUrl) return false;

  return new Promise<boolean>((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 3000);
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Browser.getVersion" }));
    });
    ws.addEventListener("message", (ev) => {
      clearTimeout(timeout);
      try {
        const msg = JSON.parse(String(ev.data)) as { id: number; result?: unknown; error?: unknown };
        ws.close();
        resolve(msg.id === 1 && !msg.error);
      } catch {
        resolve(false);
      }
    });
    ws.addEventListener("error", () => { clearTimeout(timeout); resolve(false); });
  });
}
```

Modify `ensurePort` to use `deepProbe`:

```ts
async function ensurePort(port: number, logger: Logger): Promise<void> {
  const shallow = await probeCdp(port);        // existing HTTP /json/version probe
  const deep = shallow ? await deepProbe(port) : false;

  if (shallow && !deep) {
    logger.warn({ port }, `chrome: port ${port} responds HTTP but CDP is hung — killing and relaunching`);
    await killChrome(port);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!shallow || !deep) {
    logger.info({ port }, `chrome: launching via scripts/jellyclaw-chrome.sh`);
    await launchChrome(port);
    await waitForCdp(port, 15_000);
  }
  // ensure >=1 tab
  const tabCount = await countPageTabs(port);
  if (tabCount === 0) {
    logger.info({ port }, `chrome: no page tabs — opening about:blank`);
    await openBlankTab(port);
  }
  // Bring Chrome to foreground (macOS only)
  if (process.platform === "darwin") {
    spawn("osascript", ["-e", 'tell application "Google Chrome" to activate'], {
      stdio: "ignore",
      detached: true,
    }).unref();
  }
  logger.info({ port, tabs: await countPageTabs(port) }, `chrome: ready on :${port}`);
}

async function killChrome(port: number): Promise<void> {
  // Use scripts/jellyclaw-chrome-stop.sh since it knows the port
  await new Promise<void>((resolve) => {
    const child = spawn("bash", ["scripts/jellyclaw-chrome-stop.sh"], {
      env: { ...process.env, JELLYCLAW_CHROME_PORT: String(port) },
      stdio: "ignore",
    });
    child.on("close", () => resolve());
    setTimeout(() => { child.kill(); resolve(); }, 7000);
  });
}
```

### `settings-loader.ts` changes — three knobs

**(a) Lenient hook shapes.** Extend the zod schema to accept a union of:
```ts
// Flat (jellyclaw's current shape):
{ command: string; type?: "command"; timeout?: number }

// OR nested (Claude Code's shape):
{ hooks: Array<{ type: "command"; command: string; timeout?: number }> }
```
Parse via `z.union([FlatHook, NestedHook])`. Normalize to flat at load-time (expand nested arrays) so downstream code stays simple.

**(b) Lenient MCP name regex.** The current regex `/^mcp__[a-z0-9-]+__[a-z0-9_*-]+$/` rejects underscores in the `<server>` slug. Claude Code emits names like `mcp__plugin_compound-engineering_pw__browser_navigate`. Loosen the server regex to `[a-z0-9_-]+` (allow underscores) — matches Claude Code's actual practice. Don't block on `*` as the tool part either.

**(c) Partial-success loading.** Today one validation failure throws out the entire settings file. Change the loader so per-field errors **warn + skip the offending field**, keeping other valid fields. Implementation: wrap each field-level `parse` in try/catch, log a warning, and drop that field from the result.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/config/settings-loader.test.ts
bun run test engine/src/cli/chrome-autolaunch.test.ts
bun run lint
bun run build

# Smoke 1: settings file with nested hooks no longer throws
cat > /tmp/test-settings.json <<'EOF'
{
  "permissions": { "defaultMode": "bypassPermissions", "allow": ["Bash(*)"] },
  "hooks": { "Stop": [{"hooks":[{"type":"command","command":"echo hi"}]}] }
}
EOF
CLAUDE_SETTINGS=/tmp/test-settings.json ./engine/bin/jellyclaw doctor 2>&1 | grep -i "settings\|permission" | head -5

# Smoke 2: deep probe kills hung Chrome
# (manual: hit Chrome's CDP with garbage until it wedges, then run jellyclaw — expect kill+relaunch log)

# Smoke 3: headed window activates
scripts/jellyclaw-chrome-stop.sh
echo "just navigate to https://example.com" | ./engine/bin/jellyclaw run \
  --output-format stream-json --permission-mode bypassPermissions --max-turns 3 2>&1 | \
  grep -iE "chrome:|activate|osascript" | head -10
# Expect a visible Chrome window comes to front
```

### Expected output

- `scripts/jellyclaw-chrome.sh` now takes `--restore-last-session` → last run's tabs reappear
- Running jellyclaw with no Chrome running → Chrome boots, window raises to front via `osascript`
- Running jellyclaw with Chrome already up but wedged → warning log `chrome: … hung — killing and relaunching` + clean recovery
- `~/.claude/settings.json` with nested `Stop` hook shape → loads cleanly, no warnings about `hooks.Stop.0.command: Required`
- `~/.claude/settings.json` with `mcp__plugin_compound-engineering_pw__*` allow entries → accepted without "invalid MCP tool name" warnings
- One field with invalid value (e.g. a misspelled `defaultMode`) → loader WARNS about that field but still loads the rest (Bash still works via the allow list)

### Tests to add

- `settings-loader.test.ts`:
  - nested hook shape parses
  - flat hook shape parses
  - mixed (some flat, some nested) parses
  - `mcp__with_underscore__tool` in allow list accepted
  - malformed `defaultMode` → warns + falls back to `"default"`, but `allow` array still honored
- `chrome-autolaunch.test.ts`:
  - `deepProbe` returns true when CDP responds
  - `deepProbe` returns false when CDP hangs (3s timeout)
  - `ensurePort` kills + relaunches when `shallow && !deep`
  - `osascript activate` is invoked on darwin only (mock `process.platform`)

### Common pitfalls

- **`disown` may not exist in all shells.** Use `& disown` inside the launch script within a bash-specific block, or fall back to `&` alone + trap SIGHUP.
- **`--restore-last-session` can open MANY tabs** if user had 40 tabs last run. That's fine — agent can `browser_tabs list` and `browser_tabs close` if needed. Don't filter.
- **`osascript tell … activate`** requires Automation permissions (System Settings → Privacy → Automation) for the first call. If denied, the command silently fails — `2>/dev/null || true` hides that. Don't block the user.
- **Don't auto-kill Chrome if the user has LEGITIMATE tabs open.** The deep probe only fires if shallow probe succeeded but deep hangs. Real Chrome with real tabs shouldn't hang the `Browser.getVersion` command.
- **Lenient MCP regex must still reject truly invalid shapes** like `"mcp__"` (no server) or `""` (empty). Don't make it `/^mcp__.*/` — that's too loose.
- **Partial-success loading must log each drop.** Silent skipping is worse than verbose warnings; operators need to know which rules didn't take effect.

## Closeout

1. Update `COMPLETION-LOG.md` with `07.5.T4-04 ✅`.
2. Print `DONE: T4-04`.

On fatal failure: `FAIL: T4-04 <reason>`.
