#!/usr/bin/env bash
# autobuild-simple — feed jellyclaw fix prompts into ONE tmux Claude session
# sequentially. After each prompt finishes, send the next.
#
# Design:
#   - One persistent tmux session running interactive `claude`.
#   - For each prompt file (sorted by id), send:
#       "Read <path>. Implement the fix. Run the acceptance tests from the
#        frontmatter. When done, print a line containing:
#        DONE: <id>"
#   - Poll the tmux pane every 5s until that marker appears (or timeout).
#   - Move on to the next prompt.
#
# Usage:
#   ./scripts/autobuild-simple/run.sh                    # all tiers T0..T4
#   ./scripts/autobuild-simple/run.sh T0                 # just T0
#   ./scripts/autobuild-simple/run.sh T0-01 T0-02        # specific prompts
#
# Watch progress:
#   tmux attach -t jc-autobuild
#
# Abort:
#   tmux kill-session -t jc-autobuild

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROMPTS_DIR="$REPO/prompts/phase-99b-unfucking-v2"
SESSION="jc-autobuild"
LOG_DIR="$REPO/.autobuild-simple"
mkdir -p "$LOG_DIR"
STATE_FILE="$LOG_DIR/state.log"
TIMEOUT_MIN=30      # per-prompt timeout
POLL_SEC=5          # pane-poll interval

# ---------------------------------------------------------------------------
# Collect prompt ids to run.
# ---------------------------------------------------------------------------
ALL_PROMPTS=()
while IFS= read -r f; do
  ALL_PROMPTS+=("$(basename "$f" .md)")
done < <(find "$PROMPTS_DIR" -maxdepth 1 -name "T*.md" | sort)

