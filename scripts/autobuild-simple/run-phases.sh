#!/usr/bin/env bash
# run-phases.sh — chain entire phases end-to-end with a FRESH tmux + FRESH
# claude session per phase.
#
# Usage:
#   ./scripts/autobuild-simple/run-phases.sh T3 T4
#   ./scripts/autobuild-simple/run-phases.sh T2 T3 T4
#
# Behavior per phase:
#   1. Kill any existing `jc-autobuild` tmux session.
#   2. Run `./run.sh <phase>` (spawns fresh tmux + claude, feeds all prompts
#      in that tier, polls for DONE markers).
#   3. On exit 0 → move to next phase.
#   4. On non-zero → abort the whole chain and report which phase failed.
#
# State:
#   - All state logs appended to the same `.autobuild-simple/state.log`.
#   - Per-phase orchestrator logs: `.autobuild-simple/orchestrator-<phase>.log`

set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SESSION="jc-autobuild"
LOG_DIR="$REPO/.autobuild-simple"
mkdir -p "$LOG_DIR"
STATE_FILE="$LOG_DIR/state.log"
RUN_SH="$REPO/scripts/autobuild-simple/run.sh"

if [[ $# -eq 0 ]]; then
  echo "usage: $0 <phase> [<phase> ...]" >&2
  echo "  phase = T0 | T1 | T2 | T3 | T4" >&2
  exit 1
fi

log() {
  printf "[%s] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$STATE_FILE"
}

log "PHASE-CHAIN START — $*"

for PHASE in "$@"; do
  log "=== PHASE $PHASE — killing old tmux, spawning fresh ==="
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  sleep 2

  PHASE_LOG="$LOG_DIR/orchestrator-${PHASE}-$(date +%H%M%S).log"
  log "PHASE $PHASE — running ${RUN_SH} $PHASE → $PHASE_LOG"

  "$RUN_SH" "$PHASE" >> "$PHASE_LOG" 2>&1
  RC=$?
  if [[ $RC -ne 0 ]]; then
    log "PHASE $PHASE — FAILED (rc=$RC). Chain aborted."
    tail -5 "$PHASE_LOG" | sed 's/^/   /' >> "$STATE_FILE"
    exit $RC
  fi
  log "PHASE $PHASE — COMPLETE ✓"
done

log "PHASE-CHAIN DONE — all phases succeeded"
# Final cleanup — leave last tmux alive so user can attach for review.
