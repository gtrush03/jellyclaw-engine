# Phase 99 — Unfucking — Prompt 08: Shadow mode + smoke harness + cutover prep

**When to run:** After 99-07 (selectEngine flag merged, manual jellyclaw dispatch works).
**Estimated duration:** ~150 minutes
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
<!-- Use /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md but Jelly-Claw repo is at /Users/gtrush/Downloads/Jelly-Claw/ -->
<!-- Working API key: <REDACTED_API_KEY> -->
<!-- Phase doc: /Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-99-unfucking.md -->
<!-- END SESSION STARTUP -->

---

## Why this exists

Before flipping `GENIE_ENGINE=jellyclaw` as the default, run shadow mode for 7 days: every real wish dispatches through `claude -p` (with all real side effects) AND through `jellyclaw run` in parallel with neutered env (no Telegram, no Tools that mutate). Diff outputs daily. Promote only when shadow shows no regressions.

This prompt builds shadow infrastructure + a tool-parity smoke harness + the rollback plan. Then you watch the shadow data for a week before doing the actual flip (which is a one-line config change).

## Pre-flight (run first to confirm starting state)

```bash
# Confirm 99-07 landed: select-engine.mjs exists, dispatcher imports it
test -f /Users/gtrush/Downloads/Jelly-Claw/genie-server/src/core/select-engine.mjs && echo "selectEngine module: OK"
grep -n "selectEngine" /Users/gtrush/Downloads/Jelly-Claw/genie-server/src/core/dispatcher.mjs | head

# Confirm jellygenie launchctl services are present (needed for launchctl kickstart)
launchctl list | grep com.jellygenie
# Expected:
#   com.jellygenie.server    ← the one genie-server runs under
#   com.jellygenie.chrome    ← headless Chrome on CDP :9222
# (There is ALSO com.genie.server / com.genie.chrome on this box — an older
# parallel deployment. All four coexist; we only care about com.jellygenie.*)

# Confirm the jellyclaw binary exists where the shadow spawn will invoke it
test -x /Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw && echo "jellyclaw bin: OK" || echo "BLOCKER: build jellyclaw first"

# Confirm Anthropic key still works (shadow mode needs it for the jellyclaw side)
ANTHROPIC_API_KEY=<REDACTED_API_KEY> \
  curl -s -o /dev/null -w "%{http_code}\n" https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" -H "anthropic-version: 2023-06-01" -H "x-api-key: $ANTHROPIC_API_KEY" \
  -d '{"model":"claude-haiku-4-5","max_tokens":5,"messages":[{"role":"user","content":"pong"}]}'
# Expected: 200
```

## Files to read first

1. `genie-server/src/core/dispatcher.mjs` (post-99-07). 1324 lines as of 2026-04-15 pre-99-07.
2. `genie-server/src/core/select-engine.mjs` (built in 99-07).
3. `genie-server/config/mcp.json` — Playwright MCP config (single server: `npx -y @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222`).
4. `genie-server/.env.example`.

## Build

### Step A — Shadow spawner

Modify `genie-server/src/core/dispatcher.mjs` `dispatch()`:

```js
if (process.env.GENIE_ENGINE === "shadow") {
  // Primary: claude with full env (real side effects)
  const primary = await runEngine({ ...args, _engineOverride: "claude", _shadowRole: "primary" });

  // Shadow: jellyclaw with neutered env, async, fire-and-forget logging
  void runEngine({
    ...args,
    _engineOverride: "jellyclaw",
    _shadowRole: "shadow",
    _envOverrides: shadowEnv(),
    _logFile: `/tmp/jellygenie-logs/shadow/${args.clipId}.shadow.ndjson`,
  }).catch((err) => log.error({ err, clipId: args.clipId }, "shadow run failed"));

  return primary;
}
```

`shadowEnv()`:

```js
function shadowEnv() {
  return {
    TELEGRAM_BOT_TOKEN: "",          // CRITICAL: silence Telegram
    JELLY_AUTH_TOKEN: "",            // silence JellyJelly
    GENIE_TOOLS_READONLY: "1",       // engine-side hint
    JELLYCLAW_MCP_CONFIG: "/Users/gtrush/Downloads/Jelly-Claw/genie-server/config/mcp-shadow.json", // read-only Playwright variant
  };
}
```

Create `genie-server/config/mcp-shadow.json` — same as `mcp.json` but Playwright instance points to a separate CDP port (e.g. 9333) and only exposes `browser_snapshot`, `browser_take_screenshot` (no click/type/navigate).

ASSERT in code (throw if false): before spawning shadow, verify `env.TELEGRAM_BOT_TOKEN === ""` and `env.JELLY_AUTH_TOKEN === ""`. A leak here spams users.

### Step B — Diff harness

Create `genie-server/scripts/shadow-diff.mjs`:

For each `*.primary.ndjson` + `*.shadow.ndjson` pair:
- Count events by type (`tool_use`, `text`, `result`)
- Tool-name sequence comparison (Levenshtein on the array)
- Token totals diff
- Wall-clock latency diff
- Final assistant text Levenshtein
- Final cost diff (must be within 5%)

Output: `*.diff.json` per pair + a daily aggregate.

