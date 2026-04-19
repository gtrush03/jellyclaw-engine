#!/usr/bin/env bash
set -euo pipefail

# Launch Chrome for jellyclaw browser-MCP usage.
# - Binds CDP on 127.0.0.1:9333
# - Uses dedicated profile at ~/Library/Application Support/jellyclaw-chrome-profile
#   (respects Chrome 136+ default-profile block; see Chrome blog 2025-03)
# - Safe to re-run; reuses profile across launches

PORT="${JELLYCLAW_CHROME_PORT:-9333}"
PROFILE="${JELLYCLAW_CHROME_PROFILE:-$HOME/Library/Application Support/jellyclaw-chrome-profile}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

if [[ ! -x "$CHROME" ]]; then
  echo "error: Chrome not found at $CHROME" >&2
  echo "hint:  install via 'brew install --cask google-chrome' or download from https://www.google.com/chrome/" >&2
  exit 1
fi

# Port already bound? bail out gracefully — probably already running
if lsof -i ":$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "jellyclaw-chrome already running on port $PORT"
  exit 0
fi

mkdir -p "$PROFILE"
echo "starting Chrome on CDP $PORT with profile $PROFILE" >&2
"$CHROME" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --restore-last-session \
  --no-first-run \
  --no-default-browser-check \
  "$@" &
CHROME_PID=$!
# Raise window to front on macOS
sleep 2
osascript -e 'tell application "Google Chrome" to activate' 2>/dev/null || true
# Detach so script can exit; Chrome keeps running
disown "$CHROME_PID" 2>/dev/null || true
echo "chrome pid=$CHROME_PID" >&2
