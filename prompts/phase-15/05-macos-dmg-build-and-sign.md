# Phase 15 — Desktop App MVP — Prompt 05: macOS .dmg build, sign, notarize, distribute

**When to run:** After prompt 04 is marked ✅ in Phase 15 Notes. UI shell streams a real wish end-to-end against the live engine. This is the FINAL prompt of Phase 15 — it marks the phase complete.
**Estimated duration:** 6–10 hours (first-time notarization is slow)
**New session?** Yes — start a fresh Claude Code session
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `15` and `<name>` with `desktop-mvp`.

---

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-15-desktop-mvp.md` "Step 7 — Signing + notarization".
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` for the Hardened Runtime entitlement rationale (Bun JIT).
3. WebFetch:
   - `https://v2.tauri.app/distribute/sign/macos/` — `signingIdentity`, `entitlements`, `providerShortName`
   - `https://v2.tauri.app/distribute/app-store/` — notarization workflow
   - `https://v2.tauri.app/learn/sidecar-nodejs/` — bundling the `jellyclaw` binary as an external bin
   - `https://developer.apple.com/documentation/security/hardened_runtime` — entitlement semantics
   - `https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution` — `notarytool` flow
4. Read Bun docs: `https://bun.sh/docs/bundler/executables` — `bun build --compile` for standalone binaries.
5. Check prerequisites: active Apple Developer Program membership, a "Developer ID Application" certificate in your login keychain, an app-specific password for `notarytool`.

## Implementation task

Produce a signed + notarized + stapled universal (arm64 + x86_64) macOS `.dmg` that bundles the `jellyclaw` engine as a sidecar. Add a first-run onboarding screen that stores the Anthropic API key in the macOS Keychain via `tauri-plugin-stronghold`. Ship from GitHub Releases. Homebrew cask is deferred to Phase 18.

### Files to create/modify

- `desktop/src-tauri/tauri.conf.json` — add `bundle.externalBin`, `bundle.macOS.*`, entitlements
- `desktop/src-tauri/entitlements.plist` — NEW — Hardened Runtime entitlements
- `desktop/src-tauri/Info.plist` — bundle version, category, NSAppTransportSecurity for `127.0.0.1`
- `desktop/scripts/build-engine-sidecars.sh` — compile engine for arm64 + x86_64, emit target-triple-named binaries
- `desktop/scripts/release.sh` — orchestrates build → sign-sidecar → tauri build → notarize → staple → verify
- `desktop/scripts/sign-sidecar.sh` — signs the bundled engine binary with the same identity before Tauri embeds it
- `desktop/src/components/onboarding/Onboarding.tsx` — first-run key capture
- `desktop/src/lib/keychain.ts` — stronghold wrapper
- `desktop/src-tauri/Cargo.toml` — add `tauri-plugin-stronghold`
- `desktop/src-tauri/src/lib.rs` — register the stronghold plugin
- `.github/workflows/desktop-release.yml` — CI release workflow (macOS-latest runner)
- `docs/desktop.md` — install / update / uninstall instructions

### Prerequisites check

```bash
# Certificate present?
security find-identity -v -p codesigning | grep "Developer ID Application"
# Expect: 1 valid identity, e.g. "Developer ID Application: George Trushevskiy (ABCD123456)"

# Bun installed and recent
bun --version     # expect >=1.1

# Tauri CLI v2 (from prompt 01)
cargo tauri --version

# notarytool keychain profile
xcrun notarytool history --keychain-profile AC_PASSWORD || \
  echo "Store creds first: see step 3 below"
```

Store notarytool creds once per machine:

```bash
xcrun notarytool store-credentials "AC_PASSWORD" \
  --apple-id "your-apple-id@example.com" \
  --team-id "ABCD123456" \
  --password "abcd-efgh-ijkl-mnop"     # app-specific, from appleid.apple.com
```

### Step-by-step implementation

