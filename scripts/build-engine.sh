#!/usr/bin/env bash
# Build single-file jellyclaw binary using Bun's --compile flag (T4-06).
#
# Usage:
#   scripts/build-engine.sh --target arm64 --out dist/bin
#   scripts/build-engine.sh --target universal --sign "Developer ID Application: ..." --entitlements Engine.entitlements
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
TARGET=""
OUT_DIR="dist/bin"
SIGN_IDENTITY=""
ENTITLEMENTS=""
MAX_SIZE_MB=100

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --target <arch>       Required. One of: arm64, x86_64, universal
  --out <dir>           Output directory (default: dist/bin)
  --sign <identity>     Code-signing identity (optional, skips if not provided)
  --entitlements <path> Entitlements file for codesigning
  -h, --help            Show this help

Examples:
  $(basename "$0") --target arm64 --out dist/bin
  $(basename "$0") --target universal --sign "Developer ID Application: ACME" --entitlements Engine.entitlements
EOF
  exit 0
}

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="$2"
      shift 2
      ;;
    --out)
      OUT_DIR="$2"
      shift 2
      ;;
    --sign)
      SIGN_IDENTITY="$2"
      shift 2
      ;;
    --entitlements)
      ENTITLEMENTS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    *)
      echo "Error: Unknown option $1" >&2
      usage
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate
# ---------------------------------------------------------------------------
if [[ -z "$TARGET" ]]; then
  echo "Error: --target is required (arm64, x86_64, or universal)" >&2
  exit 1
fi

case "$TARGET" in
  arm64|x86_64|universal)
    ;;
  *)
    echo "Error: --target must be one of: arm64, x86_64, universal" >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Detect platform
# ---------------------------------------------------------------------------
OS="$(uname -s)"
if [[ "$OS" != "Darwin" ]]; then
  echo "Warning: This script is optimized for macOS. Some features may not work on $OS." >&2
fi

# ---------------------------------------------------------------------------
# Functions
# ---------------------------------------------------------------------------
get_bun_target() {
  local arch="$1"
  case "$arch" in
    arm64)
      echo "bun-darwin-arm64"
      ;;
    x86_64)
      echo "bun-darwin-x64"
      ;;
    *)
      echo "Error: Unsupported architecture $arch" >&2
      exit 1
      ;;
  esac
}

compile_single() {
  local arch="$1"
  local bun_target
  bun_target="$(get_bun_target "$arch")"
  local outfile="${OUT_DIR}/jellyclaw-${arch}"

  echo "Compiling for ${arch} (target: ${bun_target})..."

  bun build ./engine/src/cli/main.ts \
    --compile \
    --target="${bun_target}" \
    --outfile="${outfile}"

  echo "Stripping debug symbols..."
  strip -S "${outfile}" 2>/dev/null || echo "Warning: strip not available or failed"

  # Check size
  local size_bytes
  size_bytes="$(stat -f%z "${outfile}" 2>/dev/null || stat -c%s "${outfile}" 2>/dev/null || echo 0)"
  local size_mb=$((size_bytes / 1024 / 1024))

  if [[ "$size_mb" -gt "$MAX_SIZE_MB" ]]; then
    echo "Error: Binary size ${size_mb}MB exceeds budget of ${MAX_SIZE_MB}MB" >&2
    exit 1
  fi

  echo "Binary size: ${size_mb}MB (budget: ${MAX_SIZE_MB}MB)"

  # Code signing (if identity provided)
  if [[ -n "$SIGN_IDENTITY" ]]; then
    echo "Code signing with identity: ${SIGN_IDENTITY}..."
    local sign_args=(--options runtime --timestamp --force --sign "$SIGN_IDENTITY")
    if [[ -n "$ENTITLEMENTS" ]]; then
      sign_args+=(--entitlements "$ENTITLEMENTS")
    fi
    codesign "${sign_args[@]}" "${outfile}"
    echo "Code signing complete."
  fi

  # Emit metadata JSON
  emit_meta "$arch" "$outfile"
}

emit_meta() {
  local arch="$1"
  local outfile="$2"
  local meta_file="${outfile}.meta.json"

  local sha256
  sha256="$(shasum -a 256 "${outfile}" | awk '{print $1}')"

  local size_bytes
  size_bytes="$(stat -f%z "${outfile}" 2>/dev/null || stat -c%s "${outfile}" 2>/dev/null || echo 0)"

  local built_at
  built_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  local commit
  commit="$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")"

  local bun_version
  bun_version="$(bun --version 2>/dev/null || echo "unknown")"

  cat > "${meta_file}" <<EOF
{
  "sha256": "${sha256}",
  "size_bytes": ${size_bytes},
  "built_at": "${built_at}",
  "commit": "${commit}",
  "bun_version": "${bun_version}",
  "target": "${arch}"
}
EOF

  echo "Metadata written to ${meta_file}"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
mkdir -p "${OUT_DIR}"

if [[ "$TARGET" == "universal" ]]; then
  # Build both architectures
  compile_single "arm64"
  compile_single "x86_64"

  # Create universal binary with lipo
  echo "Creating universal binary with lipo..."
  lipo -create \
    "${OUT_DIR}/jellyclaw-arm64" \
    "${OUT_DIR}/jellyclaw-x86_64" \
    -output "${OUT_DIR}/jellyclaw-universal"

  echo "Stripping universal binary..."
  strip -S "${OUT_DIR}/jellyclaw-universal" 2>/dev/null || true

  # Code sign the universal binary
  if [[ -n "$SIGN_IDENTITY" ]]; then
    echo "Code signing universal binary..."
    local sign_args=(--options runtime --timestamp --force --sign "$SIGN_IDENTITY")
    if [[ -n "$ENTITLEMENTS" ]]; then
      sign_args+=(--entitlements "$ENTITLEMENTS")
    fi
    codesign "${sign_args[@]}" "${OUT_DIR}/jellyclaw-universal"
  fi

  # Emit metadata for universal
  emit_meta "universal" "${OUT_DIR}/jellyclaw-universal"

  echo "Universal binary created at ${OUT_DIR}/jellyclaw-universal"
else
  compile_single "$TARGET"
  echo "Binary created at ${OUT_DIR}/jellyclaw-${TARGET}"
fi

echo "Build complete!"
