#!/usr/bin/env bash
set -euo pipefail

PORT="${JELLYCLAW_CHROME_PORT:-9333}"
PIDS=$(lsof -i ":$PORT" -sTCP:LISTEN -t 2>/dev/null || true)
if [[ -z "$PIDS" ]]; then
  echo "no Chrome listening on port $PORT"
  exit 0
fi
echo "stopping Chrome pid(s): $PIDS"
kill -TERM $PIDS
sleep 5
# force kill anything still alive
for pid in $PIDS; do
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid"
  fi
done
