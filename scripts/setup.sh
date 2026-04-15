#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# jellyclaw — dev environment setup
# -----------------------------------------------------------------------------
# Idempotent. Safe to re-run. Verifies required tools, installs deps, builds,
# runs the test suite, and smoke-tests the CLI.
#
# Usage:  ./scripts/setup.sh
# -----------------------------------------------------------------------------

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BLUE=$'\033[0;34m'; NC=$'\033[0m'
info()  { printf "%b[setup]%b %s\n" "$BLUE"   "$NC" "$*"; }
ok()    { printf "%b[ ok ]%b %s\n"  "$GREEN"  "$NC" "$*"; }
warn()  { printf "%b[warn]%b %s\n"  "$YELLOW" "$NC" "$*"; }
fail()  { printf "%b[fail]%b %s\n"  "$RED"    "$NC" "$*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# 1. Verify prerequisites
# -----------------------------------------------------------------------------
info "Checking prerequisites…"

if command -v bun >/dev/null 2>&1; then
  BUN_VERSION="$(bun --version)"
  ok "bun $BUN_VERSION"
  PKG_MGR="bun"
elif command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version)"
  ok "node $NODE_VERSION (bun not found — falling back to npm)"
  if ! command -v npm >/dev/null 2>&1; then
    fail "npm is required when bun is not installed"
  fi
  PKG_MGR="npm"
else
  fail "Neither bun (preferred, >=1.1) nor node (>=20.6) is installed."
fi

# -----------------------------------------------------------------------------
# 2. Install dependencies
# -----------------------------------------------------------------------------
info "Installing dependencies with $PKG_MGR…"
if [[ "$PKG_MGR" == "bun" ]]; then
  bun install
else
  npm install
fi
ok "dependencies installed"

# -----------------------------------------------------------------------------
# 3. Set up .env.local if missing
# -----------------------------------------------------------------------------
if [[ ! -f ".env.local" ]]; then
  cp .env.example .env.local
  warn ".env.local created from .env.example — fill in ANTHROPIC_API_KEY before running the CLI"
else
  ok ".env.local already present"
fi

# -----------------------------------------------------------------------------
# 4. Build
# -----------------------------------------------------------------------------
info "Building with tsup…"
if [[ "$PKG_MGR" == "bun" ]]; then
  bun run build
else
  npm run build
fi
chmod +x dist/cli.js
ok "dist/cli.js built and marked executable"

# -----------------------------------------------------------------------------
# 5. Test
# -----------------------------------------------------------------------------
info "Running vitest…"
if [[ "$PKG_MGR" == "bun" ]]; then
  bun run test
else
  npm run test
fi
ok "tests green"

# -----------------------------------------------------------------------------
# 6. Smoke test
# -----------------------------------------------------------------------------
info "Smoke test: dist/cli.js run 'hello from setup.sh'"
if ./dist/cli.js run "hello from setup.sh" >/dev/null; then
  ok "CLI smoke test passed"
else
  fail "CLI smoke test failed"
fi

# -----------------------------------------------------------------------------
printf "\n%b==========================================================%b\n" "$GREEN" "$NC"
printf "%bjellyclaw dev env ready.%b\n" "$GREEN" "$NC"
printf "  • edit .env.local to set your API keys\n"
printf "  • run  bun run dev   for watch-mode\n"
printf "  • see  scripts/day-1.md  for the Day-1 walkthrough\n"
printf "%b==========================================================%b\n" "$GREEN" "$NC"
