#!/usr/bin/env bash
# run-web-tui-e2e.sh — wrapper for the T3-03 Playwright smoke.
#
# Policy (per the T3-03 spec):
#   - Suite is opt-in via JELLYCLAW_WEB_TUI_E2E=1.
#   - If docker is unreachable OR the opt-in is unset, print a SKIP banner
#     and exit 0. This keeps the acceptance test clean on CI + dev machines
#     without a daemon.
#   - Otherwise, run Playwright and propagate its exit code.

set -euo pipefail

skip() {
  printf 'SKIP: T3-03 %s\n' "$*"
  exit 0
}

if [[ "${JELLYCLAW_WEB_TUI_E2E:-0}" != "1" ]]; then
  skip "JELLYCLAW_WEB_TUI_E2E!=1 — suite gated off (set JELLYCLAW_WEB_TUI_E2E=1 to run)"
fi

if ! docker info > /dev/null 2>&1; then
  skip "docker daemon not reachable — run \`colima start\` or Docker Desktop, then retry."
fi

# First run seeds baseline screenshots into engine/test/e2e/__screenshots__/.
# Pass --no-update-snapshots (via JELLYCLAW_WEB_TUI_STRICT=1) to fail on diff.
update_flag="--update-snapshots"
if [[ "${JELLYCLAW_WEB_TUI_STRICT:-0}" == "1" ]]; then
  update_flag=""
fi

exec bunx playwright test engine/test/e2e/web-tui.spec.ts \
  --config=engine/test/e2e/playwright.config.ts ${update_flag} "$@"
