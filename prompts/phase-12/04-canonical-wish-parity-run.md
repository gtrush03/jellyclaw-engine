# Phase 12 — Genie integration behind flag — Prompt 04: Canonical 12-wish parity run + go/no-go

**When to run:** After Prompts 01-03 of Phase 12 land.
**Estimated duration:** 6-8 hours (mostly wall-clock waiting on real wishes)
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `12`
- `<phase-name>` → `Genie integration behind flag`
- `<sub-prompt>` → `04-canonical-wish-parity-run`
<!-- END SESSION STARTUP -->

## Research task

1. Read `phases/PHASE-12-genie-integration.md` Steps 9, 10, 11 (canonical wishes, compare harness, run-analyze-iterate).
2. Read `integration/GENIE-INTEGRATION.md` §9 (canonical wish list with dry-run flags) and §11 (acceptance gate).
3. Read `test/canonical-wishes.json` for the wish text and budgets.
4. Re-read this prompt's "Common pitfalls" before executing — running 24 live wishes can torch $50+ if budgets misfire.

## Implementation task

Run all 12 canonical wishes through `genie-2.0` twice — once with `GENIE_ENGINE=claurst` (baseline), once with `GENIE_ENGINE=jellyclaw` — produce a parity report at `/Users/gtrush/Downloads/genie-2.0/test/canonical-wishes/REPORT.md`, and call go/no-go for Phase 12 acceptance.

Set `GENIE_ENGINE=claurst` (default for now, per Phase 12 spec). Phase 13 flips the default.

### Files to create/modify

- `/Users/gtrush/Downloads/genie-2.0/test/canonical-wishes/` — one `.md` per wish with the transcript
- `/Users/gtrush/Downloads/genie-2.0/test/canonical-wishes/REPORT.md` — the comparison report (template at end)
- `/Users/gtrush/Downloads/genie-2.0/test/compare.mjs` — runner that drives the dispatcher twice per wish, captures traces, diffs
- `/Users/gtrush/Downloads/genie-2.0/test/parity-thresholds.json` — `{events_delta_pct: 20, cost_delta_pct: 25, judge_score: 4}`
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — mark Phase 12 ✅ if go decision

### Pre-flight checklist (DO THESE BEFORE SPAWNING ANYTHING)

```bash
# 1. Confirm both binaries
which claurst && claurst --version
which jellyclaw && jellyclaw --version
# 2. Confirm config
ls -l ~/.jellyclaw/settings.json ~/.jellyclaw/skills
# 3. Confirm Chrome on :9222 (real) is up — needed for browser wishes
curl -s http://127.0.0.1:9222/json/version | head -c 100
# 4. Confirm Telegram works (test echo from each engine)
GENIE_ENGINE=claurst   node -e "import('./src/core/telegram.mjs').then(m=>m.sendMessage('parity test claurst',  {plain:true}))"
GENIE_ENGINE=jellyclaw node -e "import('./src/core/telegram.mjs').then(m=>m.sendMessage('parity test jellyclaw',{plain:true}))"
# 5. Set hard caps for the run
export GENIE_MAX_BUDGET_USD=8        # per-wish ceiling (matches highest canonical max_cost_usd)
export GENIE_PARITY_TOTAL_CAP_USD=80 # entire 24-wish run
# 6. Dry-run mode for irreversible wishes (sweetgreen, linkedin-dm, calendly, tweet)
export JELLYCLAW_DRY_RUN=1
```

### Shell commands (the actual run)

```bash
cd /Users/gtrush/Downloads/genie-2.0
node test/compare.mjs --wishes test/canonical-wishes/ --engines claurst,jellyclaw \
  --thresholds test/parity-thresholds.json --report test/canonical-wishes/REPORT.md
# Watch live
tail -f /tmp/genie-logs/launchd.out.log
# After completion, audit:
grep -c '| PASS |' test/canonical-wishes/REPORT.md   # target: 12
grep -c '| FAIL |' test/canonical-wishes/REPORT.md   # tolerate: ≤ 2 with documented issues
```

### `compare.mjs` outline

For each wish:
1. Spawn `dispatcher.dispatchToClaude(wishObj)` with `GENIE_ENGINE=claurst`. Capture trace path, final `result`, cost, duration, tool sequence.
2. Wait for completion. Reset state.
3. Same with `GENIE_ENGINE=jellyclaw`.
4. Diff using `test/comparison/diff.mjs` (from Phase 11 Prompt 04 — symlink/import).
5. Write a row to `REPORT.md`.
6. If running total cost exceeds `GENIE_PARITY_TOTAL_CAP_USD`, abort and report partial.

