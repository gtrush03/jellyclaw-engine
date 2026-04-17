---
id: T4-06-tauri-desktop-sidecar
tier: 4
title: "Bun-compiled engine binary bundled as a Tauri 2 sidecar — signed, notarized DMG"
scope:
  - "scripts/build-engine.sh"
  - "scripts/build-dmg.sh"
  - "desktop/src-tauri/tauri.conf.json"
  - "desktop/src-tauri/Cargo.toml"
  - "desktop/src-tauri/src/main.rs"
  - "desktop/src-tauri/src/sidecar.rs"
  - "desktop/src-tauri/Engine.entitlements"
  - "desktop/src-tauri/build.rs"
  - "desktop/src/lib/sidecar.ts"
  - "desktop/src/lib/sidecar.test.ts"
  - "desktop/package.json"
  - ".github/workflows/desktop-build.yml"
  - "docs/desktop.md"
depends_on_fix:
  - T4-05-plugins-system
tests:
  - name: engine-compiles-single-binary
    kind: shell
    description: "scripts/build-engine.sh produces a single-file executable at dist/bin/jellyclaw-<arch> that runs --version"
    command: "scripts/build-engine.sh --target arm64 --out dist/bin && ./dist/bin/jellyclaw-arm64 --version"
    expect_exit: 0
    timeout_sec: 300
  - name: tauri-dev-boots-sidecar
    kind: shell
    description: "tauri dev starts; the Rust sidecar spawner binds the engine on a random port and the UI receives port+token on the first IPC handshake"
    command: "bun run test desktop/src/lib/sidecar -t sidecar-handshake"
    expect_exit: 0
    timeout_sec: 60
  - name: sidecar-dies-with-app
    kind: shell
    description: "killing the Tauri parent process also terminates the sidecar engine (no orphan PID)"
    command: "bun run test desktop/src/lib/sidecar -t no-orphan-on-parent-exit"
    expect_exit: 0
    timeout_sec: 45
  - name: dmg-built-signed-notarized
    kind: shell
    description: "in CI mode with signing env vars, scripts/build-dmg.sh produces a signed+notarized+stapled .dmg; spctl --assess --type exec passes"
    command: "scripts/build-dmg.sh --ci-mode=mock && spctl --assess --type exec dist/dmg/Jellyclaw.app || true"
    expect_exit: 0
    timeout_sec: 600
  - name: ci-workflow-yaml-valid
    kind: shell
    description: ".github/workflows/desktop-build.yml is valid YAML and declares the four expected secrets as inputs"
    command: "bun run test scripts -t desktop-ci-workflow-valid"
    expect_exit: 0
    timeout_sec: 20
human_gate: true
max_turns: 100
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 240
---

# T4-06 — Tauri 2 desktop sidecar with signed DMG

## Context
`PHASE-15-desktop-mvp.md` sketches the Tauri 2 desktop app; `integration/JELLY-CLAW-APP-INTEGRATION.md:76-82` locks the sidecar bundling contract (Bun `--compile` → `lipo` → Xcode Copy-Files → launched by a Rust supervisor inside the app bundle). This T4-06 delivers the engine packaging, the Tauri-side supervisor, the signing/notarization pipeline, and the DMG build target. The SwiftUI surfaces themselves (`GenieLaunchpadView`, `CallGenieOverlay`, etc.) are NOT in this prompt — they belong to the separate Jelly-Claw app work described in `integration/JELLY-CLAW-APP-INTEGRATION.md:102-153`. Our scope is the desktop shell + the signed shippable.

Reference material:
- `PHASE-15-desktop-mvp.md:44-77` — step-by-step for the Tauri app.
- `integration/JELLY-CLAW-APP-INTEGRATION.md:76-82` — bundling contract.
- `integration/JELLY-CLAW-APP-INTEGRATION.md:225-234` — risk table including Bun `--compile` + Gatekeeper.
- `package.json:13-16` — current `bin` entries; these stay valid for npm but we additionally produce a standalone compiled artifact.
- `DAEMON-DESIGN.md` + T4-01 daemon — the sidecar may launch the scheduler daemon on first run; defer this wiring to T4-07's publish work rather than force it here.

## Root cause (from audit)
Today jellyclaw ships only as a Node/TypeScript workspace. There is no single-file artifact a non-engineer can double-click, which is a blocking gap for the hero use case of "download this DMG and go." Even internally, Jelly-Claw's app bundle depends on an engine binary that doesn't exist yet — `integration/JELLY-CLAW-APP-INTEGRATION.md:189-193` calls this the Week 1 exit criterion for that phase.

## Fix — exact change needed