if [[ $# -eq 0 ]]; then
  PROMPTS=("${ALL_PROMPTS[@]}")
else
  PROMPTS=()
  for arg in "$@"; do
    # Prefix match — "T0" expands to all T0-*, "T0-02" matches that one.
    for p in "${ALL_PROMPTS[@]}"; do
      if [[ "$p" == "$arg"* ]]; then
        PROMPTS+=("$p")
      fi
    done
  done
fi

if [[ ${#PROMPTS[@]} -eq 0 ]]; then
  echo "no prompts matched args: $*" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Boot the tmux session with interactive claude.
# ---------------------------------------------------------------------------
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "reusing existing tmux session '$SESSION' (detach + attach to watch: tmux a -t $SESSION)"
else
  echo "starting tmux session '$SESSION' with interactive claude"
  tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$REPO"
  # Give it a big scrollback so we can grep far back.
  tmux set-option -t "$SESSION" history-limit 50000
  # Pipe the pane to a log file so we have a record outside tmux.
  tmux pipe-pane -t "$SESSION" -o "cat >> $LOG_DIR/tmux.log"
  # Start claude. `--dangerously-skip-permissions` means no approval prompts
  # block the loop. Drop that flag if you want per-action confirms.
  tmux send-keys -t "$SESSION" "claude --dangerously-skip-permissions" Enter
  echo "waiting for claude to boot..."
  sleep 8
fi

echo "===================================================================="
echo "autobuild-simple — ${#PROMPTS[@]} prompts queued"
printf "  - %s\n" "${PROMPTS[@]}"
echo "===================================================================="
echo "watch the worker:  tmux attach -t $SESSION"
echo "pane log file:     $LOG_DIR/tmux.log"
echo "state file:        $STATE_FILE"
echo "===================================================================="

# ---------------------------------------------------------------------------
# Per-prompt loop.
# ---------------------------------------------------------------------------
BASELINE_BYTES=0

send_prompt_to_claude() {
  local text="$1"
  # Use `-l` (literal) so tmux doesn't interpret chars like `;` in the prompt.
  tmux send-keys -t "$SESSION" -l "$text"
  # Claude Code's TUI sometimes swallows the first Enter (footer menu
  # intercepts or input-accept races). Wait a beat for the TUI to register
  # the full text, then submit TWICE with a small delay — first Enter
  # commits the text, second Enter (if input is empty) is a harmless no-op.
  sleep 1
  tmux send-keys -t "$SESSION" Enter
  sleep 1
  tmux send-keys -t "$SESSION" Enter
  # CRITICAL: baseline the pane AFTER the prompt has fully rendered. The
  # prompt text itself contains the DONE marker (as instructions) — if we
  # baselined BEFORE sending, the grep would match our own prompt echo and
  # false-positive the completion check.
  sleep 3
  BASELINE_BYTES=$(tmux capture-pane -t "$SESSION" -p -S - | wc -c | tr -d ' ')
}

pane_new_contains() {
  local needle="$1"
  # Anchor the marker at START-OF-LINE (after any TUI indent whitespace).
  # The prompt I sent has the marker embedded mid-paragraph, so it FAILS
  # the anchor. Claude's real completion — per our instruction — prints the
  # marker on its own line. This matches the anchor.
  #
  # Long prompt ids wrap across pane lines too, splitting the marker. This
  # method tolerates both cases because it only requires a line that STARTS
  # with the marker after whitespace.
  tmux capture-pane -t "$SESSION" -p -S - | awk -v n="$needle" '
    {
      s = $0
      sub(/^[[:space:]]+/, "", s)
      if (index(s, n) == 1) { found = 1; exit }
    }
    END { exit (found ? 0 : 1) }
  '
}

wait_for_done() {
  local id="$1"
  local marker="DONE: $id"
  local fail_marker="FAIL: $id"
  local deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
  local last_size=0
  local idle_ticks=0
  # Never return "complete" faster than MIN_WAIT — guards against the prompt
  # echo re-appearing below the baseline due to screen redraws.
  local min_wait_until=$(( $(date +%s) + 20 ))

  while (( $(date +%s) < deadline )); do
    if (( $(date +%s) >= min_wait_until )); then
      if pane_new_contains "$marker"; then
        return 0
      fi
      if pane_new_contains "$fail_marker"; then
        return 3
      fi
    fi
    # Liveness check — are we still getting output? If pane is idle for many
    # ticks AND claude isn't in the middle of a tool call, bail early.
    local size
    size=$(tmux capture-pane -t "$SESSION" -p -S - | wc -c)
    if (( size == last_size )); then
      idle_ticks=$((idle_ticks + 1))
    else
      idle_ticks=0
      last_size=$size
    fi
    # 120 ticks × 5s = 10 min of zero new output → probably stuck.
    # Opus 4.5 can think for 5+ minutes between tool calls; 2min was too tight.
    if (( idle_ticks >= 120 )); then
      echo "  ⚠ pane idle 10min; assuming claude is waiting at prompt" >&2
      return 2
    fi
    sleep "$POLL_SEC"
  done
  return 1   # timeout
}

log_state() {
  printf "[%s] %s\n" "$(date '+%Y-%m-%d %H:%M:%S')" "$1" | tee -a "$STATE_FILE"
}

log_state "autobuild-simple START — ${#PROMPTS[@]} prompts"

for ID in "${PROMPTS[@]}"; do
  FILE="$PROMPTS_DIR/$ID.md"
  if [[ ! -f "$FILE" ]]; then
    log_state "SKIP $ID (no file at $FILE)"
    continue
  fi

  log_state "SEND $ID"

  PROMPT="Read the spec at $FILE in full. Implement the fix exactly as specified in the 'Fix' section. Run every acceptance test from the frontmatter and confirm they all pass (show the output). When every test passes, print one final line on its own: DONE: $ID . If any test cannot pass, print one line: FAIL: $ID <reason> and stop."

  send_prompt_to_claude "$PROMPT"

  set +e
  wait_for_done "$ID"
  rc=$?
  set -e

  case "$rc" in
    0) log_state "COMPLETE $ID" ;;
    1) log_state "TIMEOUT $ID (>${TIMEOUT_MIN}min)"; exit 1 ;;
    2) log_state "IDLE-STUCK $ID — claude might need manual intervention; attach and investigate";
       exit 2 ;;
    3) log_state "FAIL $ID (claude reported FAIL marker)"; exit 3 ;;
  esac
done

log_state "autobuild-simple DONE"
echo "all prompts complete. detach & review: tmux attach -t $SESSION"
