# Phase 13 — Make jellyclaw default — Prompt 01: Flip default + shadow mode + monitoring

**When to run:** Phase 12 marked ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 4-5 hours (sets up the 72h burn-in)
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `13`
- `<phase-name>` → `Make jellyclaw default in Genie`
- `<sub-prompt>` → `01-default-flip-and-shadow`
<!-- END SESSION STARTUP -->

## Research task

1. Read `phases/PHASE-13-default-in-genie.md` end to end (Steps 1-6).
2. Read `integration/GENIE-INTEGRATION.md` §8 (rollback) and §10 W3 (default with shadow diff).
3. Read `test/TESTING.md` §13 (48h burn-in protocol — we extend to 72h here).
4. Confirm Phase 12 acceptance was met by re-reading `COMPLETION-LOG.md` and the parity REPORT.md from Phase 12 Prompt 04. If it wasn't, STOP.

## Implementation task

Three deliverables:
1. **Flip the default** in `genie-2.0/src/core/dispatcher.mjs` from `process.env.GENIE_ENGINE || 'claurst'` to `process.env.GENIE_ENGINE || 'jellyclaw'`. One line.
2. **Shadow mode**: every successful jellyclaw production wish triggers a post-hoc Claurst replay against the same transcript on a second worker pool, writing both traces to `~/.jellyclaw/shadow-diff/<wish_id>.json` for analysis in Prompt 02.
3. **Monitoring plumbing**: structured log line on every wish start + end (`engine`, `wish_id`, `duration_ms`, `input_tokens`, `output_tokens`, `cost_usd`, `status`, `tool_count`) into `~/.jellyclaw/metrics.jsonl`. Plus a 3-panel local console dashboard (`scripts/dashboard.mjs`) showing live cost / latency p50-p95 / error rate from the last 100 wishes.

### Files to create/modify

- `/Users/gtrush/Downloads/genie-2.0/src/core/dispatcher.mjs` — one-line default flip + metrics emission
- `/Users/gtrush/Downloads/genie-2.0/src/core/metrics.mjs` — `recordWish(start|end, …)` writing JSONL
- `/Users/gtrush/Downloads/genie-2.0/src/core/shadow-replay.mjs` — post-hoc Claurst worker
- `/Users/gtrush/Downloads/genie-2.0/scripts/dashboard.mjs` — terminal dashboard (no deps; use `process.stdout.write` + ANSI)
- `/Users/gtrush/Downloads/genie-2.0/docs/rollback.md` — runbook for the one-line revert
- `/Users/gtrush/Downloads/genie-2.0/BURN-IN-REPORT.md` — empty template, populated in Prompt 02
- `/Users/gtrush/Downloads/genie-2.0/examples/com.genie.shadow-replay.plist` — LaunchAgent (optional, only if shadow load is high enough to need its own worker)

### Implementation notes

**Default flip:**
```js
const GENIE_ENGINE = (process.env.GENIE_ENGINE || 'jellyclaw').toLowerCase();
```

**Metrics emission** in `dispatcher.mjs` — wrap `dispatchToClaude` so the start line fires immediately and the end line fires from the existing exit handler. Schema:
```json
{"ts":"2026-..","engine":"jellyclaw","wish_id":"<clipId>","phase":"end","duration_ms":42000,"input_tokens":12345,"output_tokens":2345,"cost_usd":1.42,"status":"success","tool_count":12,"session_id":"01j3..."}
```

**Shadow replay** is fire-and-forget after a successful jellyclaw wish. Spawn `claurst -p` with the same transcript+system prompt+model class, capture stream-json to `~/.jellyclaw/shadow-diff/<wish_id>-claurst.jsonl`, alongside the original `~/.jellyclaw/shadow-diff/<wish_id>-jellyclaw.jsonl`. Skip if `GENIE_DISABLE_SHADOW=1` (kill switch).

Hard cap: shadow replays run on a queue with concurrency 1 and a $50/day cost cap (read from `~/.jellyclaw/shadow-cost-today.txt`, reset by cron). If cap hit, log `shadow.skipped: cost_cap_today` and move on.

