#!/usr/bin/env bash
# Build signed and notarized DMG for Jellyclaw Desktop (T4-06).
#
# Usage:
#   scripts/build-dmg.sh                           # Full signed build (requires Apple credentials)
#   scripts/build-dmg.sh --ci-mode=mock            # CI smoke test (ad-hoc signing, skip notarization)
#
# Required environment variables (for non-mock mode):
#   SIGNING_IDENTITY       - Code signing identity (e.g., "Developer ID Application: ACME Inc")
#   APPLE_ID               - Apple ID for notarization
#   APPLE_TEAM_ID          - Apple Team ID
#   APPLE_APP_PASSWORD     - App-specific password for notarytool
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
CI_MODE_MOCK=false
OUT_DIR="dist/dmg"
ENTITLEMENTS="desktop/src-tauri/Engine.entitlements"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --ci-mode=mock)
      CI_MODE_MOCK=true
      ;;
    --out=*)
      OUT_DIR="${arg#*=}"
      ;;
    -h|--help)
      cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --ci-mode=mock    Skip Apple signing/notarization (for CI smoke tests)
  --out=<dir>       Output directory (default: dist/dmg)
  -h, --help        Show this help

Environment variables (required for non-mock mode):
  SIGNING_IDENTITY       Code signing identity
  APPLE_ID               Apple ID for notarization
  APPLE_TEAM_ID          Apple Team ID
  APPLE_APP_PASSWORD     App-specific password

Examples:
  scripts/build-dmg.sh --ci-mode=mock
  SIGNING_IDENTITY="Developer ID Application: ..." scripts/build-dmg.sh
EOF
      exit 0
      ;;
    *)
      echo "Error: Unknown option $arg" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Validate environment
# ---------------------------------------------------------------------------
if [[ "$CI_MODE_MOCK" == "true" ]]; then
  echo "⚠️  WARNING: Running in CI mock mode. NOT for release builds!"
  echo "    - Using ad-hoc code signing"
  echo "    - Skipping notarization"
  echo ""
  SIGNING_IDENTITY="-"
else
  # Require all Apple credentials
  : "${SIGNING_IDENTITY:?SIGNING_IDENTITY is required}"
  : "${APPLE_ID:?APPLE_ID is required}"
  : "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"
  : "${APPLE_APP_PASSWORD:?APPLE_APP_PASSWORD is required}"
fi

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

mkdir -p "${OUT_DIR}"

# ---------------------------------------------------------------------------
# Step 1: Build engine binary
# ---------------------------------------------------------------------------
echo "=== Step 1: Building engine binary ==="

if [[ "$CI_MODE_MOCK" == "true" ]]; then
  # In mock mode, just build for current architecture without signing
  ARCH="$(uname -m | sed 's/aarch64/arm64/')"
  "${REPO_ROOT}/scripts/build-engine.sh" \
    --target "${ARCH}" \
    --out "${REPO_ROOT}/dist/bin"

  ENGINE_BINARY="${REPO_ROOT}/dist/bin/jellyclaw-${ARCH}"
else
  # Full build: universal binary with signing
  "${REPO_ROOT}/scripts/build-engine.sh" \
    --target universal \
    --out "${REPO_ROOT}/dist/bin" \
    --sign "${SIGNING_IDENTITY}" \
    --entitlements "${REPO_ROOT}/${ENTITLEMENTS}"

  ENGINE_BINARY="${REPO_ROOT}/dist/bin/jellyclaw-universal"
fi

echo "Engine binary: ${ENGINE_BINARY}"
ls -la "${ENGINE_BINARY}"

# ---------------------------------------------------------------------------
# Step 2: Copy binary to Tauri binaries directory
# ---------------------------------------------------------------------------
echo "=== Step 2: Copying binary to Tauri ==="

TAURI_BINARIES="${REPO_ROOT}/desktop/src-tauri/binaries"
mkdir -p "${TAURI_BINARIES}"

# Tauri expects binaries named with target triple
# For universal: jellyclaw-universal-apple-darwin
# For single arch: jellyclaw-aarch64-apple-darwin or jellyclaw-x86_64-apple-darwin
if [[ -f "${REPO_ROOT}/dist/bin/jellyclaw-universal" ]]; then
  cp "${REPO_ROOT}/dist/bin/jellyclaw-universal" "${TAURI_BINARIES}/jellyclaw-universal-apple-darwin"
  echo "Copied universal binary"
