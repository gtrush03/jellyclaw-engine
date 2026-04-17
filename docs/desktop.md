# Jellyclaw Desktop

Tauri 2 desktop application that bundles the jellyclaw engine as a sidecar binary.

## Quick Start

### Local Development

```bash
# Build the engine binary (required first time)
scripts/build-engine.sh --target "$(uname -m | sed 's/aarch64/arm64/')" --out dist/bin

# Copy to Tauri binaries directory
mkdir -p desktop/src-tauri/binaries
cp dist/bin/jellyclaw-* desktop/src-tauri/binaries/jellyclaw

# Start Tauri dev mode
cd desktop
bun install
bun run tauri dev
```

The dev mode will:
1. Start a Vite dev server for the frontend
2. Build and launch the Tauri app
3. Spawn the jellyclaw engine sidecar on a random port
4. Provide the port and auth token to the frontend via IPC

### Building for Release

```bash
# Full signed build (requires Apple Developer credentials)
SIGNING_IDENTITY="Developer ID Application: Your Name" \
APPLE_ID="your@email.com" \
APPLE_TEAM_ID="ABCD1234" \
APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx" \
scripts/build-dmg.sh

# Mock build for testing (ad-hoc signing, no notarization)
scripts/build-dmg.sh --ci-mode=mock
```

## Architecture

```
┌──────────────────────────────────────────────────┐
│ Jellyclaw.app                                    │
├──────────────────────────────────────────────────┤
│ ┌──────────────┐     ┌─────────────────────────┐ │
│ │ Tauri Shell  │────▶│ Sidecar Supervisor      │ │
│ │ (Rust)       │     │ (sidecar.rs)            │ │
│ └──────┬───────┘     └──────────┬──────────────┘ │
│        │                        │                │
│        │ IPC                    │ spawn/manage   │
│        ▼                        ▼                │
│ ┌──────────────┐     ┌─────────────────────────┐ │
│ │ WebView      │────▶│ jellyclaw binary        │ │
│ │ (Frontend)   │ HTTP│ (Bun-compiled sidecar)  │ │
│ └──────────────┘     └─────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

### Components

- **Tauri Shell** (`desktop/src-tauri/src/main.rs`): Main Rust application that creates the window and manages IPC
- **Sidecar Supervisor** (`desktop/src-tauri/src/sidecar.rs`): Spawns and manages the jellyclaw engine process
- **WebView Frontend** (`desktop/src/`): TypeScript/React frontend that communicates with the engine
- **Sidecar Client** (`desktop/src/lib/sidecar.ts`): TypeScript client for IPC and HTTP communication

### Communication Flow

1. App starts → Tauri main initializes
2. Frontend calls `invoke("get_sidecar_info")` via IPC
3. Sidecar supervisor spawns `jellyclaw serve --port 0 --token-env JELLYCLAW_AUTH_TOKEN`
4. Supervisor reads stderr until it sees the "listening on" message, extracts port
5. Supervisor returns `{ port, token }` to frontend
6. Frontend opens SSE connection to `http://127.0.0.1:<port>/events` with `Authorization: Bearer <token>`

## Gatekeeper Verification

After downloading the DMG:

```bash
# Mount the DMG
hdiutil attach /path/to/Jellyclaw.dmg

# Verify the app is properly signed and notarized
spctl --assess --type exec --verbose /Volumes/Jellyclaw/Jellyclaw.app

# Expected output for successful verification:
# /Volumes/Jellyclaw/Jellyclaw.app: accepted
# source=Notarized Developer ID
```

## Troubleshooting

### "Jellyclaw is damaged and can't be opened"

This usually means the app wasn't properly code-signed or notarized.

**Fix**: Download the app again from the official release. If building locally, ensure you have a valid Developer ID certificate.

### "Jellyclaw can't be opened because Apple cannot check it for malicious software"

This happens when the app is signed but not notarized.

**Temporary workaround** (not recommended for production):
```bash
xattr -cr /Applications/Jellyclaw.app
```

**Proper fix**: The app needs to be submitted to Apple for notarization. See the CI workflow.

### Sidecar fails to start

Check the Console.app for logs from the jellyclaw binary:

```bash
log show --predicate 'process == "jellyclaw"' --last 5m
```

Common causes:
- Missing JIT entitlements (the app needs `com.apple.security.cs.allow-jit`)
- Library validation issues (may need `com.apple.security.cs.disable-library-validation`)
- Binary not found in the app bundle (check `Contents/Resources/binaries/`)

### Port already in use

The sidecar supervisor uses port 0 (random port assignment). If you see port conflicts, there may be a zombie process:

```bash
# Find jellyclaw processes
ps aux | grep jellyclaw

# Kill orphaned processes
pkill -9 jellyclaw
```

### Missing entitlements after signing

Verify entitlements are properly embedded:

```bash
codesign -d --entitlements - /Applications/Jellyclaw.app
```

Should show:
```xml
<key>com.apple.security.cs.allow-jit</key>
<true/>
<key>com.apple.security.cs.allow-unsigned-executable-memory</key>
<true/>
<key>com.apple.security.cs.disable-library-validation</key>
<true/>
```

## CI/CD

The desktop build is automated via GitHub Actions (`.github/workflows/desktop-build.yml`).

### Required Secrets

| Secret | Description |
|--------|-------------|
| `APPLE_DEVELOPER_CERT_P12_BASE64` | Base64-encoded Developer ID Application certificate |
| `APPLE_DEVELOPER_CERT_PASSWORD` | Password for the P12 certificate |
| `APPLE_ID` | Apple ID email for notarytool |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_APP_PASSWORD` | App-specific password for notarytool |

### Workflow Triggers

- **Push to `v*.*.*` tags**: Full signed and notarized build
- **Manual dispatch**: Can optionally skip notarization for testing

### Artifacts

The workflow produces:
- `jellyclaw-desktop-dmg`: The signed and notarized DMG
- `engine-binary-metadata`: JSON metadata for the engine binaries
- `engine-binaries`: Individual engine binaries (arm64, x86_64, universal)

## Binary Size Budget

Per `integration/JELLY-CLAW-APP-INTEGRATION.md:227-228`, the engine binary must be ≤100MB.

Current sizes:
- arm64: ~50-60MB
- x86_64: ~50-60MB
- universal: ~100MB (combined)

If the binary exceeds the budget, consider:
1. Adding more entries to `.bunignore`
2. Removing unused providers
3. Stripping debug symbols (already done in build script)
