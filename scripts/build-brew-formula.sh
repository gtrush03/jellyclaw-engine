#!/usr/bin/env bash
# T4-07: Homebrew formula generator for Jellyclaw
# Usage: scripts/build-brew-formula.sh --tag <version> --dmg-url <url> --dmg-sha <sha256>
set -euo pipefail

# --- Defaults ---
TAG=""
DMG_URL=""
DMG_SHA=""
OUTPUT_DIR="homebrew"

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)
      TAG="$2"
      shift 2
      ;;
    --dmg-url)
      DMG_URL="$2"
      shift 2
      ;;
    --dmg-sha)
      DMG_SHA="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# --- Validate args ---
if [[ -z "$TAG" || -z "$DMG_URL" || -z "$DMG_SHA" ]]; then
  echo "Usage: $0 --tag <version> --dmg-url <url> --dmg-sha <sha256>" >&2
  exit 1
fi

# Strip leading 'v' from tag for version
VERSION="${TAG#v}"

# --- Find template ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATE="$REPO_ROOT/homebrew/jellyclaw.rb.template"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "ERROR: Template not found at $TEMPLATE" >&2
  exit 1
fi

# --- Generate formula ---
mkdir -p "$REPO_ROOT/$OUTPUT_DIR"
OUTPUT_FILE="$REPO_ROOT/$OUTPUT_DIR/jellyclaw.rb"

sed \
  -e "s|__VERSION__|${VERSION}|g" \
  -e "s|__DMG_URL__|${DMG_URL}|g" \
  -e "s|__DMG_SHA256__|${DMG_SHA}|g" \
  "$TEMPLATE" > "$OUTPUT_FILE"

echo "Generated formula: $OUTPUT_FILE"
echo "  Version: $VERSION"
echo "  URL: $DMG_URL"
echo "  SHA256: $DMG_SHA"

# --- Verify no placeholders remain ---
REMAINING=$(grep -c "__DMG_URL__\|__DMG_SHA256__\|__VERSION__" "$OUTPUT_FILE" || true)
if [[ "$REMAINING" -ne 0 ]]; then
  echo "ERROR: $REMAINING placeholder(s) remain in output" >&2
  exit 1
fi

echo "Formula generated successfully"
