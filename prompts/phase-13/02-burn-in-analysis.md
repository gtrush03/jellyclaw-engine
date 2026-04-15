# Phase 13 — Make jellyclaw default — Prompt 02: 72h burn-in analysis + close phase

**When to run:** ≥72 hours after Prompt 01 of Phase 13 landed (check the timestamp in COMPLETION-LOG.md "burn-in started at" note).
**Estimated duration:** 3-4 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `13`
- `<phase-name>` → `Make jellyclaw default in Genie`
- `<sub-prompt>` → `02-burn-in-analysis`
<!-- END SESSION STARTUP -->

## Research task

1. Read `phases/PHASE-13-default-in-genie.md` Steps 4-6 (the burn-in monitoring loop, the rollback trigger, the final report contract).
2. Read `integration/GENIE-INTEGRATION.md` §11 (acceptance gate) and §8 (rollback if fail).
3. Read `BURN-IN-REPORT.md` template from Prompt 01 — you will fill it in this session.
4. Confirm 72h have actually passed since the flip: `awk -F'"' '/burn-in started at/ {print $4}' /Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` and compute delta. If <72h, STOP and tell the user to come back later.

## Implementation task

Run the full burn-in analysis pipeline against `~/.jellyclaw/metrics.jsonl` and `~/.jellyclaw/shadow-diff/`, write `BURN-IN-REPORT.md`, and call go/no-go on Phase 13.

