#!/usr/bin/env bash
# jellyclaw-engine dashboard launcher
# Starts backend (Hono, port 5174) + frontend (Vite, port 5173) together.
# Ctrl-C tears down both cleanly.

set -euo pipefail

# ------------------------------------------------------------------------------
# Paths
# ------------------------------------------------------------------------------
DASHBOARD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${DASHBOARD_DIR}/.." && pwd)"
SERVER_DIR="${DASHBOARD_DIR}/server"
PID_FILE="${DASHBOARD_DIR}/.dashboard-server.pid"
FRONTEND_PORT=5173
BACKEND_PORT=5174
DASHBOARD_URL="http://127.0.0.1:${FRONTEND_PORT}"

# ------------------------------------------------------------------------------
# Colors (respect no-color + non-tty)
# ------------------------------------------------------------------------------
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  GOLD=$'\033[38;5;179m'
  BLUE=$'\033[38;5;75m'
  DIM=$'\033[2m'
  BOLD=$'\033[1m'
  RED=$'\033[31m'
  GREEN=$'\033[32m'
  RESET=$'\033[0m'
else
  GOLD=""; BLUE=""; DIM=""; BOLD=""; RED=""; GREEN=""; RESET=""
fi

log()  { printf "%s[launcher]%s %s\n" "$BOLD" "$RESET" "$*"; }
warn() { printf "%s[launcher]%s %s%s%s\n" "$BOLD" "$RESET" "$RED" "$*" "$RESET"; }
ok()   { printf "%s[launcher]%s %s%s%s\n" "$BOLD" "$RESET" "$GREEN" "$*" "$RESET"; }

# ------------------------------------------------------------------------------
# Banner
# ------------------------------------------------------------------------------
banner() {
  printf "%s" "$GOLD"
  cat <<'EOF'
   ┌──────────────────────────────────────────────────────┐
   │                                                      │
   │     J E L L Y C L A W   E N G I N E                  │
   │     dashboard · obsidian & gold                      │
   │                                                      │
   └──────────────────────────────────────────────────────┘
EOF
  printf "%s" "$RESET"
  printf "%sfrontend%s  %s\n" "$DIM" "$RESET" "$DASHBOARD_URL"
  printf "%sbackend%s   http://127.0.0.1:%s\n" "$DIM" "$RESET" "$BACKEND_PORT"
  printf "%srepo%s      %s\n\n" "$DIM" "$RESET" "$REPO_ROOT"
}

# ------------------------------------------------------------------------------
# OS detection
# ------------------------------------------------------------------------------
detect_os() {
  case "$(uname -s)" in
    Darwin*)  echo "macos" ;;
    Linux*)
      if grep -qi microsoft /proc/version 2>/dev/null; then echo "wsl"; else echo "linux"; fi
      ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
}
OS="$(detect_os)"

open_url() {
  local url="$1"
  case "$OS" in
    macos)   open "$url" >/dev/null 2>&1 || true ;;
    linux)   xdg-open "$url" >/dev/null 2>&1 || true ;;
    wsl)     cmd.exe /c start "$url" >/dev/null 2>&1 || true ;;
    windows) start "$url" >/dev/null 2>&1 || true ;;
    *)       log "open ${url} manually in your browser" ;;
  esac
}

