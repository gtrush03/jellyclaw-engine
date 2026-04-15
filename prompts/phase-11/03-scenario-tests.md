# Phase 11 — Testing harness — Prompt 03: 15 scenario tests + LLM judge

**When to run:** After Prompt 02 lands and integration tier is green.
**Estimated duration:** 8-10 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `11`
- `<phase-name>` → `Testing harness`
- `<sub-prompt>` → `03-scenario-tests`
<!-- END SESSION STARTUP -->

## Research task

1. Read `test/canonical-wishes.json` end to end — all 12 wishes are scenarios 1-12.
2. Read `test/TESTING.md` §5 (scenario assertions), §8 (Chrome on port 9333), §10 (cost reconciliation), §11 (LLM judge rubric).
3. Read `integration/GENIE-INTEGRATION.md` §9 — `sweetgreen-order`, `linkedin-dm-5`, `schedule-calendly`, `tweet-plus-landing` exit one click before the destructive action when `dry_run_allowed: true`.
4. Skim `engine/src/permissions/dry-run.ts` (or whatever Phase 08 named it). If absent, file an issue and `it.todo` the dry-run cases.

## Implementation task

Land 15 scenario tests: the 12 canonical wishes plus 3 edge cases (`malformed-wish`, `mcp-down`, `budget-trip` — TESTING.md §5). Runs against **live Anthropic** at temperature=0, but cached: each scenario hashes `(wish_id, model, system_prompt_sha256)` and reuses cached `stream-json` from `test/.cache/` if present. Only first run costs money — cap total per-run at `$0.20`.

Dry-run wishes set `JELLYCLAW_DRY_RUN=1`. The engine MUST refuse the final destructive `browser_click` matched by selector substring (`place order`, `send message`, `confirm booking`, `post tweet`). Asserted via the trace.

LLM judge (`test/helpers/llm-judge.mjs`): one Haiku call per scenario, scores 1-5 against the rubric in TESTING.md §11. Pass threshold ≥4. Failure prints rationale.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/coffee-landing.test.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/sweetgreen-order.dryrun.test.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/linkedin-dm-5.dryrun.test.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/research-topic.test.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/stripe-49.test.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/tweet-plus-landing.dryrun.test.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/schedule-calendly.dryrun.test.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/vercel-deploy.test.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/github-issues-summary.test.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/multi-file-refactor.test.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/factcheck-3-subagents.test.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/firebase-todo-app.test.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/malformed-wish.test.mjs` (edge 13)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/mcp-down.test.mjs` (edge 14)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/scenario/budget-trip.test.mjs` (edge 15)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/llm-judge.mjs`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/scenario-cache.mjs` — sha256 keying, `test/.cache/<key>.jsonl`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/start-test-chrome.mjs` (port 9333)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/stop-test-chrome.mjs`

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
# Boot test Chromium on 9333 (NEVER 9222 — that's George's logged-in browser)
node test/helpers/start-test-chrome.mjs --port 9333
# First run: live API, populates cache. Budget cap enforced.
SCENARIO_BUDGET_USD=0.20 ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  bun run test:scenario
# Subsequent runs: cache hits, $0 spend.
bun run test:scenario
# Tear down
node test/helpers/stop-test-chrome.mjs
```

### Expected output

- 15 scenarios pass.
- First (uncached) run total spend ≤ $0.20.
- Three dry-runs verified: traces contain a `tool_use_start` for the destructive selector AND a `tool_use_error` with `code: "E_DRY_RUN_REFUSED"`. No matching `tool_use_result` confirming the action.
- LLM judge median score ≥4 across the 15.

### Tests to add

15, as listed. Each test asserts:
1. Final `result` event present (except `malformed-wish` which asserts none + a polite refusal in `assistant_text`).
2. `expected_tools ⊂ actual_tools` (subset; jellyclaw may invoke more).
3. `expected_result_shape` matches: `url` → `^https?://`; `payment_url` → `^https://buy\.stripe\.com/`; `order_id` → `tool_use_result.confirmation_id` exists; `screenshots` → ≥N base64 images in trace; `text` → ≥200 chars.
4. Within `timeout_seconds` and `max_cost_usd`.
5. LLM judge ≥4.

### Verification

```bash
bun run test:scenario --reporter=verbose | tee /tmp/scen-run.log
grep -c '✓' /tmp/scen-run.log        # 15
node test/helpers/cost-accountant.mjs --cap 0.20
```

### Common pitfalls

- **Cache key must include the system prompt sha256** — Phase 02 prompt changes invalidate caches. Re-record on miss.
- **Dry-run enforcement lives in the engine**, not the test. Confirm `engine/src/permissions/dry-run.ts` exists and refuses matched selectors. If it doesn't, file an issue and skip with `it.todo`.
- **NEVER point MCP at port 9222.** Tests boot Chromium on 9333 with a throwaway `--user-data-dir`. Polluting :9222 sends actual LinkedIn DMs / orders actual food.
- **Temperature=0 has a non-determinism floor**. The LLM judge tolerates phrasing variance via the rubric, but tool sequences must be subset-matched, not order-equal.
- **`malformed-wish`:** the engine should not enter a tool loop on an empty transcript. If it does, that's a Phase 02 bug — file an issue.
- **Subagent scenarios (#10, #11)** depend on patch #001 firing hooks. If hooks don't fire, the LLM judge may still pass but Prompt 04's comparison harness will diverge — note in `STATUS.md`.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `11`
- `<phase-name>` → `Testing harness`
- `<sub-prompt>` → `03-scenario-tests`
- Do NOT mark Phase 11 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
