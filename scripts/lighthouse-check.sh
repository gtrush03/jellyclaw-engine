#!/usr/bin/env bash
# scripts/lighthouse-check.sh
#
# Boots the landing-page server, runs Lighthouse against it in headless
# Chrome, writes site/lighthouse-report.json, and exits non-zero if any of
# performance/accessibility/best-practices/seo scores below 0.90.
#
# Requires: bun (for the dev server), node + npx (for lighthouse), and a
# Chrome/Chromium install discoverable by lighthouse-cli.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-4311}"
URL="http://127.0.0.1:${PORT}"
REPORT="site/lighthouse-report.json"
LOG="${LIGHTHOUSE_LOG:-/tmp/jc-landing.log}"
THRESHOLD="${THRESHOLD:-0.90}"

# Pick the local Chrome on macOS if lighthouse can't find one on PATH.
if [[ -z "${CHROME_PATH:-}" ]]; then
  for candidate in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"; do
    if [[ -x "$candidate" ]]; then export CHROME_PATH="$candidate"; break; fi
  done
fi

echo "» starting site server on ${URL}"
bun run serve:site > "$LOG" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT

# wait for the server to come up — up to 20 s
ready=0
for _ in $(seq 1 20); do
  sleep 1
  if curl -fsS "$URL/" >/dev/null 2>&1; then ready=1; break; fi
done
if [[ "$ready" -ne 1 ]]; then
  echo "✗ server failed to come up in 20s" >&2
  echo "--- server log ---" >&2
  cat "$LOG" >&2 || true
  exit 2
fi
echo "✓ server reachable"

mkdir -p site

echo "» running lighthouse"
npx -y lighthouse "$URL" \
  --output=json \
  --output-path="$REPORT" \
  --only-categories=performance,accessibility,best-practices,seo \
  --chrome-flags="--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage" \
  --quiet

echo
echo "» scores"
jq -r '.categories | to_entries[] | "  \(.key): \((.value.score // 0) * 100 | floor)"' "$REPORT"
echo

if jq -e --argjson t "$THRESHOLD" '
  .categories
  | to_entries
  | all(.value.score != null and .value.score >= $t)
' "$REPORT" >/dev/null; then
  echo "✓ all categories ≥ $(awk "BEGIN { printf \"%d\", $THRESHOLD * 100 }")"
  exit 0
else
  echo "✗ at least one category < $(awk "BEGIN { printf \"%d\", $THRESHOLD * 100 }")" >&2
  jq -r '.categories | to_entries[] | "  \(.key) \((.value.score // 0))"' "$REPORT" >&2
  exit 1
fi
