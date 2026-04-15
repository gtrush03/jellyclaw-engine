# Genie ↔ jellyclaw Integration Plan

**Status:** Spec draft, pending W1 standalone validation
**Owner:** George Trushevskiy
**Engine source:** `/Users/gtrush/Downloads/jellyclaw-engine/` (OpenCode fork, pinned `>=1.4.4` — CVE-22812 patched, subagent hook bypass #5894 patched via `patches/001-subagent-hook-fire.patch`)
**Consumer:** `/Users/gtrush/Downloads/genie-2.0/src/core/dispatcher.mjs`
**Swapping:** Claurst subprocess → jellyclaw subprocess
**Provider priority (inverted from earlier spec):** **Anthropic direct first, OpenRouter second**

> Clarification: `jellyclaw-engine` (this repo, the coding-agent binary) is entirely separate from `/Users/gtrush/Downloads/jelly-claw/` (a macOS video-calling app). They share no code, no process, no config directory. The binary name is `jellyclaw` (one word, no hyphen).

---

## 1. Goal

Replace Genie's `claurst -p` subprocess with `jellyclaw run -p` while preserving:

- Stream-JSON event protocol consumed by `dispatcher.mjs`
- Telegram reporting cadence and receipt format
- Playwright MCP attached to Chrome CDP at `127.0.0.1:9222`
- Tier-based model routing (simple / website / browser / premium)
- Turn and budget caps per tier
- Trace file rotation and stall detection
- Skills directory discovery (currently `~/.claurst/skills/`)

And gain:

- Subagent hook firing (fixed via `patches/001-subagent-hook-fire.patch` — upstream #5894)
- 15-event stream-JSON superset (not 4) for richer Telegram updates
- Structured stderr with levels, codes, and component tags
- Native `--session-id` for resume without re-parsing logs
- Provider failover: Anthropic direct → OpenRouter only on 529/rate-limit
- OpenCode's kebab-case flag surface, which is closer to the official Claude Code CLI than Claurst's snake_case-ish Rust flags

---

## 2. Line-level diff: `src/core/dispatcher.mjs`

All line numbers refer to the current dispatcher at
`/Users/gtrush/Downloads/genie-2.0/src/core/dispatcher.mjs`.

### 2.1 Binary resolution (lines 20-38)

**Before:**

```js
const CLAURST_BIN = process.env.GENIE_CLAURST_BIN
  || (() => {
    const arch = process.arch;
    const tripleMap = { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' };
    const triple = tripleMap[arch];
    if (triple) {
      const archBin = resolve(REPO_ROOT, `engines/claurst/src-rust/target/${triple}/release/claurst`);
      if (existsSync(archBin)) return archBin;
    }
    const repoBin = resolve(REPO_ROOT, 'engines/claurst/src-rust/target/release/claurst');
    if (existsSync(repoBin)) return repoBin;
    try { return execSync('which claurst', { encoding: 'utf-8' }).trim(); } catch { return null; }
  })()
  || 'claurst';
const CLAURST_IS_PATH_LOOKUP = !CLAURST_BIN.includes('/');
```

**After:**

```js
const GENIE_ENGINE = (process.env.GENIE_ENGINE || 'jellyclaw').toLowerCase(); // 'claurst' | 'jellyclaw'

const JELLYCLAW_BIN = process.env.JELLYCLAW_BIN
  || (() => {
    // Repo-local install (built or symlinked into engines/jellyclaw/bin/jellyclaw)
    const repoBin = resolve(REPO_ROOT, 'engines/jellyclaw/bin/jellyclaw');
    if (existsSync(repoBin)) return repoBin;
    // Homebrew / npm global
    try { return execSync('which jellyclaw', { encoding: 'utf-8' }).trim(); } catch { return null; }
  })()
  || 'jellyclaw';

const CLAURST_BIN = process.env.GENIE_CLAURST_BIN || /* …unchanged legacy block… */ 'claurst';

const ENGINE_BIN = GENIE_ENGINE === 'claurst' ? CLAURST_BIN : JELLYCLAW_BIN;
const ENGINE_IS_PATH_LOOKUP = !ENGINE_BIN.includes('/');
```

**Why:** `GENIE_ENGINE=claurst|jellyclaw` env flag gives one-line rollback. Default
flips to jellyclaw in W3 (see §8).

### 2.2 Config path constant (new, after line 39)

```js
const JELLYCLAW_CONFIG_PATH = process.env.JELLYCLAW_CONFIG_PATH
  || resolve(process.env.HOME, '.jellyclaw');
```

### 2.3 Provider validation (lines 247-260)

**Before:** Defaults to `openrouter`. Requires only its key.

**After:**

```js
// Provider priority: Anthropic direct first, OpenRouter fallback.
// Override via GENIE_PROVIDER=openrouter to force OR for a single run.
const hasAnthropic  = !!process.env.ANTHROPIC_API_KEY;
const hasOpenRouter = !!process.env.OPENROUTER_API_KEY;
const provider = process.env.GENIE_PROVIDER
  || (hasAnthropic ? 'anthropic' : (hasOpenRouter ? 'openrouter' : null));
if (!provider) {
  const err = 'Neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY set — cannot dispatch';
  log('ERR', err);
  await sendMessage(`❌ Genie dispatcher error: ${err}`);
  return { success: false, /* …zeros… */ error: err };
}
const fallbackProvider = provider === 'anthropic' && hasOpenRouter ? 'openrouter' : null;
```

A 529 / rate-limit failure on the first jellyclaw run triggers a single retry
with `fallbackProvider`. Implemented in §2.8 (retry wrapper).

### 2.4 Tier model table (lines 118-123)

**Fix the `qwen/qwen3.6-plus:free` bug** — that slug does not exist on
OpenRouter. Verified slugs as of 2026-04-14:

```js
const TIER_MODELS = {
  anthropic: {
    simple:  'claude-haiku-4-5',
    website: 'claude-sonnet-4-6',
    browser: 'claude-sonnet-4-6',
    premium: 'claude-opus-4-6',
  },
  openrouter: {
    simple:  'qwen/qwen-2.5-72b-instruct:free',   // valid free slug
    website: 'qwen/qwen3-coder',                   // paid, $0.20/$0.80
    browser: 'anthropic/claude-sonnet-4.6',
    premium: 'anthropic/claude-opus-4.6',
  },
};

const modelTable = TIER_MODELS[provider] || TIER_MODELS.anthropic;
const model = process.env.GENIE_CLAUDE_MODEL
  ? process.env.GENIE_CLAUDE_MODEL
  : modelTable[complexity] || modelTable.browser;
```

### 2.5 Spawn args (lines 293-304)

**Before (Claurst):**

```js
const args = [
  '-p',
  '--model', model,
  '--provider', provider,
  '--append-system-prompt', systemPrompt,
  '--permission-mode', 'bypass-permissions',
  '--max-turns', maxTurns,
  '--max-budget-usd', maxBudget,
  '--output-format', 'stream-json',
  '--verbose',
  '--add-dir', REPO_ROOT,
];
```

**After (jellyclaw — OpenCode kebab-case surface):**

```js
const args = [
  'run',
  '--print',                                      // non-interactive
  '--model', model,
  '--provider', provider,
  '--append-system-prompt', systemPrompt,         // note: string, not @path
  '--permission-mode', 'bypass',                  // renamed from bypass-permissions
  '--max-turns', String(maxTurns),
  '--max-cost-usd', String(maxBudget),            // renamed from --max-budget-usd
  '--output-format', 'stream-json',
  '--stream-stderr', 'jsonl',                     // new: structured stderr
  '--add-dir', REPO_ROOT,
  '--config-dir', JELLYCLAW_CONFIG_PATH,          // new: explicit, don't rely on $HOME
  '--verbose',
];
if (process.env.GENIE_RESUME_SESSION_ID) {
  args.push('--session-id', process.env.GENIE_RESUME_SESSION_ID);
}
if (fallbackProvider) {
  args.push('--fallback-provider', fallbackProvider);
}
```

**Flag deltas documented:**

| Claurst flag             | jellyclaw flag           | Notes |
|--------------------------|--------------------------|-------|
| `-p`                     | `run --print`            | OpenCode uses subcommand form |
| `--max-budget-usd`       | `--max-cost-usd`         | |
| `--permission-mode bypass-permissions` | `--permission-mode bypass` | shortened |
| *(not available)*        | `--session-id <uuid>`    | resume support |
| *(not available)*        | `--stream-stderr jsonl`  | structured stderr |
| *(not available)*        | `--fallback-provider`    | provider failover |
| *(not available)*        | `--config-dir`           | explicit config path |

### 2.6 Event parser — `handleEvent` (lines 349-398)

Claurst emits 4 event types. jellyclaw emits 15. Rewrite the parser as a
dispatch table.

```js
// jellyclaw stream-json event superset (15 events):
//   system_init, system_ready
//   user_message
//   assistant_start, text_delta, thinking_delta, assistant_stop
//   tool_use_start, tool_use_delta, tool_use_result, tool_use_error
//   subagent_start, subagent_stop
//   usage, result, error
const handleEvent = async (evt) => {
  if (!evt || typeof evt !== 'object') return;
  trace(evt);
  const t = evt.type;

  switch (t) {
    case 'system_init':
    case 'system_ready':
      if (!initSent) {
        initSent = true;
        sessionId = evt.session_id || `jellyclaw-${Date.now()}`;
        log('EVT', `jellyclaw engine ready (session=${sessionId})`);
        await sendMessage('🧞 Genie engine spawned. Thinking…', { plain: true });
      }
      return;

    case 'text_delta':
      assistantText += evt.text || '';
      return;

    case 'thinking_delta':
      // Don't forward thinking to Telegram; trace only.
      return;

    case 'tool_use_start': {
      toolCount++;
      const name = evt.tool || evt.name || 'tool';
      const short = name
        .replace(/^mcp__playwright__/, 'pw.')
        .replace(/^mcp__plugin_compound-engineering_pw__/, 'pw.');
      const detail = summarizeToolInput(name, evt.input);
      await maybeSendTool(detail ? `🔧 ${short} · ${detail}` : `🔧 ${short}`);
      return;
    }

    case 'tool_use_error':
      await sendMessage(`⚠️ Tool error (${evt.tool}): ${String(evt.error).slice(0, 500)}`, { plain: true });
      return;

    case 'subagent_start':
      await maybeSendTool(`🧩 subagent: ${evt.description || evt.subagent_type || 'task'}`);
      return;

    case 'subagent_stop':
      // Swallow — subagent receipts are summarized in parent assistant text.
      return;

    case 'usage':
      // Running tally; may arrive multiple times per run.
      if (evt.cost_usd != null) usdCost = evt.cost_usd;
      return;

    case 'error':
      await sendMessage(`⚠️ Error: ${String(evt.error).slice(0, 1000)}`, { plain: true });
      return;

    case 'result':
      finalResult = assistantText || evt.result_text || null;
      usdCost = evt.cost_usd ?? usdCost;
      turns = evt.turns ?? toolCount;
      if (evt.usage) {
        log('EVT', `result in=${evt.usage.input_tokens} out=${evt.usage.output_tokens} cost=${usdCost}`);
      }
      return;

    // Silently accepted, traced only:
    case 'user_message':
    case 'assistant_start':
    case 'assistant_stop':
    case 'tool_use_delta':
    case 'tool_use_result':
      return;

    default:
      log('EVT', `unknown event type: ${t}`);
  }
};
```

### 2.7 Stderr capture (lines 422-432)

jellyclaw's structured stderr is JSONL when `--stream-stderr jsonl` is set.
Parse into a rolling ring buffer of the last 50 entries so the failure
receipt can report real errors, not a `tail -c 1500` of interleaved noise.

```js
const stderrRing = [];
const STDERR_RING_MAX = 50;

child.stderr.on('data', (buf) => {
  const s = buf.toString('utf-8');
  stderrBuf += s;
  if (stderrBuf.length > 100_000) stderrBuf = stderrBuf.slice(-50_000);

  for (const line of s.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { entry = { level: 'raw', msg: trimmed }; }
    stderrRing.push(entry);
    if (stderrRing.length > STDERR_RING_MAX) stderrRing.shift();
    const levelTag = entry.level ? `[${entry.level}]` : '';
    log('STDERR', `${levelTag} ${(entry.msg || entry.message || trimmed).slice(0, 300)}`);
  }
});
```

On failure path (end of function), prefer the ring buffer:

```js
const tail = stderrRing.length
  ? stderrRing.slice(-10).map(e => `[${e.level || '?'}] ${e.msg || e.message || ''}`).join('\n')
  : (stderrBuf.slice(-1500) || '(no stderr)');
```

### 2.8 Provider failover retry

Wrap the spawn-and-wait block in `attemptRun(provider)`. On exit code 2
(jellyclaw's convention for "provider error, retryable") AND a `fallbackProvider`
being available AND zero tool calls executed, recurse once with the fallback.

Hard cap: 1 failover per dispatch. No infinite loop.

### 2.9 Trace filename (line 221)

```js
const traceFile = resolve(TRACE_DIR, `dispatch-${GENIE_ENGINE}-${Date.now()}.jsonl`);
```

Lets comparison harness (§9, test/TESTING.md) diff Claurst vs jellyclaw traces
by engine prefix.

---

## 3. `.env` additions

```dotenv
# ── Engine selection ───────────────────────────────────────────────────────
GENIE_ENGINE=jellyclaw                # 'claurst' | 'jellyclaw'

# ── jellyclaw paths ────────────────────────────────────────────────────────
JELLYCLAW_BIN=/usr/local/bin/jellyclaw         # absolute path or PATH lookup
JELLYCLAW_CONFIG_PATH=/Users/gtrush/.jellyclaw # settings.json + mcp.json + skills/ live here

# ── Provider priority: Anthropic direct first, OpenRouter fallback ─────────
ANTHROPIC_API_KEY=sk-ant-…             # PRIMARY
OPENROUTER_API_KEY=sk-or-v1-…          # FALLBACK (used on 529 or if no Anthropic key)
# Optional explicit override:
# GENIE_PROVIDER=openrouter

# ── Resume support (unset for fresh runs) ──────────────────────────────────
# GENIE_RESUME_SESSION_ID=018f3c7a-…
```

---

## 4. LaunchAgent: `examples/com.genie.jellyclaw-serve.plist`

For long-lived mode, jellyclaw exposes `jellyclaw serve` which keeps a warm
worker pool so per-wish spawn latency drops from ~900ms to ~60ms. The
dispatcher is allowed to either spawn fresh subprocesses (current) or POST to
`http://127.0.0.1:7433/dispatch` (new, optional).

Install to `~/Library/LaunchAgents/com.genie.jellyclaw-serve.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.genie.jellyclaw-serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/jellyclaw</string>
    <string>serve</string>
    <string>--port</string>
    <string>7433</string>
    <string>--config-dir</string>
    <string>/Users/YOURNAME/.jellyclaw</string>
    <string>--warm-workers</string>
    <string>2</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/YOURNAME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>Crashed</key><true/>
  </dict>
  <key>StandardOutPath</key>
  <string>/tmp/genie-logs/jellyclaw-serve.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/genie-logs/jellyclaw-serve.err.log</string>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key>
  <string>GENIE_REPO_DIR</string>
</dict>
</plist>
```

W3 onwards, `dispatcher.mjs` checks `curl -s http://127.0.0.1:7433/health`
first and falls back to spawn if the daemon isn't up.

---

## 5. Skills migration — `~/.claurst/skills/` → `~/.jellyclaw/skills/`

Performed by `scripts/migrate-from-claurst.sh`. Strategy: symlink each skill
subdirectory so updates to either side stay in sync during transition, then
flip to owned copies in W4.

Skill references in `config/genie-system.md` use the literal path
`~/.claurst/skills/...`. Two options:

1. **Symlink root** (chosen): `ln -s ~/.jellyclaw/skills ~/.claurst/skills`
   after migrating content. Zero system-prompt edits required. Works because
   jellyclaw reads from `--config-dir/skills/` and the prompt paths still
   resolve for any `Read` tool invocation.

2. Prompt rewrite: sed-replace `.claurst/skills` → `.jellyclaw/skills` in
   `config/genie-system.md`. Deferred to W4 — one textual change across 4
   occurrences.

---

## 6. Settings migration — `.claurst/settings.json` → `.jellyclaw/settings.json`

jellyclaw (OpenCode schema) uses a different top-level shape. Converter lives
in `scripts/migrate-from-claurst.sh` (§migration script). Mapping:

| Claurst                         | jellyclaw (OpenCode)            |
|---------------------------------|---------------------------------|
| `config.permission_mode`        | `permissions.mode`              |
| `config.mcp_servers[]`          | `mcp.servers{}` (keyed map)     |
| `config.allowed_tools[]`        | `permissions.allow_tools[]`     |
| *(implicit)*                    | `model.default` (new)           |
| *(implicit)*                    | `hooks.*` (new — see §7)        |

Playwright MCP pin: **`@playwright/mcp@0.0.41`** (last known-good against
Chromium 131 and Chrome CDP as of 2026-04-14).

Target file — `~/.jellyclaw/settings.json`:

```json
{
  "$schema": "https://opencode.ai/schema/1.4.4",
  "model": {
    "default": "claude-sonnet-4-6",
    "provider_priority": ["anthropic", "openrouter"]
  },
  "permissions": {
    "mode": "bypass",
    "allow_tools": [
      "Bash", "Read", "Write", "Edit", "Glob", "Grep",
      "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit",
      "mcp__playwright"
    ]
  },
  "mcp": {
    "servers": {
      "playwright": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@playwright/mcp@0.0.41", "--cdp-endpoint", "http://127.0.0.1:9222"],
        "env": {}
      }
    }
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "command": "~/.jellyclaw/hooks/telegram-pre-bash.sh" }
    ],
    "PostToolUse": [
      { "matcher": "Bash", "command": "~/.jellyclaw/hooks/telegram-post-bash.sh" }
    ]
  }
}
```

---

## 7. System prompt migration — self-emit → hooks

Today `config/genie-system.md` instructs Genie to curl Telegram directly from
inside its Bash tool invocations. That works but couples reporting cadence
to the model's behavior. jellyclaw's PreToolUse / PostToolUse hooks (now
firing reliably for subagents after `patches/001-subagent-hook-fire.patch`)
let us move reporting out of the prompt entirely.

**Plan:**

1. Keep the current curl-based reporting in the prompt **during W1 and W2**.
   Hooks are additive, not required.
2. In W3, add hooks for:
   - `PreToolUse(Bash)` with a command pattern containing `vercel deploy` →
     send `🚀 Deploying…` to Telegram.
   - `PostToolUse(Bash)` matching a deploy → extract the URL from stdout and
     send `✅ Deployed → <url>`.
   - `PreToolUse(mcp__playwright__browser_navigate)` → `🌐 Opening <url>`.
3. In W4, delete the Telegram curl recipes from `config/genie-system.md` and
   rely entirely on hooks.

Hook scripts live in `~/.jellyclaw/hooks/` and receive the tool name, input
JSON, and result JSON on stdin per OpenCode 1.4.4 hook protocol.

---

## 8. Rollback

One-line revert. In `.env`:

```
GENIE_ENGINE=claurst
```

Restart the genie server (`launchctl kickstart -k gui/$(id -u)/com.genie.server`).
Dispatcher's `ENGINE_BIN` resolves back to `CLAURST_BIN`, args revert to the
Claurst shape (the code keeps both arg builders until W4 full cutover).

Keep both arg-builder functions through W4:

```js
function buildArgsClaurst({ model, provider, systemPrompt, maxTurns, maxBudget }) { /* … */ }
function buildArgsJellyclaw({ model, provider, systemPrompt, maxTurns, maxBudget, sessionId, fallbackProvider }) { /* … */ }
const args = GENIE_ENGINE === 'claurst' ? buildArgsClaurst(ctx) : buildArgsJellyclaw(ctx);
```

Delete the Claurst builder and the `engines/claurst` submodule in W5.

---

## 9. 12 canonical wishes for parity testing

Source of truth: `test/canonical-wishes.json`. Summary:

1. **coffee-landing** — Build a landing page about coffee. Tier: website.
2. **sweetgreen-order** — Order a salad from Sweetgreen. Tier: browser. Dry-run in CI.
3. **linkedin-dm-5** — DM 5 founders on LinkedIn. Tier: browser. Dry-run in CI.
4. **research-topic** — Research the latest on AI regulation. Tier: browser.
5. **stripe-49** — Create a Stripe payment link for $49. Tier: browser.
6. **tweet-plus-landing** — Tweet + landing page combo. Tier: browser.
7. **schedule-calendly** — Schedule a Calendly meeting. Tier: browser. Dry-run in CI.
8. **vercel-deploy** — Vercel deploy a simple page. Tier: website.
9. **github-issues-summary** — Search and summarize GitHub issues. Tier: browser.
10. **multi-file-refactor** — Multi-file code refactor with parallel subagents. Tier: premium.
11. **factcheck-3-subagents** — Fact-check a claim with 3 parallel research subagents. Tier: premium.
12. **firebase-todo-app** — Build a simple TODO web app with Firebase. Tier: website.

Tiers verify routing. Subagent wishes (10, 11) specifically exercise patch #001.
Dry-run wishes exit after the final confirm button with no click; asserted via
the `tool_use_start` stream ending on `browser_click` with a matching
selector.

---

## 10. Week-by-week integration

### W1 — Engine standalone
- Build jellyclaw locally: `cd /Users/gtrush/Downloads/jellyclaw-engine && ./scripts/build.sh`.
- Verify `jellyclaw --version` prints `1.4.4+jellyclaw.1`.
- Run `jellyclaw run -p "say hi"` — no MCP, no skills, smoke test.
- Apply `patches/001-subagent-hook-fire.patch` and confirm hooks fire for
  Task-spawned subagents via `test/unit/hooks.test.mjs`.
- No Genie integration yet.

### W2 — Behind flag
- Run `scripts/migrate-from-claurst.sh`.
- Add jellyclaw arg builder + event parser to `dispatcher.mjs`.
- `GENIE_ENGINE=jellyclaw` is opt-in; default stays `claurst`.
- Run all 12 canonical wishes manually. Diff trace files vs Claurst.
- Monitor stall detector, cost accounting, Telegram cadence.

### W3 — Default with shadow diff
- Flip default to `jellyclaw`. Claurst still selectable via flag.
- Shadow mode: for each real wish, record both engines' traces against the
  same transcript (Claurst via a "replay" spawn triggered post-hoc from the
  server). Diff event counts, tool sequences, final result shape.
- Install `com.genie.jellyclaw-serve.plist`, switch dispatcher to HTTP mode.
- Migrate first two hooks (PreToolUse / PostToolUse on Bash).

### W4 — Full cutover
- Delete `buildArgsClaurst` and the `engines/claurst` submodule.
- Rewrite `config/genie-system.md` Telegram recipes to reference hooks.
- Sed `.claurst/skills` → `.jellyclaw/skills` in system prompt.
- Keep `GENIE_ENGINE=claurst` as a flag that errors with a clear message
  (`claurst support removed in v2.0 — reinstall legacy build from <ref>`).
- Update `CLAUDE.md` bootstrap to check `jellyclaw` instead of `claurst`.

### W5 — Cleanup
- Remove the Claurst rollback path entirely.
- Archive `engines/claurst` to a tag `pre-jellyclaw`.
- Document jellyclaw-only operations in `CLAUDE.md`.

---

## 11. Acceptance gate before each week transition

Each week closes only when:

- All 12 canonical wishes pass the comparison harness (test/TESTING.md §comparison).
- 48h burn-in in current mode shows ≥95% success rate and no stall kills.
- Cost accounting reconciles to within 3% of Anthropic usage API (or OpenRouter
  `/generation` endpoint) for the billing window.
- Zero unhandled `default:` branches logged from the event parser.
- Manual checklist (15 items, test/TESTING.md §manual) signed off by George.