1. **Compile engine binaries** — `desktop/scripts/build-engine-sidecars.sh`:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   cd "$(dirname "$0")/../.."
   mkdir -p desktop/src-tauri/binaries

   for TRIPLE in aarch64-apple-darwin x86_64-apple-darwin; do
     BUN_TARGET="bun-darwin-${TRIPLE%%-*}"
     [[ $TRIPLE == x86_64-apple-darwin ]] && BUN_TARGET="bun-darwin-x64"
     bun build --compile --target="$BUN_TARGET" ./engine/src/cli.ts \
       --outfile "desktop/src-tauri/binaries/jellyclaw-${TRIPLE}"
     chmod +x "desktop/src-tauri/binaries/jellyclaw-${TRIPLE}"
   done
   ```

   Tauri's sidecar convention requires the filename to end in the target triple so its bundler picks the right one per-arch.

2. **Configure `tauri.conf.json`** to embed the sidecar and sign macOS:

   ```json
   {
     "bundle": {
       "active": true,
       "targets": ["dmg", "app"],
       "externalBin": ["binaries/jellyclaw"],
       "icon": ["icons/icon.icns"],
       "macOS": {
         "minimumSystemVersion": "12.0",
         "signingIdentity": "Developer ID Application: George Trushevskiy (ABCD123456)",
         "providerShortName": "ABCD123456",
         "entitlements": "entitlements.plist",
         "hardenedRuntime": true,
         "dmg": {
           "background": "icons/dmg-bg.png",
           "windowSize": { "width": 660, "height": 400 },
           "appPosition":     { "x": 180, "y": 170 },
           "applicationFolderPosition": { "x": 480, "y": 170 }
         }
       }
     }
   }
   ```

3. **Write `desktop/src-tauri/entitlements.plist`** (Hardened Runtime — required for Bun's JIT):

   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
     <key>com.apple.security.cs.allow-jit</key>                     <true/>
     <key>com.apple.security.cs.allow-unsigned-executable-memory</key> <true/>
     <key>com.apple.security.cs.disable-library-validation</key>    <true/>
     <key>com.apple.security.network.client</key>                   <true/>
     <key>com.apple.security.network.server</key>                   <true/>
     <key>com.apple.security.files.user-selected.read-write</key>   <true/>
   </dict>
   </plist>
   ```

4. **Sign the embedded binary BEFORE Tauri wraps it.** `desktop/scripts/sign-sidecar.sh`:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   IDENTITY="Developer ID Application: George Trushevskiy (ABCD123456)"
   ENTITLEMENTS="desktop/src-tauri/entitlements.plist"
   for BIN in desktop/src-tauri/binaries/jellyclaw-*-apple-darwin; do
     codesign --force --options runtime --timestamp \
       --entitlements "$ENTITLEMENTS" \
       --sign "$IDENTITY" "$BIN"
     codesign --verify --verbose=2 "$BIN"
   done
   ```

   This matters because Tauri's outer `codesign` pass doesn't sign files you placed inside `binaries/` — Apple requires every Mach-O inside the bundle to be signed individually.

5. **Build the universal app.**

   ```bash
   cd desktop
   pnpm tauri build --target universal-apple-darwin
   # Output: src-tauri/target/universal-apple-darwin/release/bundle/dmg/Jellyclaw_0.1.0_universal.dmg
   ```

   Tauri's universal target internally builds both arch slices and `lipo`s them.

6. **Notarize + staple.**

   ```bash
   DMG="desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/Jellyclaw_0.1.0_universal.dmg"
   xcrun notarytool submit "$DMG" --keychain-profile AC_PASSWORD --wait
   xcrun stapler staple "$DMG"
   spctl -a -t open --context context:primary-signature -v "$DMG"
   # Expect: accepted / source=Notarized Developer ID
   ```

7. **Orchestrate everything** in `desktop/scripts/release.sh`:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   ROOT="$(cd "$(dirname "$0")/.." && pwd)"
   cd "$ROOT/.."

   echo "1/6 compiling engine sidecars..."
   ./desktop/scripts/build-engine-sidecars.sh

   echo "2/6 signing sidecars..."
   ./desktop/scripts/sign-sidecar.sh

   echo "3/6 building universal app..."
   (cd desktop && pnpm tauri build --target universal-apple-darwin)

   DMG=$(ls desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg | head -1)
   echo "4/6 notarizing $DMG (may take 5-20 min)..."
   xcrun notarytool submit "$DMG" --keychain-profile AC_PASSWORD --wait

   echo "5/6 stapling ticket..."
   xcrun stapler staple "$DMG"

   echo "6/6 verifying..."
   spctl -a -t open --context context:primary-signature -v "$DMG"
   shasum -a 256 "$DMG" | tee "${DMG}.sha256"

   echo "DONE  →  $DMG"
   ```

