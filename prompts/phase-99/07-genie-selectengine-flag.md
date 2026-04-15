# Phase 99 — Unfucking — Prompt 07: Genie selectEngine() flag + dispatcher swap

**When to run:** After 99-04 (`--output-format claude-stream-json` works). 99-06 not required.
**Estimated duration:** ~120 minutes
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
<!-- Use /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md but adapt — Jelly-Claw repo is at /Users/gtrush/Downloads/Jelly-Claw/, NOT jellyclaw-engine -->
<!-- Read /Users/gtrush/Downloads/Jelly-Claw/CLAUDE.md first for that project's conventions -->
<!-- Working API key: <REDACTED_API_KEY> -->
<!-- Phase doc: /Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-99-unfucking.md -->
<!-- END SESSION STARTUP -->

---

## Pre-flight (run first to confirm starting state)

```bash
# Confirm claude binary path + version on this machine
which claude && claude --version
# Expected: /Users/gtrush/.local/bin/claude — 2.1.109 (Claude Code)

# Confirm jellygenie launchd services (BOTH old + new plists live on this box)
launchctl list | grep -E "com\.(jellygenie|genie)\."
# Expected 4 lines: com.jellygenie.server, com.jellygenie.chrome,
# com.genie.server, com.genie.chrome — two parallel deployments coexist.
# The live one wired to /Users/gtrush/Downloads/Jelly-Claw/genie-server is com.jellygenie.*

# Confirm dispatcher.mjs is 1324 lines and the spawn call is still around L684
wc -l /Users/gtrush/Downloads/Jelly-Claw/genie-server/src/core/dispatcher.mjs
grep -n "spawn(CLAUDE_BIN" /Users/gtrush/Downloads/Jelly-Claw/genie-server/src/core/dispatcher.mjs

# Confirm Jelly-Claw mcp.json is present (Playwright CDP at :9222)
cat /Users/gtrush/Downloads/Jelly-Claw/genie-server/config/mcp.json
```

## Why this exists

Jelly-Claw's `genie-server/src/core/dispatcher.mjs:684` (the single `spawn(CLAUDE_BIN, args, ...)` invocation) and `soul-builder.mjs` (which imports `loadClaudeCredentials` + `ensureJellyClaudeConfigDir` from dispatcher and does its own `spawn(CLAUDE_BIN, ...)` further down) hardcode `claude -p`. We need a feature-flagged `selectEngine()` that returns either `{bin: 'claude', args: [...]}` or `{bin: 'jellyclaw', args: [...]}`. Default during rollout: `claude`. Operator flips via env var. Includes auto-fallback if jellyclaw fails mid-run.

## Files to read first (in `/Users/gtrush/Downloads/Jelly-Claw/`)

Verified line numbers as of 2026-04-15 (dispatcher.mjs is **1324 lines** — my earlier "~900" was off):

1. `genie-server/src/core/dispatcher.mjs`:
   - Lines **49-56**: `CLAUDE_BIN` resolution (env `GENIE_CLAUDE_BIN` → `which claude` → `/usr/local/bin/claude` → `~/.local/bin/claude` → literal `'claude'`).
   - Lines **64-81**: sandboxed auth paths (`~/Library/Application Support/Jelly-Claw/claude-auth.json` + `.../claude-config/`).
   - Lines **94-155**: `loadClaudeCredentials()` + `ensureJellyClaudeConfigDir()` (exported for soul-builder).
   - Lines **462-567**: `makeHandleEvent()` factory — the stream-json consumer. Events handled: `system.init` (478), `assistant` with `tool_use` / `text` blocks (493-542), `user` with `tool_result` (544-554), `result` (557-565). **This is the contract the jellyclaw `--output-format claude-stream-json` writer must satisfy.**
   - Lines **581-930**: `dispatchToClaude()` — the actual spawn is at **line 684** (`spawn(CLAUDE_BIN, args, {cwd, stdio, env: claudeEnv})`). Args assembled at 639-655. NDJSON line parser at **795-812**.
   - Lines **941-997**: `continueDispatch()` — uses `--resume <sessionId>` (no second direct spawn; it recurses into `dispatchToClaude`).
2. `genie-server/src/core/soul-builder.mjs` — has its own `CLAUDE_BIN` resolution (lines 23-26) and its own `spawn(CLAUDE_BIN, ...)` block. Replace both.
3. `genie-server/src/core/server.mjs` — env loading, launchd integration.
4. `genie-server/CLAUDE.md` — project conventions (setup flow, launchd plists at `examples/com.jellygenie.{server,chrome}.plist`).
5. `genie-server/config/mcp.json` — Playwright MCP → `http://127.0.0.1:9222`.
6. `genie-server/.env.example` — current env shape.

## What to use for `CLAUDE_BIN` default

On this machine `which claude` → `/Users/gtrush/.local/bin/claude`, version `2.1.109 (Claude Code)`. Keep the existing four-step resolution chain (env → `which` → `/usr/local/bin/claude` → `~/.local/bin/claude`) — `which claude` already returns the correct path. No hardcoding needed.

## Build

### Step A — selectEngine()

Create `genie-server/src/core/select-engine.mjs`:

```js
import { which } from "./util-which.mjs";

const ENGINE = process.env.GENIE_ENGINE ?? "claude"; // claude | jellyclaw | shadow
const FALLBACK = process.env.GENIE_ENGINE_FALLBACK !== "0"; // default on
const JELLYCLAW_BIN = process.env.GENIE_JELLYCLAW_BIN ?? which("jellyclaw");
const CLAUDE_BIN = process.env.GENIE_CLAUDE_BIN ?? which("claude");

export function selectEngine({ overrideEngine } = {}) {
  const target = overrideEngine ?? ENGINE;
  if (target === "jellyclaw") {
    if (!JELLYCLAW_BIN) {
      if (FALLBACK) return claudeBundle();
      throw new Error("GENIE_ENGINE=jellyclaw but jellyclaw binary not found");
    }
    return jellyclawBundle();
  }
  return claudeBundle();
}

function claudeBundle() {
  return {
    engine: "claude",
    bin: CLAUDE_BIN,
    args: [
      "-p",
      "--output-format", "stream-json",
      "--allowedTools", "Bash,Read,Write,Edit,WebFetch",
      "--permission-mode", "bypassPermissions",
      "--max-turns", "200",
      "--max-budget-usd", "25",
    ],
  };
}

function jellyclawBundle() {
  return {
    engine: "jellyclaw",
    bin: JELLYCLAW_BIN,
    args: [
      "run", // first positional set by caller (the wish text via stdin)
      "--output-format", "claude-stream-json",
      "--allowed-tools", "Bash,Read,Write,Edit,WebFetch",
      "--permission-mode", "bypass",
      "--max-turns", "200",
      "--max-budget-usd", "25",
    ],
  };
}

export const ENGINE_FLAG = ENGINE;
export const FALLBACK_ENABLED = FALLBACK;
```

### Step B — Dispatcher swap

Modify `genie-server/src/core/dispatcher.mjs` at the **exact spawn site (line 684)**:

```js
import { selectEngine } from "./select-engine.mjs";

// inside dispatch():
const sel = selectEngine({ overrideEngine: clip.metadata?.engine });
log.info({ engine: sel.engine, clipId }, "SPAWN");
const finalArgs = [...sel.args, ...extraArgs];
const proc = spawn(sel.bin, finalArgs, { ... });

proc.on("exit", async (code) => {
  if (code !== 0 && sel.engine === "jellyclaw" && FALLBACK_ENABLED && !alreadyFellBack) {
    log.warn({ clipId, code }, "jellyclaw failed, falling back to claude");
    await dispatch({ ...args, _alreadyFellBack: true, _forceEngine: "claude" });
  }
});
```

Same change in `soul-builder.mjs` — it has its own `spawn(CLAUDE_BIN, ...)` further down (read the whole file; the spawn is past line 80 where the visible snippet ends). Replace hardcoded `CLAUDE_BIN` + args with `selectEngine().bin` + args. **Pin soul-builder to `claude` for the first 2 weeks** by passing `overrideEngine: "claude"` until dispatcher cutover is stable.

Also grep for any additional spawn sites: `grep -n "spawn(.*CLAUDE\|spawn(claudeBin\|spawn('claude'" genie-server/src/core/*.mjs`. `executor.mjs` may or may not exist — audit before editing. The dispatcher-level swap is the primary change.

### Step C — Per-clip override

Allow clip metadata to specify engine — useful for canary by creator username:

```js
// In dispatcher.mjs where clip is loaded:
if (clip.metadata?.creatorUsername === "george.tru") {
  clip.metadata.engine = "jellyclaw"; // canary user
}
```

### Step D — Logging

Tag every dispatch log line with `engine=claude|jellyclaw`. Append metrics line per dispatch end to `/tmp/jellygenie-logs/metrics.ndjson`:

```json
{"ts":"2026-04-15T14:00:00Z","clipId":"c1","engine":"jellyclaw","exitCode":0,"wallMs":12340,"inputTokens":1234,"outputTokens":567,"costUsd":0.024,"toolUseCount":3,"fallbackTriggered":false}
```

### Step E — .env.example update

```bash
# Engine selection (Phase 99)
GENIE_ENGINE=claude            # claude | jellyclaw | shadow
GENIE_ENGINE_FALLBACK=1         # auto-fallback to claude on jellyclaw failure
GENIE_JELLYCLAW_BIN=            # absolute path; empty = which()
GENIE_CLAUDE_BIN=               # absolute path; empty = which()
```

## Tests

Create `genie-server/src/core/select-engine.test.mjs`:

1. `GENIE_ENGINE` unset → returns claude bundle.
2. `GENIE_ENGINE=jellyclaw` + binary present → returns jellyclaw bundle.
3. `GENIE_ENGINE=jellyclaw` + binary missing + fallback on → returns claude bundle.
4. `GENIE_ENGINE=jellyclaw` + binary missing + fallback off → throws.
5. `overrideEngine: 'claude'` wins regardless of env.

Live integration:
```bash
GENIE_ENGINE=jellyclaw \
GENIE_JELLYCLAW_BIN=/Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw \
ANTHROPIC_API_KEY=<REDACTED_API_KEY> \
node genie-server/bin/dispatch-once.mjs --wish "say pong"
```

Telegram receipt should arrive identical-shape to the claude path.

## Out of scope

- Shadow mode is prompt 08.
- Don't change the Swift menubar app.
- Don't cut over default yet (`GENIE_ENGINE` stays `claude`).

## Done when

- `node --test genie-server/src/core/select-engine.test.mjs` green
- Live dispatch with `GENIE_ENGINE=jellyclaw` produces a working Telegram receipt
- Live dispatch with `GENIE_ENGINE=jellyclaw` + missing binary falls back to claude transparently
- `.env.example` documents all new vars
- COMPLETION-LOG.md (in jellyclaw-engine repo) updated with cutover-flag doc

<!-- BEGIN SESSION CLOSEOUT -->
<!-- Tag commit `phase-99-genie-flag`. Confirm GENIE_ENGINE=claude is the live default. -->
<!-- END SESSION CLOSEOUT -->
