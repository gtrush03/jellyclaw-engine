#!/usr/bin/env bash
# scripts/record-demo.sh
#
# Record a 25–30s asciinema cast of `jellyclaw tui` for the landing page.
#
# Usage:
#   scripts/record-demo.sh                # records into site/assets/demo.cast
#   OUT=path/to/out.cast scripts/record-demo.sh
#
# Requires asciinema:  brew install asciinema
#
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if ! command -v asciinema >/dev/null 2>&1; then
  echo "error: asciinema not installed. install with: brew install asciinema" >&2
  exit 2
fi

OUT="${OUT:-site/assets/demo.cast}"
SCRIPT="${SCRIPT:-scripts/demo-script.txt}"
TITLE="${TITLE:-jellyclaw demo — open-source agent runtime}"

mkdir -p "$(dirname "$OUT")"

if [[ ! -f "$SCRIPT" ]]; then
  echo "error: demo script not found at $SCRIPT" >&2
  echo "expected a plain-text file with one user message per line" >&2
  exit 3
fi

# Build the inner command. If the TUI binary supports --demo-script we use it
# directly; otherwise fall back to feeding stdin via a tiny here-doc loop the
# operator can replace with `expect` once that path is wired up.
TUI_BIN="${TUI_BIN:-node engine/bin/jellyclaw}"

inner="$TUI_BIN tui --demo-script $repo_root/$SCRIPT"

echo "recording → $OUT"
echo "  title:   $TITLE"
echo "  script:  $SCRIPT"
echo "  command: $inner"
echo

# -q quiet, -t title, --overwrite to replace, --idle-time-limit to trim gaps.
asciinema rec "$OUT" \
  --overwrite \
  --idle-time-limit 1.5 \
  --cols 96 \
  --rows 28 \
  -t "$TITLE" \
  -c "$inner"

bytes=$(wc -c < "$OUT")
echo
echo "wrote: $OUT  (${bytes} bytes)"
echo "preview: $(head -c 120 "$OUT")"
