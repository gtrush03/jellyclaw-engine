# Phase 07.5 — Chrome MCP — Prompt T1-02: Chrome launch helper (Flow 2)

**When to run:** After `T1-01` ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 2 hours
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Research task

1. Re-read `phases/PHASE-07.5-chrome-mcp.md` Step 4 and § Flow 2 in `docs/CHROME-MCP-INTEGRATION-PLAN.md`.
2. Read `scripts/playwright-test-chrome.sh` in full — this exists already for the integration test (port 9333). We mirror its shape but for port 9333 BYOC + user profile persistence.
3. WebFetch `https://developer.chrome.com/blog/remote-debugging-port` — confirm the Chrome 136+ default-profile block and the `--user-data-dir` workaround.
4. Use `context7` MCP to look up `chrome-launcher` package docs (`mcp__plugin_compound-engineering_context7__query-docs` with query "chrome-launcher macOS getInstallations"). We might use the lib if it's clean; otherwise pure bash.
5. Read `engine/src/cli/doctor.ts` — identify the right place to add a CDP-reachability probe. Doctor's existing patterns: `check()`, `warn()`, `ok()`, `fail()`, `hint()`. Match them.
6. Verify the macOS Chrome binary path: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

## Implementation task

Ship a shell script that launches Chrome on port 9333 with a stable dedicated user-data-dir at `~/Library/Application Support/jellyclaw-chrome-profile`. On first run the user logs into whatever they care about once, and sessions persist across runs. Also extend `jellyclaw doctor` to detect (a) whether Chrome is installed, (b) whether port 9333 has a responsive CDP endpoint, (c) whether the user-data-dir exists.

This prompt does NOT ship Flow 1 (extension bridge). That's a docs-only addition in T3-01. Flow 3 (ephemeral headless Chromium) is the Playwright MCP default and needs no helper.

### Files to create/modify

- `scripts/jellyclaw-chrome.sh` — **new**, executable. Launches Chrome with the right flags.
- `scripts/jellyclaw-chrome-stop.sh` — **new**, executable. Graceful SIGTERM then SIGKILL after 5s.
- `engine/src/cli/doctor.ts` — add a `checkChromeBrowser()` function + wire it into the `doctor` command output.
- `engine/src/cli/doctor.test.ts` — test the new doctor cases (mock filesystem + port probe).

### `scripts/jellyclaw-chrome.sh` skeleton

```bash
#!/usr/bin/env bash
set -euo pipefail

# Launch Chrome for jellyclaw browser-MCP usage.
# - Binds CDP on 127.0.0.1:9333
# - Uses dedicated profile at ~/Library/Application Support/jellyclaw-chrome-profile
#   (respects Chrome 136+ default-profile block; see Chrome blog 2025-03)
# - Safe to re-run; reuses profile across launches

PORT="${JELLYCLAW_CHROME_PORT:-9333}"
PROFILE="${JELLYCLAW_CHROME_PROFILE:-$HOME/Library/Application Support/jellyclaw-chrome-profile}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ ! -x "$CHROME" ]]; then
  echo "error: Chrome not found at $CHROME" >&2
  echo "hint:  install via 'brew install --cask google-chrome' or download from https://www.google.com/chrome/" >&2
  exit 1
fi

# Port already bound? bail out gracefully — probably already running
if lsof -i ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "jellyclaw-chrome already running on port $PORT"
  exit 0
fi

mkdir -p "$PROFILE"
echo "starting Chrome on CDP $PORT with profile $PROFILE" >&2
exec "$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run \
  --no-default-browser-check \
  "$@"
```

### `scripts/jellyclaw-chrome-stop.sh` skeleton

```bash
#!/usr/bin/env bash
set -euo pipefail

PORT="${JELLYCLAW_CHROME_PORT:-9333}"
PIDS=$(lsof -i ":$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
if [[ -z "$PIDS" ]]; then
  echo "no Chrome listening on port $PORT"
  exit 0
fi
echo "stopping Chrome pid(s): $PIDS"
kill -TERM $PIDS
sleep 5
# force kill anything still alive
for pid in $PIDS; do
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid"
  fi
done
```

Make both scripts executable: `chmod +x scripts/jellyclaw-chrome*.sh`.

### Doctor additions

In `engine/src/cli/doctor.ts`, add:

