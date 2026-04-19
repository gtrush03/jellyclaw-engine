---
id: T4-01-full-anthropic-smoke
tier: 4
title: "Full end-to-end smoke: CLI + TUI + serve + web-TUI against real Anthropic"
scope:
  - tmp/t6-04-final/
  - STATUS.md
  - COMPLETION-LOG.md
depends_on_fix:
  - T3-03-web-tui-playwright-smoke
tests:
  - name: four-surface-smoke
    kind: shell
    description: "all four surfaces (run, tui, serve, web-tui) produce expected outputs"
    command: "bash tmp/t6-04-final/four-surface-smoke.sh"
    expect_exit: 0
    timeout_sec: 900
  - name: baseline-regression
    kind: shell
    description: "no regression vs T0-01 baseline (run output still clean)"
    command: "bash tmp/t6-04-final/compare-baseline.sh"
    expect_exit: 0
    timeout_sec: 120
  - name: suite-green
    kind: shell
    description: "whole test suite still passes at or above baseline count"
    command: "bun run test 2>&1 | tail -30 | tee tmp/t6-04-final/suite-summary.txt; tail -1 tmp/t6-04-final/suite-summary.txt | grep -q 'pass'"
    expect_exit: 0
    timeout_sec: 600
human_gate: false
max_turns: 45
max_cost_usd: 20
max_retries: 2
estimated_duration_min: 30
---

# T4-01 — Full end-to-end smoke

## Context
All the tier T1/T2/T3 work has landed. Before we call T6-04 complete, exercise
every user-visible surface with a real Anthropic key and confirm nothing
regressed against the T0-01 baseline captured in `tmp/t6-04-baseline/`.

## Four surfaces

| Surface | Invocation | Expected |
|---|---|---|
| CLI run | `jellyclaw run 'say exactly: smoke-final'` | `smoke-final` substring in output |
| Local TUI | Ink mount + keypress fixture | mount ok, quit ok, no crash |
| HTTP serve | `POST /v1/run` with bearer token | `{run_id, status: completed}` |
| Web TUI | Docker container, Playwright | landing + /tui both render |

## Work

### 1. `tmp/t6-04-final/four-surface-smoke.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
mkdir -p tmp/t6-04-final
cd "$(dirname "$0")/../.."

key_file=~/.jellyclaw/credentials.json
test -f "$key_file" || { echo "no creds"; exit 2; }
export ANTHROPIC_API_KEY=$(jq -r '.anthropicApiKey' "$key_file")

echo "=== 1/4 CLI run ==="
node engine/bin/jellyclaw run 'say exactly: smoke-final' \
  --output-format json --max-turns 1 > tmp/t6-04-final/run.json
jq -r '.messages[]?.content[]?.text // empty' tmp/t6-04-final/run.json | tee tmp/t6-04-final/run.txt
grep -q 'smoke-final' tmp/t6-04-final/run.txt

echo "=== 2/4 Local TUI spawn ==="
node engine/src/tui/scripts/smoke-spawn-exit.mjs > tmp/t6-04-final/tui.log 2>&1

echo "=== 3/4 HTTP serve ==="
PORT=$((RANDOM % 1000 + 19000))
TOKEN=final-$$
node engine/bin/jellyclaw serve --host 127.0.0.1 --port $PORT --auth-token $TOKEN &
SRV=$!
trap "kill $SRV 2>/dev/null || true" EXIT
for i in $(seq 1 30); do sleep 1; curl -fsS http://127.0.0.1:$PORT/v1/health > /dev/null && break; done
curl -fsS -X POST http://127.0.0.1:$PORT/v1/run \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"say exactly: http-smoke-ok","max_turns":1}' \
  > tmp/t6-04-final/http.json
grep -q 'http-smoke-ok\|completed' tmp/t6-04-final/http.json
kill $SRV; trap - EXIT

echo "=== 4/4 Web TUI (container) ==="
if docker info > /dev/null 2>&1; then
  docker build -t jellyclaw-final . > tmp/t6-04-final/docker-build.log 2>&1
  JELLYCLAW_WEB_TUI_E2E=1 bun run test:e2e:web-tui > tmp/t6-04-final/web-tui-e2e.log 2>&1
else
  echo "DOCKER_UNAVAILABLE — web TUI skipped (allowed in dev)" > tmp/t6-04-final/web-tui-e2e.log
fi

echo "=== all surfaces passed ==="
```
chmod +x.

### 2. `tmp/t6-04-final/compare-baseline.sh`
```bash
#!/usr/bin/env bash
set -euo pipefail
base=tmp/t6-04-baseline/SUMMARY.md
final=tmp/t6-04-final/run.json
test -f "$base" || { echo "baseline missing"; exit 2; }
test -f "$final" || { echo "final run missing"; exit 2; }
# Crude regression guard: final should not be empty, should have an assistant message
jq -e '.messages | length > 0' "$final" > /dev/null
echo "regression check ok"
```

### 3. Update `COMPLETION-LOG.md`
Append a section:
```
## T6-04: Landing page + beautiful TUI + web TUI deploy

**Status:** `08.T6-04 ✅`

**Tiers completed:**
- T0-01 baseline CLI smoke
- T0-02 ultrathink design brief
- T1-01..04 TUI polish (theme, splash, transcript, statusbar)
- T2-01..03 landing (assets, build, a11y)
- T3-01..03 web TUI (dockerfile, supervisor, playwright)
- T4-01 full surface smoke

**Files touched:** <list from git status --short>

**Notes:** <anything surprising>
```

### 4. Update `STATUS.md`
Bump `Last updated`, note T6-04 complete, bump test counts if they changed.

## Acceptance criteria
- `four-surface-smoke.sh` passes (docker step skipped is acceptable if the
  docker daemon isn't available — but log it).
- No regression vs baseline.
- `COMPLETION-LOG.md` + `STATUS.md` updated.
- Suite count ≥ prior baseline (from T0-01).

## Out of scope
- Committing — George commits himself.
- Deploying to Fly — Phase 19 / separate runbook.

## Verification the worker should self-run before finishing
```bash
bash tmp/t6-04-final/four-surface-smoke.sh
bash tmp/t6-04-final/compare-baseline.sh
tail -40 COMPLETION-LOG.md
echo "DONE: T4-01-full-anthropic-smoke"
```