### 1. `scripts/build-engine.sh` — single-file binary
- Bash, `set -euo pipefail`, shellcheck clean.
- Flags: `--target <arm64|x86_64|universal>`, `--out <dir>` (default `dist/bin`), `--sign <identity>` (optional), `--entitlements <path>`.
- Compile step: `bun build ./engine/src/cli/main.ts --compile --target=bun-darwin-<arch> --outfile <out>/jellyclaw-<arch>`.
  - For `--target universal`: run `arm64` + `x86_64` separately, then `lipo -create … -output jellyclaw-universal`.
- Strip debug symbols with `strip -S`.
- If `--sign` is provided, codesign with `--options runtime --entitlements <path> --timestamp`; else skip (dev mode).
- Emit a JSON sidecar `jellyclaw-<arch>.meta.json` with `{ sha256, size_bytes, built_at, commit, bun_version }`.
- Budget target: **≤100 MB per arch** per `integration/JELLY-CLAW-APP-INTEGRATION.md:227-228`. Script fails if the artifact exceeds this; the risk table mitigation (strip OpenCode fixtures + unused providers) is enforced by a `.bunignore` committed alongside this prompt.

### 2. `desktop/src-tauri/` — Tauri 2 shell
- `tauri.conf.json`:
  - `identifier: "com.jellyclaw.desktop"`
  - `bundle.externalBin: ["binaries/jellyclaw"]` — Tauri copies the compiled binary into the `.app` at build time.
  - `bundle.macOS.entitlements: "Engine.entitlements"`
  - `bundle.macOS.hardenedRuntime: true`
  - `bundle.targets: ["dmg"]`
  - `bundle.resources: ["../../skills/**", "../../docs/plugins.md"]` — optional, for offline docs.
  - `security.csp: "default-src 'self'; script-src 'self'; connect-src http://127.0.0.1:*"`.
- `Cargo.toml` — `tauri = "2"`, `tauri-plugin-shell = "2"` (for process spawning). No JIT entitlements needed at this tier since we spawn a compiled binary, not eval'd JS.
- `build.rs` — normal Tauri boilerplate.
- `Engine.entitlements`:
  ```xml
  <!-- bun-compiled binaries include JIT; required for webkit sidecar scenarios.
       Cite: integration/JELLY-CLAW-APP-INTEGRATION.md:225 -->
  <dict>
    <key>com.apple.security.cs.allow-jit</key><true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
    <key>com.apple.security.cs.disable-library-validation</key><true/>
  </dict>
  ```

### 3. `desktop/src-tauri/src/sidecar.rs` — Rust supervisor
- Struct `SidecarSupervisor { child: Option<Child>, port: u16, token: String }`.
- `spawn(app_resource_dir: &Path) -> Result<Self>`:
  1. Generate a 32-byte random token (`rand` crate).
  2. Spawn `<resource_dir>/binaries/jellyclaw serve --port 0 --token-env JELLYCLAW_AUTH_TOKEN` with that env var set.
  3. Read stderr line-by-line until we see the pino `"listening on http://127.0.0.1:<port>"` line (same line `T0-01-fix-serve-shim.md:10-13` asserts); parse port with a small regex.
  4. Return `{ port, token }`.
- `shutdown(self)`: SIGTERM, wait 5s, SIGKILL. Remove any PID file.
- Register shutdown with the Tauri `RunEvent::ExitRequested` — the child MUST NOT survive the parent.
- `main.rs` wires a `get_sidecar_info` Tauri command that returns `{ port, token }` to the UI; the UI uses it to open SSE / HTTP.

### 4. `desktop/src/lib/sidecar.ts` — UI client
- Typed wrapper (Zod output schema) around `invoke("get_sidecar_info")`.
- Retry with exponential backoff on transient "sidecar not ready" — 5 attempts, 200ms → 3.2s.
- Exports `openEventStream(port, token)` returning an `EventSource` wrapped with auth header injection (via `@microsoft/fetch-event-source` per `PHASE-15-desktop-mvp.md:55-57`).

### 5. `scripts/build-dmg.sh` — signed DMG pipeline
- Invokes, in order:
  1. `scripts/build-engine.sh --target universal --sign "$SIGNING_IDENTITY" --entitlements desktop/src-tauri/Engine.entitlements`.
  2. Copy to `desktop/src-tauri/binaries/jellyclaw-universal-apple-darwin`.
  3. `cd desktop && bun install && bun run tauri build --target universal-apple-darwin`.
  4. Codesign the `.app` with `--options runtime --entitlements …`.
  5. Create DMG via Tauri's built-in DMG target (configured in `tauri.conf.json`).
  6. Submit to Apple notarytool: `xcrun notarytool submit <dmg> --apple-id $APPLE_ID --team-id $APPLE_TEAM_ID --password $APPLE_APP_PASSWORD --wait`.
  7. Staple: `xcrun stapler staple <dmg>`.
  8. `spctl --assess --type exec --verbose <app_in_mount>`.
