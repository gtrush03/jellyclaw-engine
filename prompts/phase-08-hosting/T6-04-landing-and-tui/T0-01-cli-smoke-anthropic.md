---
id: T0-01-cli-smoke-anthropic
tier: 0
title: "Baseline CLI smoke with real Anthropic credits"
scope:
  - engine/bin/jellyclaw
  - engine/src/cli/run.ts
  - engine/src/cli/serve.ts
  - engine/src/cli/tui.ts
  - tmp/t6-04-baseline/
depends_on_fix: []
tests:
  - name: run-smoke
    kind: jellyclaw-run
    description: "jellyclaw run hello returns an assistant message, exit 0"
    command: "node engine/bin/jellyclaw run 'say exactly: smoke-ok' --output-format json --max-turns 1 > tmp/t6-04-baseline/run.json 2>&1; echo EXIT=$?"
    expect_exit: 0
    timeout_sec: 90
  - name: tui-spawn
    kind: jellyclaw-tui
    description: "jellyclaw tui spawns Ink app, reads keypress, exits clean"
    command: "node --no-deprecation engine/src/tui/scripts/smoke-spawn-exit.mjs > tmp/t6-04-baseline/tui.log 2>&1; echo EXIT=$?"
    expect_exit: 0
    timeout_sec: 60
  - name: serve-health
    kind: http
    description: "jellyclaw serve booted, /v1/health returns 200 ok"
    command: "bash tmp/t6-04-baseline/serve-health.sh"
    expect_exit: 0
    timeout_sec: 60
human_gate: false
max_turns: 30
max_cost_usd: 8
max_retries: 2
estimated_duration_min: 15
---

# T0-01 — Baseline CLI smoke with real Anthropic credits

## Context
George refreshed the Anthropic API key. Before we touch a single line of TUI or
landing code, we must confirm the current `jellyclaw` CLI actually works
end-to-end against the live API. If anything is broken, everything downstream
is wasted work.

This prompt is **read-only for engine source** — do not edit `engine/src/` in
this step. You may create small helper scripts under `tmp/t6-04-baseline/` and
`engine/src/tui/scripts/` for the smokes.

## Baseline to preserve
Today's test counts (from STATUS.md as of 2026-04-15):
- 1302/1359 whole-suite (35 pre-existing failures in subprocess/library/perf)
- 67/67 TUI tests + 17 credentials tests
Don't accidentally break these. Don't add new test failures.

## Work to do

### 1. Credentials check
```bash
test -f ~/.jellyclaw/credentials.json && jq -e '.anthropicApiKey' ~/.jellyclaw/credentials.json
```
If missing or the key is `null`, STOP and emit:
`FAIL: T0-01 missing Anthropic credential — run 'jellyclaw key' and retry`

### 2. Build if stale
```bash
bun install --frozen-lockfile
bun run build
```
`engine/dist/` must exist and `engine/bin/jellyclaw` must be executable.

### 3. `jellyclaw run` smoke
Write `tmp/t6-04-baseline/` (gitignored already per Phase 99).
```bash
mkdir -p tmp/t6-04-baseline
ANTHROPIC_API_KEY=$(jq -r '.anthropicApiKey' ~/.jellyclaw/credentials.json) \
  node engine/bin/jellyclaw run 'say exactly: smoke-ok' \
    --output-format json --max-turns 1 \
    > tmp/t6-04-baseline/run.json 2>&1
```
Expect: exit 0, `run.json` contains an `assistant` event, no `error` events.
If it hangs, timeout at 90s.

### 4. `jellyclaw tui` spawn smoke
Create `engine/src/tui/scripts/smoke-spawn-exit.mjs` — a tiny `node-pty`-free
spawn that:
1. Spawns `node engine/bin/jellyclaw tui`.
2. Waits 3s for the Ink app to mount (splash should render).
3. Sends `q` keypress (our TUI's quit binding; verify by reading `app.tsx` + `commands/`).
4. Waits ≤5s for exit.
5. Exits 0 if the child exited 0 within the budget, else 1 with a reason.

Use Node `child_process.spawn` with `stdio: ['pipe', 'pipe', 'pipe']` and
`env.TERM = 'xterm-256color'`. Do NOT need a real TTY — Ink has a
headless/ink-testing mode fallback.

If the TUI's quit binding is different (e.g. Ctrl+C), use that — read
`engine/src/tui/commands/` to confirm.

### 5. `jellyclaw serve` health smoke
Create `tmp/t6-04-baseline/serve-health.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
PORT=$((RANDOM % 1000 + 18000))
TOKEN=smoke-token-$$
ANTHROPIC_API_KEY=$(jq -r '.anthropicApiKey' ~/.jellyclaw/credentials.json) \
  node engine/bin/jellyclaw serve --host 127.0.0.1 --port "$PORT" --auth-token "$TOKEN" &
SERVE_PID=$!
trap "kill $SERVE_PID 2>/dev/null || true" EXIT
for i in $(seq 1 30); do
  sleep 1
  curl -fsS "http://127.0.0.1:$PORT/v1/health" && echo && exit 0
done
echo "health never came up" >&2
exit 1
```
Chmod +x. Run it. Must exit 0.

### 6. Write `tmp/t6-04-baseline/SUMMARY.md`
Capture:
- Anthropic model used (read from run.json)
- Approx token usage if present
- Each smoke: PASS/FAIL + wall time
- Anything surprising

This file is the baseline the T4 verify tier will compare against.

## Acceptance criteria
- All three smokes exit 0.
- `tmp/t6-04-baseline/SUMMARY.md` exists and lists PASS for all three.
- No new test failures in `bun run test` (run it last and confirm count
  matches STATUS.md).

## Out of scope
- Do not polish the TUI — that's T1.
- Do not edit `engine/src/` except to add the new `smoke-spawn-exit.mjs`
  helper under `engine/src/tui/scripts/`.
- Do not commit anything.

## Verification the worker should self-run before finishing
```bash
ls -la tmp/t6-04-baseline/
cat tmp/t6-04-baseline/SUMMARY.md
bun run typecheck && bun run lint   # must still pass (no drift)
echo "DONE: T0-01-cli-smoke-anthropic"
```
