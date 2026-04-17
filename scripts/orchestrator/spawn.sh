#!/usr/bin/env bash
# spawn.sh — idempotent launcher for the jc-orchestrator tmux session.
#
# Creates (or re-uses) a detached tmux session with 5 windows:
#   0: grid   — live-updating table (node grid.mjs)
#   1: logs   — tail -F logs/orchestrator.jsonl | pino-pretty (fallback: raw tail)
#   2: repl   — bare bash, `jc` on PATH
#   3: brain  — placeholder for M13 (sleep infinity)
#   4: inbox  — `watch -n 1 ls -lt .orchestrator/inbox/ | head -20`
#
# Exits 0 on success (tmux stays running detached). Safe to run repeatedly —
# if the session exists we just report that and exit.

set -euo pipefail

ORCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${ORCH_DIR}/../.." && pwd)"
SESSION="jc-orchestrator"

# ---- colors ----------------------------------------------------------------
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  GOLD=$'\033[38;5;179m'
  GREEN=$'\033[32m'
  AMBER=$'\033[33m'
  RED=$'\033[31m'
  DIM=$'\033[2m'
  BOLD=$'\033[1m'
  RESET=$'\033[0m'
else
  GOLD=""; GREEN=""; AMBER=""; RED=""; DIM=""; BOLD=""; RESET=""
fi
log()  { printf "%s[spawn]%s %s\n"  "$BOLD"  "$RESET" "$*"; }
ok()   { printf "%s[spawn]%s %s%s%s\n" "$BOLD" "$RESET" "$GREEN" "$*" "$RESET"; }
warn() { printf "%s[spawn]%s %s%s%s\n" "$BOLD" "$RESET" "$AMBER" "$*" "$RESET"; }
err()  { printf "%s[spawn]%s %s%s%s\n" "$BOLD" "$RESET" "$RED"   "$*" "$RESET"; }

# ---- prereqs ---------------------------------------------------------------
if ! command -v tmux >/dev/null 2>&1; then
  err "tmux not found on PATH."
  err "  install: brew install tmux   (macOS)"
  err "           apt-get install tmux (Debian/Ubuntu)"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  err "node not found on PATH (required for grid.mjs and jc)."
  exit 1
fi

# ---- banner ----------------------------------------------------------------
printf "%s" "$GOLD"
cat <<'BANNER'
   ┌──────────────────────────────────────────────────────┐
   │                                                      │
   │   J C - O R C H E S T R A T O R                      │
   │   always-on supervision · obsidian & gold            │
   │                                                      │
   └──────────────────────────────────────────────────────┘
BANNER
printf "%s" "$RESET"
printf "%srepo%s    %s\n"    "$DIM" "$RESET" "$REPO_ROOT"
printf "%ssession%s %s\n\n"  "$DIM" "$RESET" "$SESSION"

# ---- idempotence -----------------------------------------------------------
if tmux has-session -t "$SESSION" 2>/dev/null; then
  ok "session ${SESSION} already running — attach with:"
  printf "  %stmux attach -t %s%s\n" "$BOLD" "$SESSION" "$RESET"
  exit 0
fi

# ---- state dirs ------------------------------------------------------------
mkdir -p "${REPO_ROOT}/.autobuild/logs" "${REPO_ROOT}/.orchestrator/inbox" "${REPO_ROOT}/logs"

# Prepend the orchestrator dir to PATH so `jc` resolves without install.
export PATH="${ORCH_DIR}:${PATH}"

# ---- create session --------------------------------------------------------
log "creating tmux session ${SESSION}…"

# Window 0: grid
# `-d` detached, `-s` name, `-n` window name, `-c` cwd, then the command.
tmux new-session -d -s "$SESSION" -n "grid" -c "$REPO_ROOT" \
  "node \"${ORCH_DIR}/grid.mjs\"; exec bash"

# Propagate PATH into the tmux server environment so jc is found in all windows.
tmux set-environment -t "$SESSION" PATH "$PATH"
tmux set-environment -t "$SESSION" AUTOBUILD_ROOT "$REPO_ROOT"

# Window 1: logs — tail with pino-pretty if it's available in the repo, else raw.
LOG_FILE="${REPO_ROOT}/logs/orchestrator.jsonl"
# Touch so tail -F doesn't complain on empty rigs.
touch "$LOG_FILE"

if [[ -x "${REPO_ROOT}/node_modules/.bin/pino-pretty" ]]; then
  PRETTY_CMD="tail -F \"$LOG_FILE\" | \"${REPO_ROOT}/node_modules/.bin/pino-pretty\" --colorize --translateTime \"SYS:HH:MM:ss.l\""
elif command -v pino-pretty >/dev/null 2>&1; then
  PRETTY_CMD="tail -F \"$LOG_FILE\" | pino-pretty --colorize --translateTime \"SYS:HH:MM:ss.l\""
else
  PRETTY_CMD="tail -F \"$LOG_FILE\""
fi
tmux new-window -t "$SESSION" -n "logs" -c "$REPO_ROOT" "$PRETTY_CMD; exec bash"

# Window 2: repl — bare shell with jc on PATH.
tmux new-window -t "$SESSION" -n "repl" -c "$REPO_ROOT" \
  "PATH=\"${ORCH_DIR}:\$PATH\"; export PATH; export AUTOBUILD_ROOT=\"$REPO_ROOT\"; echo \"jc-orchestrator repl — \\\`jc help\\\` to list commands\"; exec bash"

# Window 3: brain — placeholder until M13.
# Use `tail -f /dev/null` for a portable "hang forever" (macOS `sleep` doesn't accept `infinity`).
tmux new-window -t "$SESSION" -n "brain" -c "$REPO_ROOT" \
  "echo 'brain pane — M13 not yet implemented; use jc commands from repl'; tail -f /dev/null"

# Window 4: inbox — tail the inbox dir.
# `watch` exists on most macOS boxes via homebrew; if not, fall back to a loop.
if command -v watch >/dev/null 2>&1; then
  tmux new-window -t "$SESSION" -n "inbox" -c "$REPO_ROOT" \
    "watch -n 1 'ls -lt .orchestrator/inbox/ 2>/dev/null | head -20'; exec bash"
else
  tmux new-window -t "$SESSION" -n "inbox" -c "$REPO_ROOT" \
    "while true; do clear; echo '.orchestrator/inbox/:'; ls -lt .orchestrator/inbox/ 2>/dev/null | head -20; sleep 1; done"
fi

# ---- status line ----------------------------------------------------------
# Gold status-left, live `jc status --line` on the right every 5s.
tmux set -t "$SESSION" -g status-interval 5
tmux set -t "$SESSION" -g status-left "#[fg=colour179,bold] jc-orchestrator #[default]"
tmux set -t "$SESSION" -g status-left-length 30
tmux set -t "$SESSION" -g status-right "#($ORCH_DIR/jc status --line)"
tmux set -t "$SESSION" -g status-right-length 80

# Focus grid window on attach.
tmux select-window -t "$SESSION":0

ok "session ${SESSION} ready."
printf "  attach: %stmux attach -t %s%s\n" "$BOLD" "$SESSION" "$RESET"
printf "  stop:   %s%s/stop.sh%s\n"       "$DIM"  "$ORCH_DIR" "$RESET"
exit 0