**Dashboard** (`scripts/dashboard.mjs`): tail `~/.jellyclaw/metrics.jsonl`, recompute every 5s:
```
JELLYCLAW BURN-IN DASHBOARD                      <UTC ts>
─────────────────────────────────────────────────────────
Engine        Wishes  P50 ms  P95 ms  Avg $   Errors  Err%
jellyclaw       N=42  31200   58400   1.18    1       2.4%
claurst (sh)    N=42  29800   55100   1.04    0       0.0%
─────────────────────────────────────────────────────────
Δlatency p50: +4.7%   Δlatency p95: +6.0%   Δcost: +13.5%   Δerr: +2.4 pp
24h spend: $73.20   |   72h spend so far: $X
Status: 🟢 within thresholds  (≥95% equiv, ≤±15% cost drift, ≤1.2× err rate)
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/genie-2.0
# Apply the one-line flip
git diff src/core/dispatcher.mjs   # confirm: only the default literal changed
# Bring the metrics file into existence
mkdir -p ~/.jellyclaw/shadow-diff && touch ~/.jellyclaw/metrics.jsonl
# Restart server to pick up the new default
launchctl unload ~/Library/LaunchAgents/com.genie.server.plist
launchctl load   -w ~/Library/LaunchAgents/com.genie.server.plist
sleep 3 && tail -3 /tmp/genie-logs/launchd.out.log    # must show "Polling JellyJelly..."
# Smoke a tiny wish so we get a metrics line
node -e "import('./src/core/dispatcher.mjs').then(m=>m.dispatchToClaude({transcript:'Genie say hi',clipTitle:'smoke',creator:'g',clipId:'smoke-1',keyword:'genie'}))"
tail -5 ~/.jellyclaw/metrics.jsonl
# Boot the dashboard in another terminal
node scripts/dashboard.mjs
```

### Expected output

- `dispatcher.mjs` default flipped (verified by `GENIE_ENGINE` unset → `jellyclaw`).
- `~/.jellyclaw/metrics.jsonl` accumulates wish records.
- Shadow replays appear in `~/.jellyclaw/shadow-diff/` paired by wish_id.
- Dashboard refreshes every 5s and renders the table above.
- `docs/rollback.md` documents the one-line revert (set `GENIE_ENGINE=claurst` in `.env`, restart server) plus the LaunchAgent kickstart command and the post-rollback issue-filing checklist.

### Tests to add

- `/Users/gtrush/Downloads/genie-2.0/test/metrics.test.mjs` — mock dispatch, assert start+end lines, schema valid.
- `/Users/gtrush/Downloads/genie-2.0/test/shadow-replay.test.mjs` — given a jellyclaw success, asserts a Claurst replay queued and trace files created.
- `/Users/gtrush/Downloads/genie-2.0/test/dashboard.test.mjs` — feed 10 fixture metrics lines, assert the rendered dashboard string contains expected p50/p95/cost figures.

### Verification

```bash
cd /Users/gtrush/Downloads/genie-2.0
node --test test/metrics.test.mjs test/shadow-replay.test.mjs test/dashboard.test.mjs
# 24h check (run this command tomorrow):
node scripts/dashboard.mjs --snapshot
# Should show ≥10 wishes through jellyclaw with shadow pairs.
```

### Common pitfalls

- **Dispatcher restart is required** for the env-var default change to take effect inside LaunchAgent context. `launchctl kickstart -k gui/$(id -u)/com.genie.server` is the snappier alternative to unload/load.
- **Shadow replay can DOUBLE cost.** The $50/day cap is real — if hit, shadow goes silent and you lose visibility. Mitigate by sampling: replay every 3rd wish, not every wish. Add `GENIE_SHADOW_SAMPLE_RATE=0.33`.
- **`dispatch-jellyclaw-*.jsonl` and `dispatch-claurst-*.jsonl`** trace files (from Phase 12 Prompt 01 §2.9) live in `traces/`, separate from `shadow-diff/`. Don't confuse the two.
- **Metrics schema must be locked NOW.** Once 72h of data accrues in this format, changing the schema invalidates all dashboards and the burn-in analysis in Prompt 02. Treat `metrics.mjs` as a public API.
- **Rollback runbook must be tested before going live.** Practice: set `GENIE_ENGINE=claurst`, restart, run a smoke wish, confirm Claurst path. Then revert. Document the elapsed time — should be <60s.
- **Shadow replay must NOT consume the same Chrome :9222.** Either route shadow replays to a dedicated CDP port (e.g. spawn a second Chrome on :9223 via a sidecar plist) OR queue them serially after the primary wish completes (chosen default — concurrency 1).

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `13`
- `<phase-name>` → `Make jellyclaw default in Genie`
- `<sub-prompt>` → `01-default-flip-and-shadow`
- Do NOT mark Phase 13 complete. The 72h burn-in starts now; Prompt 02 closes the phase. Append a session-log row noting "burn-in started at <ts>".
<!-- END SESSION CLOSEOUT -->
