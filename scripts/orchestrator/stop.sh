#!/usr/bin/env bash
# stop.sh — cleanly kill the jc-orchestrator tmux session.
# No-op if the session isn't running.

set -euo pipefail

SESSION="jc-orchestrator"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  BOLD=$'\033[1m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; GREEN=""; DIM=""; RESET=""
fi
log() { printf "%s[stop]%s %s\n"      "$BOLD" "$RESET" "$*"; }
ok()  { printf "%s[stop]%s %s%s%s\n" "$BOLD" "$RESET" "$GREEN" "$*" "$RESET"; }

if ! command -v tmux >/dev/null 2>&1; then
  printf "%s[stop]%s tmux not found — nothing to stop.\n" "$BOLD" "$RESET"
  exit 0
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  log "killing tmux session ${SESSION}…"
  tmux kill-session -t "$SESSION"
  ok "${SESSION} stopped."
else
  printf "%s[stop]%s %s${SESSION} not running — nothing to stop.%s\n" \
    "$BOLD" "$RESET" "$DIM" "$RESET"
fi