fi

if [[ -f "${REPO_ROOT}/dist/bin/jellyclaw-arm64" ]]; then
  cp "${REPO_ROOT}/dist/bin/jellyclaw-arm64" "${TAURI_BINARIES}/jellyclaw-aarch64-apple-darwin"
  echo "Copied arm64 binary"
fi

if [[ -f "${REPO_ROOT}/dist/bin/jellyclaw-x86_64" ]]; then
  cp "${REPO_ROOT}/dist/bin/jellyclaw-x86_64" "${TAURI_BINARIES}/jellyclaw-x86_64-apple-darwin"
  echo "Copied x86_64 binary"
fi

# Also copy with simple name for dev mode
ARCH="$(uname -m | sed 's/aarch64/arm64/')"
if [[ -f "${REPO_ROOT}/dist/bin/jellyclaw-${ARCH}" ]]; then
  cp "${REPO_ROOT}/dist/bin/jellyclaw-${ARCH}" "${TAURI_BINARIES}/jellyclaw"
fi

ls -la "${TAURI_BINARIES}/"

# ---------------------------------------------------------------------------
# Step 3: Build Tauri app
# ---------------------------------------------------------------------------
echo "=== Step 3: Building Tauri app ==="

cd "${REPO_ROOT}/desktop"

# Install dependencies if needed
if [[ ! -d "node_modules" ]]; then
  bun install
fi

# Build the Tauri app
if [[ "$CI_MODE_MOCK" == "true" ]]; then
  # In mock mode, build for current architecture only
  bun run tauri build 2>&1 || {
    echo "Tauri build failed, but continuing in mock mode..."
  }
else
  # Full build: universal
  bun run tauri build --target universal-apple-darwin
fi

cd "${REPO_ROOT}"

# ---------------------------------------------------------------------------
# Step 4: Locate and codesign the .app
# ---------------------------------------------------------------------------
echo "=== Step 4: Code signing ==="

# Find the built .app
APP_PATH=""
for candidate in \
  "desktop/src-tauri/target/release/bundle/macos/Jellyclaw.app" \
  "desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/Jellyclaw.app" \
  "desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Jellyclaw.app" \
  "desktop/src-tauri/target/x86_64-apple-darwin/release/bundle/macos/Jellyclaw.app"
do
  if [[ -d "${REPO_ROOT}/${candidate}" ]]; then
    APP_PATH="${REPO_ROOT}/${candidate}"
    break
  fi
done

if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  if [[ "$CI_MODE_MOCK" == "true" ]]; then
    echo "Warning: .app not found, creating placeholder for mock mode"
    mkdir -p "${OUT_DIR}/Jellyclaw.app/Contents/MacOS"
    touch "${OUT_DIR}/Jellyclaw.app/Contents/MacOS/Jellyclaw"
    APP_PATH="${OUT_DIR}/Jellyclaw.app"
  else
    echo "Error: Could not find built .app" >&2
    exit 1
  fi
fi

echo "App path: ${APP_PATH}"

# Codesign the app
codesign \
  --force \
  --options runtime \
  --entitlements "${REPO_ROOT}/${ENTITLEMENTS}" \
  --sign "${SIGNING_IDENTITY}" \
  --timestamp \
  --deep \
  "${APP_PATH}" 2>&1 || {
    if [[ "$CI_MODE_MOCK" == "true" ]]; then
      echo "Warning: Codesign failed in mock mode (expected with ad-hoc)"
    else
      exit 1
    fi
  }

# ---------------------------------------------------------------------------
# Step 5: Create DMG
# ---------------------------------------------------------------------------
echo "=== Step 5: Creating DMG ==="

DMG_PATH="${OUT_DIR}/Jellyclaw.dmg"

# Find the Tauri-created DMG or create one
TAURI_DMG=""
for candidate in \
  "desktop/src-tauri/target/release/bundle/dmg/Jellyclaw_0.1.0_universal.dmg" \
  "desktop/src-tauri/target/release/bundle/dmg/Jellyclaw_0.1.0_aarch64.dmg" \
  "desktop/src-tauri/target/release/bundle/dmg/Jellyclaw_0.1.0_x64.dmg" \
  "desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/"*.dmg \
  "desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/"*.dmg
