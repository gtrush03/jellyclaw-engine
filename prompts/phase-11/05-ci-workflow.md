# Phase 11 — Testing harness — Prompt 05: CI workflow + budget gate

**When to run:** After Prompts 01-04 of Phase 11 land and all four tiers are green locally.
**Estimated duration:** 3-4 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `11`
- `<phase-name>` → `Testing harness`
- `<sub-prompt>` → `05-ci-workflow`
<!-- END SESSION STARTUP -->

## Research task

1. Read `test/TESTING.md` §12 — abridged CI workflow. The version you author this session is the canonical full one.
2. Read `phases/PHASE-11-testing.md` Step 4 (nightly), Step 5 (cost budget enforcement), Step 7 (coverage gate).
3. Confirm GitHub repo settings — at minimum `ANTHROPIC_TEST_KEY`, `OPENROUTER_TEST_KEY`, `CLAURST_DOWNLOAD_URL` (private signed S3 URL for prebuilt Claurst macOS binary; building from source in CI is too slow), `SLACK_WEBHOOK_URL`. George provisions these — flag missing ones in `STATUS.md`.

## Implementation task

Ship two GitHub Actions workflows: `test.yml` (PR + push) running unit + integration tiers under a $1 cap, and `test-nightly.yml` (cron 06:00 UTC + workflow_dispatch) running scenario + comparison tiers under a $5 cap with Slack alert on failure. Both boot a headless test Chromium on port 9333.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/.github/workflows/test.yml`
- `/Users/gtrush/Downloads/jellyclaw-engine/.github/workflows/test-nightly.yml`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/cost-accountant.mjs` — reads `test/.cost-ledger.jsonl`, fails if total exceeds `$CI_COST_CAP_USD`
- `/Users/gtrush/Downloads/jellyclaw-engine/test/helpers/redact.mjs` — strips `Bearer …`, `sk-ant-…`, `sk-or-v1-…`, generic `Bearer [a-zA-Z0-9_-]{20,}` from streams before they hit GHA logs
- `/Users/gtrush/Downloads/jellyclaw-engine/test/quarantine/README.md` — owner + issue-link contract for flaky tests
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/testing.md` — testing strategy doc (PHASE-11 deliverable)
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — mark Phase 11 ✅

### `.github/workflows/test.yml` (per-PR)

```yaml
name: test
on:
  push: { branches: [main] }
  pull_request: {}
concurrency: { group: ${{ github.ref }}, cancel-in-progress: true }
jobs:
  test:
    runs-on: macos-14
    timeout-minutes: 25
    env:
      JELLYCLAW_CONFIG_PATH: ${{ github.workspace }}/test/fixtures/jellyclaw-config
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_TEST_KEY }}
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_TEST_KEY }}
      CI_COST_CAP_USD: "1.00"
      ANTHROPIC_BASE_URL: "http://127.0.0.1:7411"
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: latest }
      - run: bun install --frozen-lockfile
      - run: bun run build
      - run: bun run scripts/apply-patches.sh
      - name: Boot test Chromium :9333
        run: node test/helpers/start-test-chrome.mjs --port 9333 --headless
      - name: Unit tier
        run: bun run test:unit --reporter=verbose
      - name: Coverage gate (≥80%)
        run: bun run test:coverage --reporter=text-summary
      - name: Integration tier
        run: bun run test:integration --reporter=verbose
      - name: Cost accountant (PR cap $1)
        run: node test/helpers/cost-accountant.mjs --cap "$CI_COST_CAP_USD"
      - name: Stop test Chromium
        if: always()
        run: node test/helpers/stop-test-chrome.mjs
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: traces, path: ~/.jellyclaw/traces/ }
```

### `.github/workflows/test-nightly.yml`

```yaml
name: test-nightly
on:
  schedule: [{ cron: "0 6 * * *" }]
  workflow_dispatch: {}