Pass thresholds (per `phases/PHASE-13-default-in-genie.md` Step 4 + this prompt's spec):

| Metric | Threshold | Source |
|---|---|---|
| Semantic equivalence (LLM judge on shadow pairs) | **≥ 95%** | shadow-diff/ |
| Cost drift jellyclaw vs claurst-shadow | **±15%** (jellyclaw can be up to 15% pricier OR 15% cheaper) | metrics.jsonl |
| Error rate jellyclaw vs claurst-shadow | **≤ 1.2× baseline** | metrics.jsonl `status:error` |
| Latency p50 / p95 | ≤ +20% (soft, advisory) | metrics.jsonl `duration_ms` |
| Zero P0 stack traces | true | log scan |
| Rollback drill executed once | true | manual |

If ALL hard thresholds pass → mark Phase 13 ✅, retire Claurst from default arg builders (defer the actual deletion to a follow-up phase).
If ANY hard threshold fails → execute rollback per `docs/rollback.md`, file per-class issues, do NOT close phase.

### Files to create/modify

- `/Users/gtrush/Downloads/genie-2.0/scripts/burn-in-analyze.mjs` — the analysis tool
- `/Users/gtrush/Downloads/genie-2.0/BURN-IN-REPORT.md` — populated report
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — Phase 13 ✅ if pass
- `/Users/gtrush/Downloads/jellyclaw-engine/STATUS.md` — final disposition + any issues filed
- (conditional, on fail) one GitHub issue per failure class

### Shell commands — 72h monitoring snapshot

```bash
cd /Users/gtrush/Downloads/genie-2.0

# 1. Confirm metrics density (≥ ~30 wishes minimum for statistical sanity)
wc -l ~/.jellyclaw/metrics.jsonl
# Per-engine wish counts (last 72h)
node -e "
  const fs=require('fs');
  const cutoff=Date.now()-72*3600*1000;
  const rows=fs.readFileSync(process.env.HOME+'/.jellyclaw/metrics.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const window=rows.filter(r=>r.phase==='end'&&new Date(r.ts).getTime()>=cutoff);
  const byE=window.reduce((a,r)=>{(a[r.engine]??=[]).push(r);return a},{});
  for (const [e,xs] of Object.entries(byE)) console.log(e, 'wishes=',xs.length);
"

# 2. Run the analyzer (writes BURN-IN-REPORT.md)
node scripts/burn-in-analyze.mjs --window-hours 72 --report BURN-IN-REPORT.md

# 3. Manually scan stack traces from the burn-in window
grep -E "(unhandled|TypeError|ReferenceError|EACCES|ECONNREFUSED)" /tmp/genie-logs/launchd.out.log \
  | awk -v cutoff=$(date -v-72H -u +%FT%TZ) '$0 >= cutoff' \
  | head -50

# 4. Shadow-diff semantic equivalence (LLM judge over 30 random pairs)
node scripts/burn-in-analyze.mjs --judge --pairs 30 --shadow-dir ~/.jellyclaw/shadow-diff/

# 5. Rollback drill — practice on staging or a local instance
GENIE_ENGINE=claurst node -e "import('./src/core/dispatcher.mjs').then(m=>m.dispatchToClaude({transcript:'Genie say hi',clipTitle:'rollback-drill',creator:'g',clipId:'rollback-1',keyword:'genie'}))"
# Confirm it worked, then revert default in env (do NOT touch source code)
unset GENIE_ENGINE  # back to jellyclaw default
launchctl kickstart -k gui/$(id -u)/com.genie.server
sleep 3 && tail -3 /tmp/genie-logs/launchd.out.log
```

### Analysis logic for `scripts/burn-in-analyze.mjs`

```js
// Input: metrics.jsonl + shadow-diff/
// Compute per-engine within the 72h window:
//   N, success_rate, error_rate, p50_ms, p95_ms, mean_cost, total_cost
// Compute deltas jellyclaw vs claurst-shadow:
//   cost_drift_pct, err_rate_ratio, latency_p50_pct, latency_p95_pct
// Sample ≤30 successful pairs, run LLM judge (Haiku) on (jellyclaw_result, claurst_result):
//   prompt: "Are these two assistant outputs functionally equivalent for the user's wish? 1-5 score."
//   pass if score ≥ 4.
//   semantic_equivalence_pct = #pass / #judged
// Apply thresholds, write report, exit code 0 (PASS) or 1 (FAIL).
```

### `BURN-IN-REPORT.md` template (the report you write)

```markdown
# Jellyclaw Burn-In Report — <YYYY-MM-DD>

**Window:** <start ts> → <end ts>  (72.0 hours)
**Wishes processed (jellyclaw primary):** <N>
**Wishes processed (claurst shadow):** <N>
**Verdict:** <PASS | FAIL>

## Headline metrics

| Metric                       | jellyclaw | claurst (shadow) | Δ        | Threshold | Status |
|------------------------------|-----------|------------------|----------|-----------|--------|
| Wishes (N)                   | <n>       | <n>              | -        | -         | -      |
| Success rate                 | <%>       | <%>              | <pp>     | ≥ baseline | <🟢/🔴> |
| Error rate                   | <%>       | <%>              | <ratio>× | ≤ 1.2×    | <🟢/🔴> |
| Mean cost / wish             | $<x>      | $<y>             | <±%>     | ±15%      | <🟢/🔴> |
| p50 latency (ms)             | <ms>      | <ms>             | <±%>     | ≤ +20%    | <🟢/🔴> |
| p95 latency (ms)             | <ms>      | <ms>             | <±%>     | ≤ +20%    | <🟢/🔴> |
| Semantic equivalence (LLM)   | <%>       | -                | -        | ≥ 95%     | <🟢/🔴> |
| P0 stack traces              | <count>   | -                | -        | 0         | <🟢/🔴> |
| Rollback drill               | done <ts> | -                | -        | done once | <🟢/🔴> |

## Failure classes (only if FAIL)

- **<class name>** — <count> wishes affected. Example transcript: `<wish_id>`. Trace: `traces/dispatch-jellyclaw-<ts>.jsonl`. Filed: <issue link>. Owner: <name>. ETA: <date>.

## Cost ledger

- Total jellyclaw spend (72h): $<x>
- Total shadow spend (72h, sampled): $<y>
- Projected monthly at this rate: $<z>
- Vs baseline Claurst monthly: $<b> (<±%>)

## Decision

<one paragraph: ship / rollback / partial>

## Next steps

- <If PASS> Mark Phase 13 ✅. Schedule Phase 14 observability work. Plan Claurst code-path retirement (W4 of GENIE-INTEGRATION).
- <If FAIL> Execute rollback per `docs/rollback.md`. File issues. Re-attempt burn-in after fixes (ETA: <date>).
```

### Expected output

- `BURN-IN-REPORT.md` populated, committed to `genie-2.0`.
- If PASS: `COMPLETION-LOG.md` marks Phase 13 ✅.
- If FAIL: rollback executed, server confirmed running on Claurst, ≥1 GitHub issue per failure class linked from the report.

### Tests to add

- `/Users/gtrush/Downloads/genie-2.0/test/burn-in-analyze.test.mjs` — fixture metrics with known distributions, asserts the analyzer computes p50/p95/drift correctly and applies thresholds.

### Verification

```bash
cd /Users/gtrush/Downloads/genie-2.0
test -s BURN-IN-REPORT.md
grep -E "^\\*\\*Verdict:\\*\\* (PASS|FAIL)" BURN-IN-REPORT.md
node --test test/burn-in-analyze.test.mjs
# If PASS:
grep "Phase 13" /Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md | grep -q "✅"
# If FAIL:
echo $GENIE_ENGINE   # should be 'claurst' OR unset with .env containing GENIE_ENGINE=claurst
```

This is the FINAL prompt of Phase 13. On PASS, mark Phase 13 ✅ per the closeout template. On FAIL, leave 🔄 In progress and fully populate STATUS.md blockers.

### Common pitfalls

- **Sample size:** if <30 wishes per engine in the window, the success-rate and cost-drift numbers are noise. Extend the burn-in by another 24h before calling — don't ship on 12 wishes.
- **Cache hits skew cost low.** Anthropic's prompt cache means repeat-pattern wishes (Genie has many) cost a fraction of a fresh run. Compare cache-hit rates between engines too — if jellyclaw's cache hit rate is much lower, that explains the cost drift and is a fixable problem (not an inherent regression).
- **LLM judge non-determinism:** at temperature 0 it's still ±0.1 variance per call. Run the judge 3× per pair and take the median; a single 3/5 shouldn't fail the pair.
- **Shadow replay drift:** Claurst's shadow ran on the same transcript but at a slightly different time, so the WORLD changed (web pages updated, Stripe nonces rotated). For wishes touching live state, mark "non-comparable" and exclude from the equivalence sample.
- **Rollback drill not actually performed:** make sure you ACTUALLY ran a Claurst wish during the 72h, not just inspected the runbook. If you skipped it, that fails the gate — schedule it and re-run analysis.
- **The "retire Claurst" question:** PASS does NOT mean delete the Claurst code path now. Keep both arg builders through W4 (per GENIE-INTEGRATION §10). Phase 13 closure just confirms jellyclaw is the default and reliable.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `13`
- `<phase-name>` → `Make jellyclaw default in Genie`
- `<sub-prompt>` → `02-burn-in-analysis`
- This IS the final prompt of Phase 13. On PASS mark Phase 13 ✅. On FAIL leave 🔄 and document.
<!-- END SESSION CLOSEOUT -->