```ts
import { existsSync } from "node:fs";

async function checkChromeBrowser(report: DoctorReport) {
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chromePath)) {
    report.ok(`Chrome installed at ${chromePath}`);
  } else {
    report.warn("Chrome not found — Chrome-MCP flows disabled");
    report.hint("brew install --cask google-chrome (or Chrome Web Store extension path; see docs/chrome-setup.md)");
    return;
  }

  const port = Number(process.env.JELLYCLAW_CHROME_PORT ?? 9333);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      const data = await res.json();
      report.ok(`CDP reachable on :${port} (${data.Browser})`);
    } else {
      report.warn(`CDP port ${port} returned HTTP ${res.status}`);
    }
  } catch {
    report.info(`CDP port ${port} not listening — run \`scripts/jellyclaw-chrome.sh\` to start`);
  }

  const profileDir = `${process.env.HOME}/Library/Application Support/jellyclaw-chrome-profile`;
  if (existsSync(profileDir)) {
    report.ok(`user-data-dir ready at ${profileDir}`);
  } else {
    report.info(`user-data-dir not yet created at ${profileDir} (created on first launch)`);
  }
}
```

Wire it into the doctor run at the bottom of the existing checks, guarded by platform:

```ts
if (process.platform === "darwin") {
  await checkChromeBrowser(report);
}
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
chmod +x scripts/jellyclaw-chrome.sh scripts/jellyclaw-chrome-stop.sh

# Start Chrome, capture the pid so we can clean up
scripts/jellyclaw-chrome.sh &
CHROME_PID=$!
sleep 3

# Verify CDP is reachable
curl -s http://127.0.0.1:9333/json/version | jq .Browser

# Run doctor
./engine/bin/jellyclaw doctor 2>&1 | grep -i chrome

# Stop Chrome
scripts/jellyclaw-chrome-stop.sh
wait $CHROME_PID 2>/dev/null || true
```

### Expected output

- `scripts/jellyclaw-chrome.sh` starts a Chrome window bound to 127.0.0.1:9333, profile at `~/Library/Application Support/jellyclaw-chrome-profile`
- `curl http://127.0.0.1:9333/json/version` returns the Chrome/<N> browser string
- `jellyclaw doctor` reports:
  - `ok: Chrome installed at /Applications/…`
  - `ok: CDP reachable on :9333 (Chrome/<N>)` when Chrome is running
  - `info: CDP port 9333 not listening — run scripts/jellyclaw-chrome.sh to start` when it's not
  - Profile-dir ok / info as appropriate
- `scripts/jellyclaw-chrome-stop.sh` kills the Chrome process cleanly within 5 seconds

### Tests to add

- `engine/src/cli/doctor.test.ts`:
  - Chrome binary present + CDP up → two oks
  - Chrome present + CDP down → ok + info
  - Chrome missing → warn + hint
  - Non-darwin platform → chrome check skipped entirely

Mock `existsSync` and `globalThis.fetch` for deterministic runs.

### Verification

```bash
bun run typecheck
bun run test engine/src/cli/doctor.test.ts
bun run lint

# Interactive smoke (already in shell commands above)
scripts/jellyclaw-chrome.sh &
sleep 3
./engine/bin/jellyclaw doctor
scripts/jellyclaw-chrome-stop.sh
```

### Common pitfalls

- **DO NOT point `--user-data-dir` at `~/Library/Application Support/Google/Chrome/`**. Chrome 136+ blocks CDP against the default profile. Our dedicated path is mandatory.
- **DO NOT hard-code port 9222.** That port is reserved for user's own debug sessions and the test suite already enforces a forbid on it. We use 9333 everywhere (matches existing convention at `test/integration/playwright-mcp.test.ts:43`).
- **DO NOT `--no-sandbox` by default.** Chrome's sandbox is a security feature. Users who need it off pass it themselves.
- **Match existing doctor patterns.** Don't invent new `report.*` methods — use whatever is already there.
- **Handle the "Chrome already running" case gracefully.** If the port is bound, exit 0 with a note, not a failure — the user may be re-running intentionally.
- **AbortSignal.timeout may not exist under older bun.** If typecheck/build flags it, use `AbortController + setTimeout` manually.
- **Don't assume `/usr/bin/jq`** in tests — use `node:child_process` + JSON.parse if you need to cross-check curl output programmatically.

## Closeout

1. Update `COMPLETION-LOG.md` with `07.5.T1-02 ✅`.
2. Update `STATUS.md` to point at `T2-01`.
3. Print `DONE: T1-02`.

On fatal failure: `FAIL: T1-02 <reason>`.