8. **First-run onboarding** — `desktop/src/components/onboarding/Onboarding.tsx` prompts for Anthropic API key. On submit, `lib/keychain.ts` stores via `tauri-plugin-stronghold`. Rust side `lib.rs`:

   ```rust
   .plugin(tauri_plugin_stronghold::Builder::new(|password| {
       argon2::Argon2::default().hash_password_into(
           password.as_bytes(),
           b"jellyclaw-desktop-salt",
           &mut [0u8; 32],
       ).unwrap();
       vec![0u8; 32]
   }).build())
   ```

9. **CI release workflow** — `.github/workflows/desktop-release.yml`:

   ```yaml
   name: desktop-release
   on: { push: { tags: ["desktop-v*"] }, workflow_dispatch: {} }
   jobs:
     build:
       runs-on: macos-latest
       steps:
         - uses: actions/checkout@v4
         - uses: oven-sh/setup-bun@v2
         - uses: pnpm/action-setup@v4
         - uses: actions/setup-node@v4
           with: { node-version: 20, cache: pnpm }
         - uses: dtolnay/rust-toolchain@stable
           with: { targets: aarch64-apple-darwin,x86_64-apple-darwin }
         - name: Import cert
           uses: apple-actions/import-codesign-certs@v3
           with:
             p12-file-base64:  ${{ secrets.MAC_CERT_P12 }}
             p12-password:     ${{ secrets.MAC_CERT_PASSWORD }}
         - name: Store notarytool creds
           run: |
             xcrun notarytool store-credentials AC_PASSWORD \
               --apple-id     "${{ secrets.AC_APPLE_ID }}" \
               --team-id      "${{ secrets.AC_TEAM_ID }}" \
               --password     "${{ secrets.AC_APP_PASSWORD }}"
         - run: pnpm install --frozen-lockfile
         - run: bun run build
         - run: ./desktop/scripts/release.sh
         - uses: softprops/action-gh-release@v2
           with:
             files: |
               desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg
               desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.sha256
   ```

### Key code: Onboarding.tsx

```tsx
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { saveSecret } from "@/lib/keychain";
import { restartEngine } from "@/lib/tauri";
import { toast } from "sonner";

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("");
  const save = useMutation({
    mutationFn: async () => { await saveSecret("ANTHROPIC_API_KEY", key); await restartEngine(); },
    onSuccess: () => { toast.success("key stored in keychain"); onDone(); },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)]">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
            className="glass p-8 w-[480px]">
        <h1 className="text-2xl font-light text-[var(--color-gold)]">Welcome to Jellyclaw</h1>
        <p className="mt-2 text-sm text-[var(--color-text-muted)]">
          Paste your Anthropic API key. It will be stored in your macOS Keychain, never on disk.
        </p>
        <input value={key} onChange={(e) => setKey(e.target.value)}
          type="password" placeholder="sk-ant-…"
          className="glass w-full mt-6 px-4 py-3 font-mono text-sm focus:outline-none focus:border-[var(--color-gold)]" />
        <button type="submit" disabled={!key || save.isPending}
          className="mt-4 w-full py-3 rounded-[var(--radius-card)] bg-[var(--color-gold)] text-[var(--color-bg)] font-medium disabled:opacity-50">
          {save.isPending ? "storing…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
```

### Tests to add

- `desktop/scripts/release.sh` — dry-run mode (`DRY_RUN=1` prints commands without executing)
- Manual smoke test: fresh VM / second Mac — install from DMG, launch, see no Gatekeeper warning, run a wish
- `codesign --verify --deep --strict --verbose=2 /Applications/Jellyclaw.app` — no errors

### Verification