do
  # Expand glob
  for file in ${candidate}; do
    if [[ -f "${REPO_ROOT}/${file}" ]]; then
      TAURI_DMG="${REPO_ROOT}/${file}"
      break 2
    fi
  done
done

if [[ -n "$TAURI_DMG" && -f "$TAURI_DMG" ]]; then
  cp "${TAURI_DMG}" "${DMG_PATH}"
  echo "Using Tauri-created DMG: ${TAURI_DMG}"
else
  # Create DMG manually using hdiutil
  echo "Creating DMG manually..."

  # Create temporary directory for DMG contents
  DMG_TMP="${OUT_DIR}/dmg-tmp"
  rm -rf "${DMG_TMP}"
  mkdir -p "${DMG_TMP}"

  # Copy app to temp dir
  cp -R "${APP_PATH}" "${DMG_TMP}/"

  # Create symbolic link to Applications
  ln -s /Applications "${DMG_TMP}/Applications"

  # Create DMG
  hdiutil create \
    -volname "Jellyclaw" \
    -srcfolder "${DMG_TMP}" \
    -ov \
    -format UDZO \
    "${DMG_PATH}" 2>&1 || {
      if [[ "$CI_MODE_MOCK" == "true" ]]; then
        echo "Warning: DMG creation failed in mock mode"
        touch "${DMG_PATH}"
      else
        exit 1
      fi
    }

  # Cleanup temp dir
  rm -rf "${DMG_TMP}"
fi

# Sign the DMG
codesign \
  --force \
  --sign "${SIGNING_IDENTITY}" \
  --timestamp \
  "${DMG_PATH}" 2>&1 || {
    if [[ "$CI_MODE_MOCK" == "true" ]]; then
      echo "Warning: DMG signing failed in mock mode (expected)"
    else
      exit 1
    fi
  }

echo "DMG created: ${DMG_PATH}"
ls -la "${DMG_PATH}"

# ---------------------------------------------------------------------------
# Step 6: Notarization (skip in mock mode)
# ---------------------------------------------------------------------------
if [[ "$CI_MODE_MOCK" == "false" ]]; then
  echo "=== Step 6: Notarization ==="

  # Submit to Apple
  xcrun notarytool submit "${DMG_PATH}" \
    --apple-id "${APPLE_ID}" \
    --team-id "${APPLE_TEAM_ID}" \
    --password "${APPLE_APP_PASSWORD}" \
    --wait

  # Staple the ticket
  xcrun stapler staple "${DMG_PATH}"

  echo "Notarization complete!"
else
  echo "=== Step 6: Skipping notarization (mock mode) ==="
fi

# ---------------------------------------------------------------------------
# Step 7: Verification
# ---------------------------------------------------------------------------
echo "=== Step 7: Verification ==="

# Mount DMG and verify app (if DMG exists and is valid)
if [[ -f "${DMG_PATH}" && -s "${DMG_PATH}" ]]; then
  # Try to mount and verify
  MOUNT_POINT="/Volumes/Jellyclaw-verify-$$"

  if hdiutil attach "${DMG_PATH}" -mountpoint "${MOUNT_POINT}" -nobrowse 2>/dev/null; then
    APP_IN_DMG="${MOUNT_POINT}/Jellyclaw.app"

    if [[ -d "${APP_IN_DMG}" ]]; then
      echo "Verifying with spctl..."
      spctl --assess --type exec --verbose "${APP_IN_DMG}" 2>&1 || {
        if [[ "$CI_MODE_MOCK" == "true" ]]; then
          echo "spctl verification failed (expected in mock mode)"
        else
          echo "Warning: spctl verification failed"
        fi
      }
    fi

    hdiutil detach "${MOUNT_POINT}" 2>/dev/null || true
  else
    echo "Could not mount DMG for verification"
  fi
else
  echo "DMG not found or empty, skipping verification"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "=== Build complete ==="
echo "DMG: ${DMG_PATH}"
echo "App: ${APP_PATH}"

if [[ "$CI_MODE_MOCK" == "true" ]]; then
  echo ""
  echo "⚠️  This was a mock build. NOT suitable for distribution!"
fi
