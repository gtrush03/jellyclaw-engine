#!/usr/bin/env bash
# Launches an isolated headless Chrome for jellyclaw Playwright-MCP
# integration tests. Binds the CDP endpoint to 127.0.0.1:9333 ONLY —
# port 9222 is reserved for the user's real browser (with logged-in
# sessions, cookies, bank tabs) and must never be touched by tests.
#
# Usage:
#   scripts/playwright-test-chrome.sh start   # spawns; prints PID + user-data-dir
#   scripts/playwright-test-chrome.sh stop    # kills by pidfile
#
# Env:
#   JELLYCLAW_TEST_CHROME_PORT  — default 9333 (9222 is REFUSED)
#   JELLYCLAW_TEST_CHROME_BIN   — override browser binary path
#
# Invariant: the script refuses to run if the literal string "9222"
# appears anywhere in its own args or its resolved port/env. This is
# a defense-in-depth check — the test suite also asserts the loaded
# config's endpoint is 9333.

set -euo pipefail

PORT="${JELLYCLAW_TEST_CHROME_PORT:-9333}"
PIDFILE="${TMPDIR:-/tmp}/jellyclaw-test-chrome.pid"
DATADIRFILE="${TMPDIR:-/tmp}/jellyclaw-test-chrome.datadir"

# --- Port 9222 refusal (spec-mandated) ------------------------------------
refuse_if_9222() {
  local haystack="$*"
  # Match 9222 only as a whole port token (not e.g. 922200).
  if [[ "$haystack" =~ (^|[^0-9])9222($|[^0-9]) ]]; then
    echo "refusing: 9222 is reserved for the user's real browser" >&2
    exit 64
  fi
}
refuse_if_9222 "$@" "$PORT" "${JELLYCLAW_TEST_CHROME_PORT:-}"

cmd="${1:-start}"

case "$cmd" in
  start)
    if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "already running (pid=$(cat "$PIDFILE"))" >&2
      exit 1
    fi

    DATADIR="$(mktemp -d -t jellyclaw-test-chrome-XXXXXX)"
    echo "$DATADIR" > "$DATADIRFILE"

    CHROME_BIN="${JELLYCLAW_TEST_CHROME_BIN:-}"
    if [[ -z "$CHROME_BIN" ]]; then
      if [[ "$(uname)" == "Darwin" && -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]]; then
        CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      elif command -v google-chrome >/dev/null 2>&1; then
        CHROME_BIN="$(command -v google-chrome)"
      elif command -v chromium >/dev/null 2>&1; then
        CHROME_BIN="$(command -v chromium)"
      else
        echo "no chrome/chromium found; set JELLYCLAW_TEST_CHROME_BIN" >&2
        exit 2
      fi
    fi

    "$CHROME_BIN" \
      --remote-debugging-port="$PORT" \
      --remote-debugging-address=127.0.0.1 \
      --user-data-dir="$DATADIR" \
      --headless=new \
      --no-first-run \
      --no-default-browser-check \
      --disable-extensions \
      --disable-component-update \
      about:blank \
      >"$DATADIR/chrome.stdout.log" 2>"$DATADIR/chrome.stderr.log" &

    PID=$!
    echo "$PID" > "$PIDFILE"
    echo "pid=$PID datadir=$DATADIR port=$PORT"

    # Wait for CDP to respond (up to 15 s).
    for _ in $(seq 1 150); do
      if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
        exit 0
      fi
      sleep 0.1
    done
    echo "chrome did not open CDP on 127.0.0.1:$PORT within 15s" >&2
    kill -9 "$PID" 2>/dev/null || true
    rm -f "$PIDFILE"
    rm -rf "$DATADIR"
    exit 3
    ;;

  stop)
    if [[ -f "$PIDFILE" ]]; then
      PID="$(cat "$PIDFILE")"
      if kill -0 "$PID" 2>/dev/null; then
        kill "$PID" 2>/dev/null || true
        # Grace, then SIGKILL.
        for _ in $(seq 1 30); do
          if ! kill -0 "$PID" 2>/dev/null; then break; fi
          sleep 0.1
        done
        kill -9 "$PID" 2>/dev/null || true
      fi
      rm -f "$PIDFILE"
    fi
    if [[ -f "$DATADIRFILE" ]]; then
      DATADIR="$(cat "$DATADIRFILE")"
      [[ -n "$DATADIR" && -d "$DATADIR" ]] && rm -rf "$DATADIR"
      rm -f "$DATADIRFILE"
    fi
    ;;

  *)
    echo "usage: $0 {start|stop}" >&2
    exit 1
    ;;
esac
