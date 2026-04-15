#!/usr/bin/env bash
# jellyclaw-engine dashboard stop script
# Kills backend + frontend, frees ports 5173/5174, removes pid file.

set -euo pipefail

DASHBOARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="${DASHBOARD_DIR}/.dashboard-server.pid"
FRONTEND_PORT=5173
BACKEND_PORT=5174

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; DIM=""; RESET=""
fi

log() { printf "%s[stop]%s %s\n" "$BOLD" "$RESET" "$*"; }
ok()  { printf "%s[stop]%s %s%s%s\n" "$BOLD" "$RESET" "$GREEN" "$*" "$RESET"; }

killed_any=0

# 1. Kill pid from file
if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || echo "")"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    log "killing backend pid ${pid}…"
    set +e
    kill "$pid" 2>/dev/null
    sleep 0.3
    kill -9 "$pid" 2>/dev/null
    set -e
    killed_any=1
  fi
  rm -f "$PID_FILE"
fi

# 2. Kill anything on the two ports
if command -v lsof >/dev/null 2>&1; then
  set +e
  port_pids="$(lsof -ti:"${FRONTEND_PORT}","${BACKEND_PORT}" 2>/dev/null | sort -u)"
  set -e
  if [[ -n "$port_pids" ]]; then
    log "freeing ports ${FRONTEND_PORT}/${BACKEND_PORT} (pids: $(echo "$port_pids" | tr '\n' ' '))…"
    echo "$port_pids" | xargs -I{} kill -9 {} 2>/dev/null || true
    killed_any=1
  fi
else
  printf "%s[stop]%s %slsof not found — skipping port sweep%s\n" "$BOLD" "$RESET" "$DIM" "$RESET"
fi

# 3. Pattern-kill stragglers tied to THIS dashboard dir
if command -v pgrep >/dev/null 2>&1; then
  set +e
  pattern_pids="$(pgrep -f "${DASHBOARD_DIR}.*(vite|tsx watch|node)" 2>/dev/null)"
  set -e
  if [[ -n "$pattern_pids" ]]; then
    log "killing leftover dashboard processes…"
    echo "$pattern_pids" | xargs -I{} kill -9 {} 2>/dev/null || true
    killed_any=1
  fi
fi

if [[ $killed_any -eq 0 ]]; then
  ok "nothing to stop — dashboard already idle."
else
  ok "dashboard stopped."
fi
