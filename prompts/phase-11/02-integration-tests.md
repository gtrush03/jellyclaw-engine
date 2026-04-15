# Phase 11 — Testing harness — Prompt 02: 20 integration tests

**When to run:** After Prompt 01 of Phase 11 lands and unit tier is green.
**Estimated duration:** 6-8 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `11`
- `<phase-name>` → `Testing harness`
- `<sub-prompt>` → `02-integration-tests`
<!-- END SESSION STARTUP -->

## Research task

1. Re-read `test/TESTING.md` §4 — the 20 integration cases enumerated there are the contract for this prompt.
2. Read `engine/src/server/http.ts` and `engine/src/cli.ts` (Phase 10) so the spawn helper boots the right entry point.
3. Read `integration/GENIE-INTEGRATION.md` §2.3 (provider validation) — provider failover test (#12) reproduces that behavior.
4. Audit `test/fixtures/anthropic-stubs/` from Prompt 01; you'll record additional stubs here.

## Implementation task

Add 20 integration tests that exercise a real spawned `jellyclaw run --print` subprocess against `msw`-intercepted Anthropic + OpenRouter endpoints. Real LLM calls are NOT made — every test runs against recorded `stream-json` fixtures so $0.00 is added to the ledger. Tier wall <3 minutes, retry=2.

A single CI integration run is hard-capped at **$5.00** as a defensive ceiling (we should be at $0). The cost ledger asserts spend<$0.05 at the end of the file; anything more means a test escaped to a real provider — fail loud.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/single-turn-bash.test.mjs` — case 1
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/single-turn-read.test.mjs` — case 2
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/single-turn-write.test.mjs` — case 3
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/single-turn-edit.test.mjs` — case 4
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/tool-glob.test.mjs` — case 5
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/tool-grep.test.mjs` — case 6
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/tool-webfetch.test.mjs` — case 7
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/tool-websearch.test.mjs` — case 8
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/tool-todowrite.test.mjs` — case 9
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/subagent-task.test.mjs` — case 10
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/mcp-browser.test.mjs` — case 11
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/provider-failover.test.mjs` — case 12 (529 → fallback)
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/cost-accounting.test.mjs` — case 13
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/resume.test.mjs` — case 14
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/hook-pretool.test.mjs` — case 15
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/hook-posttool.test.mjs` — case 16
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/stderr-jsonl.test.mjs` — case 17
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/max-turns.test.mjs` — case 18
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/max-cost.test.mjs` — case 19
- `/Users/gtrush/Downloads/jellyclaw-engine/test/integration/add-dir-containment.test.mjs` — case 20
- `/Users/gtrush/Downloads/jellyclaw-engine/test/fixtures/anthropic-stubs/*.jsonl` — recorded stream-json per case
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/record-anthropic.mjs` — one-off recorder script (gated by `RECORD=1`)

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
# 1. Record fixtures ONCE against real Anthropic — small Haiku calls, ~$0.30 total.
RECORD=1 ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  node test/helpers/record-anthropic.mjs --cases test/integration/_cases.json
# 2. Commit the fixtures.
git add test/fixtures/anthropic-stubs/
git commit -m "test(integration): record anthropic stubs for 20 cases"
# 3. Run the tier offline.
bun run test:integration
# 4. Cost ledger sanity:
node -e "const l=require('fs').readFileSync('test/.cost-ledger.jsonl','utf8').trim().split('\n').filter(Boolean);
         const s=l.reduce((a,j)=>a+(JSON.parse(j).cost_usd||0),0);
         if (s>0.05){console.error('LEAK:',s);process.exit(1)}"
```

### Expected output

- 20 tests pass; total wall <3 min on M-series Mac.
- Provider failover: msw returns 529 on the first Anthropic call; observes a single retry against OpenRouter mock; asserts `result.usage.fallback_used === true`.
- Resume: kill child after 3rd `tool_use_result`, respawn with `--session-id <id> --resume`, asserts no tool re-execution.
- `--max-cost-usd 0.01` exits with code 3 (jellyclaw budget convention) and logs `E_BUDGET_EXCEEDED`.

### Tests to add

20 files as above. Each: 1 `describe` + 1-3 `it`s. Total `it` blocks ≤25.

### Verification

```bash
bun run test:integration --reporter=verbose | tee /tmp/int-run.log
grep -c '✓' /tmp/int-run.log    # ≥ 20
time bun run test:integration   # < 180s
```

### Common pitfalls

- **msw stream interception:** Anthropic returns SSE on `messages`. `msw@^2` requires `HttpResponse` with a `ReadableStream` body — emit each fixture line as a `data: ` chunk with `Content-Type: text/event-stream`.
- **Subprocess inherits the runner's `ANTHROPIC_API_KEY`** then bypasses msw because the spawn opens a fresh fetch context. Solution: set `ANTHROPIC_BASE_URL=http://127.0.0.1:<msw-port>` per-test and run msw with `setupServer({onUnhandledRequest:'error'})` so any escape fails loudly.
- **Resume test flake:** if the kill happens between `tool_use_start` and `tool_use_result`, the idempotency log records the start but not the result, and the resume legitimately re-executes. Kill after `tool_use_result`, not after `tool_use_start`.
- **Provider failover must NOT swallow real 529s** — the msw handler uses `HttpResponse.json({error:{type:'overloaded_error'}}, {status: 529})` exactly once via a counter, then succeeds on retry.
- **Hook tests writing marker files** must `mktemp -d` per-test to avoid cross-test bleed.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `11`
- `<phase-name>` → `Testing harness`
- `<sub-prompt>` → `02-integration-tests`
- Do NOT mark Phase 11 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
