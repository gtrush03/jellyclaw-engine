#!/usr/bin/env bash
# install-jc.sh — idempotent install of the `jc` CLI to /usr/local/bin.
# Symlinks scripts/orchestrator/jc → /usr/local/bin/jc. If /usr/local/bin isn't
# writable, offers sudo + ~/bin alternatives. Verifies via `command -v jc`.

set -euo pipefail

ORCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${ORCH_DIR}/jc"
TARGET_DIR="/usr/local/bin"
TARGET="${TARGET_DIR}/jc"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
  GOLD=$'\033[38;5;179m'; BOLD=$'\033[1m'; DIM=$'\033[2m'
  GREEN=$'\033[32m'; AMBER=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
else
  GOLD=""; BOLD=""; DIM=""; GREEN=""; AMBER=""; RED=""; RESET=""
fi
log()  { printf "%s[install-jc]%s %s\n"      "$BOLD" "$RESET" "$*"; }
ok()   { printf "%s[install-jc]%s %s%s%s\n" "$BOLD" "$RESET" "$GREEN" "$*" "$RESET"; }
warn() { printf "%s[install-jc]%s %s%s%s\n" "$BOLD" "$RESET" "$AMBER" "$*" "$RESET"; }
err()  { printf "%s[install-jc]%s %s%s%s\n" "$BOLD" "$RESET" "$RED"   "$*" "$RESET"; }

if [[ ! -f "$SRC" ]]; then
  err "cannot find $SRC — run this from inside the repo."
  exit 1
fi

chmod +x "$SRC" || true

# If /usr/local/bin exists and is writable, symlink there.
if [[ -d "$TARGET_DIR" && -w "$TARGET_DIR" ]]; then
  if [[ -L "$TARGET" ]]; then
    existing="$(readlink "$TARGET")"
    if [[ "$existing" == "$SRC" ]]; then
      ok "already installed: $TARGET → $SRC"
    else
      log "overwriting existing symlink: $existing → $SRC"
      ln -sf "$SRC" "$TARGET"
    fi
  elif [[ -e "$TARGET" ]]; then
    warn "$TARGET exists and is not a symlink — refusing to overwrite."
    warn "  remove it manually, or install to ~/bin instead (see below)."
    exit 1
  else
    ln -s "$SRC" "$TARGET"
    ok "installed: $TARGET → $SRC"
  fi
else
  warn "$TARGET_DIR is not writable. Two options:"
  printf "  %s1)%s %ssudo ln -sf \"%s\" \"%s\"%s\n" \
    "$BOLD" "$RESET" "$GOLD" "$SRC" "$TARGET" "$RESET"
  printf "  %s2)%s install to \$HOME/bin instead (no sudo):\n" "$BOLD" "$RESET"
  printf "       %smkdir -p \"\$HOME/bin\"%s\n" "$GOLD" "$RESET"
  printf "       %sln -sf \"%s\" \"\$HOME/bin/jc\"%s\n" "$GOLD" "$SRC" "$RESET"
  printf "       %s# then ensure \$HOME/bin is on PATH (.zshrc / .bashrc)%s\n" "$DIM" "$RESET"
  exit 1
fi

# Verify.
if command -v jc >/dev/null 2>&1; then
  loc="$(command -v jc)"
  ok "\`jc\` found at ${loc}"
  # Run a quick sanity check — jc help should print "status".
  if jc help 2>/dev/null | grep -q "status"; then
    ok "help output looks healthy."
  else
    warn "jc help ran but output looked unexpected — check manually."
  fi
else
  warn "\`command -v jc\` failed — is $TARGET_DIR on your PATH?"
  warn "  echo \$PATH"
  exit 1
fi

printf "\n%snext steps%s\n" "$BOLD" "$RESET"
printf "  %sjc help%s           list all commands\n"          "$GOLD" "$RESET"
printf "  %s./spawn.sh%s        start the tmux supervision session\n" "$GOLD" "$RESET"
printf "  %stmux attach -t jc-orchestrator%s\n" "$GOLD" "$RESET"