jobs:
  scenarios:
    runs-on: macos-14
    timeout-minutes: 75
    env:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_TEST_KEY }}
      OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_TEST_KEY }}
      CI_COST_CAP_USD: "5.00"
      RUN_COMPARISON: "1"
      SCENARIO_BUDGET_USD: "0.20"
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run build
      - run: bun run scripts/apply-patches.sh
      - name: Install Claurst (prebuilt binary)
        run: |
          curl -fsSL "${{ secrets.CLAURST_DOWNLOAD_URL }}" -o /usr/local/bin/claurst
          chmod +x /usr/local/bin/claurst
          claurst --version
      - run: node test/helpers/start-test-chrome.mjs --port 9333 --headless
      - name: Scenario tier
        run: bun run test:scenario --reporter=verbose
      - name: Comparison tier
        run: bun run test:comparison --reporter=verbose
      - name: Cost accountant (nightly cap $5)
        run: node test/helpers/cost-accountant.mjs --cap "$CI_COST_CAP_USD"
      - name: Slack alert on failure
        if: failure() && env.SLACK_WEBHOOK_URL != ''
        uses: slackapi/slack-github-action@v1
        with:
          payload: |
            { "text": "🚨 jellyclaw nightly FAILED — ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" }
        env:
          SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
      - if: always()
        run: node test/helpers/stop-test-chrome.mjs
      - uses: actions/upload-artifact@v4
        with:
          name: nightly-traces-and-report
          path: |
            ~/.jellyclaw/traces/
            test/comparison/report.md
            test/.cost-ledger.jsonl
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
brew install action-validator || true
action-validator .github/workflows/test.yml
action-validator .github/workflows/test-nightly.yml
node test/helpers/cost-accountant.mjs --cap 1.00
echo 'Authorization: Bearer sk-ant-abcdefghijklmnopqrstuvwxyz' | node test/helpers/redact.mjs
# → Authorization: Bearer ***REDACTED***
```

### Expected output

- Push to draft PR → `test.yml` succeeds end-to-end.
- Total PR cost in `test/.cost-ledger.jsonl` < $1.00.
- Nightly run posts a single Slack message on red (silent on green; optional summary message on green is a nice-to-have, file an issue).
- `docs/testing.md` lands and links every tier file.

### Verification

```bash
gh workflow run test.yml --ref main || true
gh run list --workflow=test.yml --limit 1
gh run watch
# After green: mark Phase 11 ✅ in COMPLETION-LOG.md per closeout template (this is the FINAL prompt of the phase).
```

### Common pitfalls

- **`macos-14` runners are M-series ARM**; the test Chromium must be ARM. Rosetta-emulated Chrome makes scenario tests 4× slower and may timeout.
- **`oven-sh/setup-bun@v2` caches `~/.bun/install/cache`** but NOT `node_modules` — pair with `actions/cache` keyed on `bun.lockb` if install is the bottleneck.
- **Secrets in GHA logs:** even with `add-mask`, structured stderr from jellyclaw can leak headers. The redactor MUST run inline on `bun run test:*` output via a wrapper, not just on artifacts. Wire as `bun run test:integration | node test/helpers/redact.mjs`.
- **Cost cap false positives:** an Anthropic 5xx that retried on OpenRouter double-counts if both providers logged usage. Cost accountant should dedupe by `request_id`.
- **Slack webhook missing on fork PRs** — guard with `if: failure() && env.SLACK_WEBHOOK_URL != ''` (already done above).
- **Nightly Claurst binary URL rotates** — document renewal cadence in `docs/testing.md` and add a TODO to switch to GitHub Releases of the Claurst repo once they ship.

This is the FINAL prompt of Phase 11 — mark Phase 11 ✅ in `COMPLETION-LOG.md` per the closeout template.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `11`
- `<phase-name>` → `Testing harness`
- `<sub-prompt>` → `05-ci-workflow`
- This IS the final prompt of Phase 11. Mark Phase 11 ✅, bump the progress bar, set Current phase to 12.
<!-- END SESSION CLOSEOUT -->