### Expected REPORT.md format

```markdown
# Canonical Wish Parity Report — <date>

Engines: claurst <version> vs jellyclaw <version>
Total cost: $<X> (cap $80)
Total wall: <Y>s
Verdict: <GO | NO-GO>

| # | wish_id | claurst $ | jellyclaw $ | Δ$% | claurst tools | jellyclaw tools | Δevt% | judge | verdict | notes |
|---|---------|-----------|-------------|-----|---------------|-----------------|-------|-------|---------|-------|
| 1 | coffee-landing | 1.42 | 1.61 | +13% | 12 | 14 | +17% | 5/5 | PASS | extra browser_snapshot |
| 2 | sweetgreen-order | 0.88 | 0.95 | +8%  | 22 | 24 | +9%  | 4/5 | PASS | dry-run refused at correct selector |
… (12 rows)

## Triage
- Wish #N: <delta classification> → <fix in jellyclaw> | <accept and document> | <issue link>
```

### Acceptance gate (per Phase 12 spec)

GO if **all** of:
- ≥ 10 of 12 wishes PASS (max 2 FAIL with filed issues + workarounds).
- No wish jellyclaw invoked a tool Claurst lacked permission for.
- Skills/agents discovered from unified `~/.jellyclaw/skills` path.
- Playwright MCP works via CDP:9222 on jellyclaw (smoke wish #2 or #3).
- Zero `unknown event type` log lines in any jellyclaw trace.
- Total parity-run cost ≤ $80.

NO-GO if any threshold exceeded → file an issue per failing wish, do NOT mark Phase 12 ✅, schedule a fix-and-re-run before Phase 13.

### Tests to add

- `/Users/gtrush/Downloads/genie-2.0/test/canonical-wishes-smoke.test.mjs` — runs only wish #1 (coffee-landing) on both engines; gated by `RUN_LIVE_PARITY=1` for nightly.

### Verification

```bash
cd /Users/gtrush/Downloads/genie-2.0
test -s test/canonical-wishes/REPORT.md
grep -E "^Verdict: (GO|NO-GO)" test/canonical-wishes/REPORT.md
# Audit traces
ls -la traces/dispatch-jellyclaw-* | wc -l   # ≥ 12
ls -la traces/dispatch-claurst-*   | wc -l   # ≥ 12
# Confirm zero parser breakage
grep -L "unknown event type" traces/dispatch-jellyclaw-*.jsonl | wc -l
# (= count of jellyclaw traces; means none contained the string)
```

If verdict is GO, this is the FINAL prompt of Phase 12 — mark Phase 12 ✅ in `COMPLETION-LOG.md` per the closeout template.

### Common pitfalls

- **DRY_RUN is per-wish.** Even with `JELLYCLAW_DRY_RUN=1` exported globally, Claurst doesn't know that flag. For wishes 2/3/6/7, you MUST manually short-circuit Claurst's destructive click step OR accept that Claurst will actually order the food / send the DM. Recommended: manually log out of Sweetgreen + LinkedIn in the persistent Chrome profile before running, so Claurst hits a login wall and aborts.
- **Cost caps run per-engine, not total** — `GENIE_MAX_BUDGET_USD=8` means each engine can spend $8/wish, so a single wish can cost up to $16 across the pair. Plan accordingly.
- **Telegram flood:** 24 live wishes = ~200 Telegram messages. Mute the chat or temporarily set `TELEGRAM_BOT_TOKEN=""` and rely on traces only.
- **Playwright MCP collisions:** both engines target CDP:9222. Run them sequentially, never in parallel — the persistent Chrome can only have one MCP-driven session at a time without state corruption.
- **Skills symlink must resolve from BOTH directions:** if Claurst writes a new skill mid-run, jellyclaw will see it via the symlink. That's intentional. If you see "skill not found" on the jellyclaw side, check `readlink ~/.jellyclaw/skills`.
- **Don't auto-flip the default to jellyclaw in this prompt.** That's Phase 13 Prompt 01. Leaving it as `claurst` keeps prod stable while Phase 13 rolls out.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `12`
- `<phase-name>` → `Genie integration behind flag`
- `<sub-prompt>` → `04-canonical-wish-parity-run`
- This IS the final prompt of Phase 12. If verdict is GO, mark Phase 12 ✅. If NO-GO, leave Phase 12 in 🔄 In progress and append blockers to STATUS.md.
<!-- END SESSION CLOSEOUT -->
