#!/usr/bin/env bash
# T4-07: npm publish script for @jellyclaw/engine
# Usage: scripts/publish-npm.sh [--dry-run] [--sandbox <dir>] [--tag <npm-tag>]
set -euo pipefail

# --- Defaults ---
DRY_RUN=false
SANDBOX=""
NPM_TAG="latest"
MAX_SIZE_MB=30

# --- Parse args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --sandbox)
      SANDBOX="$2"
      shift 2
      ;;
    --tag)
      NPM_TAG="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# --- Helpers ---
die() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "• $*"; }

# --- Pre-flight checks (only in non-dry-run mode without sandbox) ---
if [[ "$DRY_RUN" == "false" && -z "$SANDBOX" ]]; then
  # Check for clean tree
  if [[ -n "$(git status --porcelain)" ]]; then
    die "Working tree is not clean. Commit or stash changes first."
  fi

  # Check for tagged commit
  TAG=$(git describe --exact-match --tags HEAD 2>/dev/null || true)
  if [[ -z "$TAG" ]]; then
    die "HEAD is not a tagged commit. Tag with 'git tag vX.Y.Z' first."
  fi
  info "Publishing tag: $TAG"

  # Check for NPM token
  if [[ -z "${NODE_AUTH_TOKEN:-}" && -z "${NPM_TOKEN:-}" ]]; then
    die "Neither NODE_AUTH_TOKEN nor NPM_TOKEN is set."
  fi
fi

# --- Build (skip if sandbox with pre-built dist) ---
if [[ -z "$SANDBOX" || ! -d "engine/dist" ]]; then
  info "Running typecheck..."
  bun run typecheck

  info "Running lint..."
  bun run lint

  info "Running tests..."
  bun run test

  info "Building..."
  bun run build
fi

# --- Pack ---
cd engine
info "Packing tarball..."
TARBALL=$(npm pack --json 2>/dev/null | grep '"filename"' | head -1 | sed 's/.*"filename": *"\([^"]*\)".*/\1/' || true)

# Fallback: find tarball if JSON parse failed
if [[ -z "$TARBALL" || ! -f "$TARBALL" ]]; then
  TARBALL=$(ls -t *.tgz 2>/dev/null | head -1)
fi

if [[ -z "$TARBALL" || ! -f "$TARBALL" ]]; then
  die "npm pack did not produce a tarball"
fi
info "Created tarball: $TARBALL"

# --- Validate tarball size ---
SIZE_BYTES=$(wc -c < "$TARBALL" | tr -d ' ')
SIZE_MB=$((SIZE_BYTES / 1024 / 1024))
info "Tarball size: ${SIZE_MB}MB (${SIZE_BYTES} bytes)"

if [[ $SIZE_MB -ge $MAX_SIZE_MB ]]; then
  die "Tarball too large: ${SIZE_MB}MB >= ${MAX_SIZE_MB}MB limit"
fi

# --- Validate bin/ entries ---
info "Validating bin/ entries in tarball..."
for BIN in jellyclaw jellyclaw-serve jellyclaw-daemon; do
  if ! tar -tzf "$TARBALL" | grep -q "package/bin/${BIN}$"; then
    die "Missing bin entry: bin/${BIN}"
  fi
done
info "All bin entries present"

# --- Dry-run: install to sandbox ---
if [[ "$DRY_RUN" == "true" && -n "$SANDBOX" ]]; then
  info "Installing to sandbox: $SANDBOX"
  mkdir -p "$SANDBOX"
  npm install -g "$(pwd)/$TARBALL" --prefix "$SANDBOX"

  # Verify jellyclaw exists and is executable
  if [[ ! -x "$SANDBOX/bin/jellyclaw" ]]; then
    die "jellyclaw not executable in sandbox"
  fi

  info "Sandbox install successful"
  info "Testing: $SANDBOX/bin/jellyclaw --version"
  "$SANDBOX/bin/jellyclaw" --version || die "jellyclaw --version failed"

  # Cleanup tarball
  rm -f "$TARBALL"
  info "Dry-run complete. Sandbox at: $SANDBOX"
  exit 0
fi

# --- Publish ---
if [[ "$DRY_RUN" == "true" ]]; then
  info "Dry-run: would publish $TARBALL with tag '$NPM_TAG'"
  rm -f "$TARBALL"
  exit 0
fi

info "Publishing to npm with tag '$NPM_TAG'..."
npm publish "$TARBALL" --tag "$NPM_TAG" --access public

# Cleanup
rm -f "$TARBALL"
info "Published successfully!"