# ------------------------------------------------------------------------------
# Prereq checks
# ------------------------------------------------------------------------------
check_prereqs() {
  if ! command -v node >/dev/null 2>&1; then
    warn "node not found on PATH. Install Node.js >= 20 (https://nodejs.org)."
    exit 1
  fi

  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "$node_major" -lt 20 ]]; then
    warn "Node $(node -v) detected — this dashboard requires Node >= 20."
    exit 1
  fi

  if command -v pnpm >/dev/null 2>&1; then
    PKG_MGR="pnpm"
  elif command -v npm >/dev/null 2>&1; then
    PKG_MGR="npm"
  else
    warn "neither pnpm nor npm found. Install Node.js (ships with npm)."
    exit 1
  fi

  if [[ ! -d "$DASHBOARD_DIR" ]]; then
    warn "dashboard dir missing: $DASHBOARD_DIR"; exit 1
  fi
  if [[ ! -d "$SERVER_DIR" ]]; then
    warn "server dir missing: $SERVER_DIR"; exit 1
  fi
  if [[ ! -f "${DASHBOARD_DIR}/package.json" ]]; then
    warn "frontend package.json missing at ${DASHBOARD_DIR}/package.json"; exit 1
  fi
  if [[ ! -f "${SERVER_DIR}/package.json" ]]; then
    warn "server package.json missing at ${SERVER_DIR}/package.json"; exit 1
  fi
}

# ------------------------------------------------------------------------------
# Port check
# ------------------------------------------------------------------------------
port_in_use() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti:"$port" >/dev/null 2>&1
  else
    return 1
  fi
}

check_ports() {
  local fail=0
  for port in "$FRONTEND_PORT" "$BACKEND_PORT"; do
    if port_in_use "$port"; then
      warn "port ${port} already in use."
      warn "  diagnose: lsof -i :${port}"
      warn "  reset:    ${DASHBOARD_DIR}/stop.sh"
      fail=1
    fi
  done
  [[ $fail -eq 0 ]] || exit 1
}

# ------------------------------------------------------------------------------
# Install deps
# ------------------------------------------------------------------------------
install_if_missing() {
  local dir="$1"
  local label="$2"
  if [[ ! -d "${dir}/node_modules" ]]; then
    log "installing ${label} deps in ${dir} (${PKG_MGR})…"
    set +e
    ( cd "$dir" && "$PKG_MGR" install )
    local rc=$?
    set -e
    if [[ $rc -ne 0 ]]; then
      warn "${label} install failed (exit ${rc}). See ${PKG_MGR} output above."
      exit $rc
    fi
  fi
}

# ------------------------------------------------------------------------------
# Process management
# ------------------------------------------------------------------------------
SERVER_PID=""

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    log "stopping backend (pid ${SERVER_PID})…"
    kill "$SERVER_PID" 2>/dev/null || true
    # grace period
    for _ in 1 2 3 4 5; do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  ok "dashboard stopped."
  exit $rc
}
trap cleanup EXIT INT TERM

prefix_stream() {
  local prefix="$1"
  local color="$2"
  local line
  while IFS= read -r line; do
    printf "%s%s%s %s\n" "$color" "$prefix" "$RESET" "$line"
  done
}

start_backend() {
  log "starting backend on :${BACKEND_PORT}…"
  # Backend is expected to expose `pnpm dev` / `npm run dev` that runs on BACKEND_PORT.
  ( cd "$SERVER_DIR" && PORT="$BACKEND_PORT" "$PKG_MGR" run dev ) \
    2>&1 | prefix_stream "[server]" "$BLUE" &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"

  # Give it a moment to bind.
  sleep 1
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    warn "backend failed to start (pid ${SERVER_PID} no longer alive)."
    warn "check logs above, or run manually: cd ${SERVER_DIR} && ${PKG_MGR} run dev"
    exit 1
  fi
}

open_browser_soon() {
  (
    sleep 3
    open_url "$DASHBOARD_URL"
  ) &
}

start_frontend() {
  log "starting frontend on :${FRONTEND_PORT}…"
  # Foreground — Ctrl-C here triggers cleanup trap.
  ( cd "$DASHBOARD_DIR" && "$PKG_MGR" run dev -- --port "$FRONTEND_PORT" --host 127.0.0.1 ) \
    2>&1 | prefix_stream "[ui]" "$GOLD"
}

# ------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------
banner
check_prereqs
check_ports
install_if_missing "$DASHBOARD_DIR" "frontend"
install_if_missing "$SERVER_DIR"    "backend"
start_backend
open_browser_soon
start_frontend