- Flag `--ci-mode=mock` skips actual Apple signing (uses an ad-hoc identity and skips notarization) — required for CI smoke in forks without Apple Developer secrets. The flag is gated behind a confirmation log line so it's never used accidentally on a release build.
- All Apple credentials flow through environment variables, never persisted. Script fails loud if any required variable is missing in non-mock mode.

### 6. `.github/workflows/desktop-build.yml`
- Triggers: `push` to tags `v*.*.*`, `workflow_dispatch`.
- Runners: `macos-14` (arm64) for universal builds via `lipo`.
- Secrets consumed (declared as `required: true` env in the workflow):
  - `APPLE_DEVELOPER_CERT_P12_BASE64` (Developer ID Application cert)
  - `APPLE_DEVELOPER_CERT_PASSWORD`
  - `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` (notarytool app-specific password)
- Steps: checkout, install Bun + Rust + Tauri CLI, install cert into a keychain built from env (standard Apple keychain-in-CI pattern; use `security import`), run `scripts/build-dmg.sh`, upload artifact.
- Upload the signed DMG + the engine binary `.meta.json` as workflow artifacts.

### 7. `docs/desktop.md`
- Local dev: `cd desktop && bun install && bun run tauri dev` (auto-compiles engine via `scripts/build-engine.sh --target $(uname -m)` if `desktop/src-tauri/binaries/` is empty).
- Shipping a release: tag `vX.Y.Z`, push, CI produces artifact, manual download + notarization verification.
- Gatekeeper verification recipe: `spctl --assess --type exec /Applications/Jellyclaw.app`.
- Troubleshooting: the three canonical Bun-compile + Gatekeeper failure modes (missing entitlements, library validation, signing identity mismatch) with fix instructions.

### 8. Tests
- `engine-compiles-single-binary` — smoke; must work on both arm64 macOS and linux (CI matrix).
- `sidecar-handshake` — mock the Rust command return (inject a fake `get_sidecar_info` responder); assert the TS client parses, retries on transient failures, and settles with `{ port, token }`.
- `no-orphan-on-parent-exit` — launch Tauri dev binary in a subprocess with the real sidecar, SIGTERM the parent, `ps` for the engine PID after 3s — assert not present.
- `dmg-built-signed-notarized` — `--ci-mode=mock` path; asserts the `.app` exists and spctl runs (even if it returns non-zero in mock mode, the invocation must succeed without shell error).
- `desktop-ci-workflow-valid` — parse the YAML with a Zod+yaml-parser round-trip; assert all four secrets are referenced.

## Acceptance criteria
- Bun produces a single-file binary ≤100MB that passes `--version` (maps to `engine-compiles-single-binary`).
- Tauri supervisor spawns the engine and handshakes port+token (maps to `tauri-dev-boots-sidecar`).
- Sidecar dies with the parent (maps to `sidecar-dies-with-app`).
- DMG pipeline runs end-to-end in mock mode; with real secrets it produces a signed+notarized+stapled `.dmg` (maps to `dmg-built-signed-notarized`).
- CI workflow YAML is valid and declares the Apple secrets (maps to `ci-workflow-yaml-valid`).
- `bun run typecheck` + `bun run lint` + Rust `cargo check` inside `desktop/src-tauri/` all clean.

## Out of scope
- Do NOT implement the SwiftUI surfaces from `integration/JELLY-CLAW-APP-INTEGRATION.md` (Launchpad, CallGenieOverlay, PostCallSummaryView). Those belong to the Jelly-Claw app repo, not this engine.
- Do NOT implement auto-update (Tauri updater) in this tier; shipped as a separate prompt.
- Do NOT add XState + Zustand wiring from PHASE-15 — only the sidecar client is in scope here; full UI is a separate work stream.
- Do NOT wire the scheduler daemon into the desktop app; the daemon is an opt-in install (T4-01 + T4-02's unit files).
- Do NOT publish anything; publication is T4-07.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
scripts/build-engine.sh --target "$(uname -m | sed 's/aarch64/arm64/;s/x86_64/x86_64/')" --out dist/bin
./dist/bin/jellyclaw-"$(uname -m | sed 's/aarch64/arm64/')" --version
cd desktop && bun install && cargo check --manifest-path src-tauri/Cargo.toml
bun run test src/lib/sidecar
cd .. && scripts/build-dmg.sh --ci-mode=mock
```