Create `genie-server/scripts/shadow-report.mjs`:

Aggregates today's `*.diff.json` files into a markdown report and posts to a private Telegram channel (env `SHADOW_REPORT_CHAT_ID`).

Add launchd plist `genie-server/launchd/com.jellygenie.shadow-report.plist` that runs `shadow-report.mjs` daily at 09:00.

### Step C — Tool-parity smoke harness

Create `genie-server/scripts/parity-smoke.mjs`:

Sequentially dispatches identical wishes through both engines (using the override flag, NOT shadow), captures output, asserts equivalence on:

| Wish | Asserts |
|---|---|
| "say the word pong" | both contain "pong" |
| "list /tmp top 3 files" | both ran Bash with `ls`, both returned ≥1 line |
| "create file /tmp/jellytest.txt with content 'hi'" | both ran Write, file exists after |
| "fetch https://example.com title" | both ran WebFetch, both contain "Example Domain" |
| "edit /tmp/jellytest.txt to say 'hello'" | both ran Edit, file content == 'hello' |
| "use playwright to take screenshot of example.com" | both invoked Playwright MCP |
| "create a 3-step todo about lunch" | both invoked TodoWrite with 3 items |

Each assertion failure → red ✗ + diff. Pass rate must be 100% before promotion.

Run:
```bash
ANTHROPIC_API_KEY=<REDACTED_API_KEY> \
GENIE_JELLYCLAW_BIN=/Users/gtrush/Downloads/jellyclaw-engine/engine/bin/jellyclaw \
node genie-server/scripts/parity-smoke.mjs
```

### Step D — Rollback runbook

Create `genie-server/RUNBOOK-PHASE-99.md`:

```md
## Engine flip
# Verified: `com.jellygenie.server` is registered (launchctl list | grep com.jellygenie.server).
launchctl setenv GENIE_ENGINE jellyclaw
launchctl kickstart -k gui/$UID/com.jellygenie.server
# verify: tail -f /tmp/jellygenie-logs/launchd.out.log → first dispatch shows engine=jellyclaw

## Rollback (one command)
launchctl setenv GENIE_ENGINE claude
launchctl kickstart -k gui/$UID/com.jellygenie.server
# verify: next dispatch shows engine=claude. Test wish completes. Telegram receipt arrives.

## Disable fallback (after 2 weeks clean)
launchctl setenv GENIE_ENGINE_FALLBACK 0

## If the service label resolves to a different ID on this box
# Sanity check before kickstart:
#   launchctl list | grep com.jellygenie.server
# If absent but `com.genie.server` exists, that's the old parallel deployment —
# confirm which one wraps /Users/gtrush/Downloads/Jelly-Claw/genie-server by
# inspecting the ProgramArguments in both plists under ~/Library/LaunchAgents/.
```

### Step E — Promotion checklist

Create `genie-server/PROMOTION-CHECKLIST.md`:

- [ ] 7+ days of shadow with ≥50 real wishes
- [ ] Daily diff aggregates show < 5% cost variance, < 10% latency variance
- [ ] Final-text Levenshtein median < 50 chars (text doesn't have to be identical, but must be coherent)
- [ ] Zero schema-parse failures in shadow logs
- [ ] Tool sequence matches in ≥ 90% of dispatches (allow some prompt-driven divergence)
- [ ] Parity smoke 100% pass rate
- [ ] All 7 manual canary dispatches green
- [ ] Telegram alerts armed (jellyclaw error rate >5%, P95 latency >1.5×, fallback >2/hour)

Sign-off block at bottom — date + observer signature.

## Tests

- `node --test genie-server/scripts/shadow-diff.test.mjs` — diff math.
- Manual: trigger one shadow run, verify `*.shadow.ndjson` exists, no Telegram message arrived from shadow.
- Manual: tamper with `shadowEnv()` to leave TELEGRAM_BOT_TOKEN set; assertion must fire and abort spawn.

## Operational steps after this prompt (no more code)

1. **Day 0** — Set `GENIE_ENGINE=shadow` in launchctl. Watch first 5 wishes.
2. **Day 1-7** — Daily 5-minute review of shadow report (Telegram). Note any divergences.
3. **Day 7** — Run `parity-smoke.mjs` end-to-end. Run promotion checklist.
4. **Day 8** — Set `GENIE_ENGINE=jellyclaw` (canary on @george.tru only first via per-clip metadata for 48h, then global).
5. **Day 22** — If stable: set `GENIE_ENGINE_FALLBACK=0`, then delete claude path in next prompt.

## Done when

- Shadow mode runs without leaking side effects (verified via tampered-env assertion test)
- Parity smoke green for all 7 wishes
- RUNBOOK + PROMOTION-CHECKLIST committed
- COMPLETION-LOG.md (in jellyclaw-engine) updated with shadow-mode go-live timestamp
- Phase 99 marked ✅ in `phases/PHASE-99-unfucking.md` frontmatter once cutover lands

<!-- BEGIN SESSION CLOSEOUT -->
<!-- Tag commit `phase-99-shadow-ready`. -->
<!-- After cutover succeeds (~3 weeks out), open Phase 100 to delete the claude path entirely. -->
<!-- END SESSION CLOSEOUT -->