```bash
./desktop/scripts/release.sh
DMG=$(ls desktop/src-tauri/target/universal-apple-darwin/release/bundle/dmg/*.dmg | head -1)

# 1. Signature valid
codesign --verify --deep --strict --verbose=2 "$DMG"          # expect: valid on disk / satisfies Designated Requirement

# 2. Notarized + stapled
spctl -a -t open --context context:primary-signature -v "$DMG" # expect: accepted / source=Notarized Developer ID
xcrun stapler validate "$DMG"                                  # expect: The validate action worked!

# 3. Universal binary
file "$DMG"
hdiutil attach "$DMG" -mountpoint /tmp/jc-dmg
file /tmp/jc-dmg/Jellyclaw.app/Contents/MacOS/jellyclaw-desktop
# expect: Mach-O universal binary with 2 architectures: [arm64, x86_64]
file /tmp/jc-dmg/Jellyclaw.app/Contents/Resources/binaries/jellyclaw
hdiutil detach /tmp/jc-dmg

# 4. Fresh-install E2E
cp "$DMG" ~/Desktop/
# In Finder: open DMG, drag to /Applications, double-click Jellyclaw → onboarding shows,
# paste key, engine spawns, "hello" wish streams, cost meter increments.
```

### Common pitfalls

- **"Code signature did not match specified requirements"** — Gatekeeper rejects on launch. Almost always a nested binary that wasn't signed individually. Run `codesign --deep --verify --verbose=2 Jellyclaw.app` to find it. Fix: sign the sidecar BEFORE `tauri build` (step 4).
- **Notarization silently fails with "invalid entitlement".** `com.apple.security.cs.allow-jit` must be accompanied by `allow-unsigned-executable-memory` OR `disable-library-validation` for Bun. Include all three.
- **`codesign` complains about timestamp** — always pass `--timestamp` (Apple requires secure timestamps for notarization).
- **Universal builds fail with "no matching sidecar"** — the external bin names MUST include the full target triple (e.g. `jellyclaw-aarch64-apple-darwin`), not just arch. Tauri's sidecar loader matches on triple suffix.
- **GitHub Actions runner keychain is ephemeral** — the `import-codesign-certs` action must run before every build job; don't assume cross-job keychain state.
- **Notarization queue is slow** — first submission can take 20+ min. Use `--wait` but set a generous timeout in CI.
- **Stronghold password on macOS** — don't ship the default password literal from the Tauri docs; derive it from a device-unique value. (Full treatment deferred to Phase 16 — MVP uses a static derived password.)
- **App-specific password vs Apple ID password** — notarytool needs the *app-specific* one from appleid.apple.com, never the real account password.
- **DMG background image** — must be 72 DPI PNG, exact `windowSize` dimensions in config; otherwise the DMG opens with misaligned icons.

### Why this matters

An unsigned .dmg triggers Gatekeeper's "cannot be opened because the developer cannot be verified" dialog — 90% of users will abandon there. A notarized, stapled, hardened-runtime build is the difference between "cool project on GitHub" and "app I can send to my mom." Getting the entitlements right the first time avoids the especially painful debug loop where notarization passes but Bun's JIT silently SIGKILLs on launch with no UI.

### Phase 15 completion criteria

Before marking this phase ✅:

- [ ] `./desktop/scripts/release.sh` produces a signed + notarized + stapled universal `.dmg`
- [ ] `spctl` accepts it as "Notarized Developer ID"
- [ ] Fresh install on a separate Mac opens without Gatekeeper warnings
- [ ] Onboarding captures the Anthropic key → stored in Keychain (verify with `security find-generic-password -s jellyclaw-desktop`)
- [ ] End-to-end wish runs (dispatch → stream → tool call → complete)
- [ ] CI workflow produces the same artifact on `macos-latest` runners
- [ ] `docs/desktop.md` documents the install/uninstall flow

---

## Session closeout

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md` with `<NN>` = `15`, sub-prompt = `05-macos-dmg-build-and-sign`.

**This is the final prompt of Phase 15 — mark the phase ✅ in COMPLETION-LOG.md, bump the progress bar, and suggest starting Phase 16 in a new session.**
