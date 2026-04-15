# Phase 17 — Integration into jelly-claw Video-Calling App — Prompt 04: Notarize, TestFlight decision, GitHub Actions release pipeline

**When to run:** Prompts 01–03 committed. App builds cleanly, engine spawns reliably, voice trigger fires, banner + post-call summary render. This is the final Phase 17 prompt. It marks Phase 17 ✅.
**Estimated duration:** 6–8 hours (most of that is Apple's notarization queue, which runs 10–30 min per submission)
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `17`. Also read before acting:

1. `/Users/gtrush/Downloads/jelly-claw/TESTING.md` — current state: app is NOT notarized ("first launch will be blocked by Gatekeeper"). This prompt fixes that permanently.
2. `/Users/gtrush/Downloads/jellyclaw-engine/integration/BRIDGE-DESIGN.md` §3.3 — the hardened-runtime + entitlements story. You'll reuse the same signing order documented there.
3. `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-15/05-macos-dmg-build-and-sign.md` — the notarize pipeline for the desktop app. Mostly translatable; jelly-claw is an Xcode/Swift project (not Tauri), so the orchestrator script is different.
4. Apple docs (WebFetch):
   - https://developer.apple.com/documentation/security/notarizing_macos_software_before_distribution
   - https://developer.apple.com/documentation/xcode/customizing-the-notarization-workflow
   - https://developer.apple.com/documentation/security/hardened_runtime
   - https://developer.apple.com/documentation/testflight
   - https://developer.apple.com/documentation/xcode/embedding-nonstandard-executables-in-a-macos-app
5. Sparkle documentation (auto-update): https://sparkle-project.org/documentation/

## Research task — prerequisites George must confirm

STOP if any of the below is missing and report back:

- [ ] Apple Developer Program active (confirmed via https://developer.apple.com/account/).
- [ ] **Developer ID Application** certificate in login keychain. Check: `security find-identity -v -p codesigning | grep "Developer ID Application"`.
- [ ] Apple ID signed into Xcode with the team.
- [ ] App-specific password generated at https://account.apple.com (for `notarytool store-credentials`).
- [ ] Team ID known (visible on https://developer.apple.com/account/ under Membership).

Do not guess any of these. If missing, STOP and ask George to set them up — notarization will fail otherwise.

## Implementation task

**Goal.** After this prompt:
- The jelly-claw `.app` is signed (app + embedded engine) with the correct entitlements, hardened runtime, and timestamped signatures.
- A local script `scripts/release.sh` produces a notarized, stapled `.dmg` ready for distribution.
- A GitHub Actions workflow does the same on tag push, using repo secrets.
- Auto-update via Sparkle is wired with an appcast at `https://releases.jelly-claw.com/appcast.xml`.
- The MAS (Mac App Store) path is documented as explicitly out-of-scope with reasons.
- A `RELEASE-CHECKLIST.md` and a `ROLLBACK-RUNBOOK.md` are in the repo.

### Files to create

- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/Jelly-Claw.entitlements` — overwrite with the full production set.
- `/Users/gtrush/Downloads/jelly-claw/Engine.entitlements` — already created in Prompt 02. Verify unchanged.
- `/Users/gtrush/Downloads/jelly-claw/scripts/release.sh` — local orchestrator.
- `/Users/gtrush/Downloads/jelly-claw/scripts/codesign-bundle.sh` — recursive signer invoked by release.sh.
- `/Users/gtrush/Downloads/jelly-claw/scripts/notarize.sh` — submit + wait + staple.
- `/Users/gtrush/Downloads/jelly-claw/scripts/verify-release.sh` — spctl + stapler validation.
- `/Users/gtrush/Downloads/jelly-claw/.github/workflows/release.yml` — Actions pipeline.
- `/Users/gtrush/Downloads/jelly-claw/RELEASE-CHECKLIST.md` — human runbook.
- `/Users/gtrush/Downloads/jelly-claw/ROLLBACK-RUNBOOK.md` — how to pull a broken release.
- `/Users/gtrush/Downloads/jelly-claw/appcast.template.xml` — Sparkle feed template.

### Files to modify

- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/Info.plist` — add `SUFeedURL`, `SUPublicEDKey`, `CFBundleShortVersionString` conventions.
- `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw.xcodeproj/project.pbxproj` — via Xcode GUI, ensure Hardened Runtime is on, add Sparkle via SPM (`https://github.com/sparkle-project/Sparkle`), link against both `Sparkle` and `JellyGenieKit`.

### Production entitlements — app

Overwrite `/Users/gtrush/Downloads/jelly-claw/Jelly-Claw/Jelly-Claw.entitlements`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <!-- Unsandboxed: Direct distribution only. MAS path requires App Sandbox which
       breaks Process-spawning our embedded engine. See §MAS below for details. -->
  <key>com.apple.security.app-sandbox</key><false/>

  <!-- Network -->
  <key>com.apple.security.network.client</key><true/>
  <key>com.apple.security.network.server</key><true/>  <!-- loopback to engine -->

  <!-- Media -->
  <key>com.apple.security.device.audio-input</key><true/>
  <key>com.apple.security.device.camera</key><true/>

  <!-- Speech (voice trigger) -->
  <key>com.apple.security.personal-information.speech-recognition</key><true/>

  <!-- Files (post-call summary export, engine artifact writes) -->
  <key>com.apple.security.files.user-selected.read-write</key><true/>

  <!-- Apple events (Chrome automation for browser wishes) -->
  <key>com.apple.security.automation.apple-events</key><true/>

  <!-- NOT on the parent app: allow-jit, allow-unsigned-executable-memory,
       disable-library-validation. Those live only on Engine.entitlements. -->
</dict>
</plist>
```

### Production entitlements — engine

`Engine.entitlements` (unchanged from Prompt 02): `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`. This is applied ONLY to the embedded `jellyclaw` binary via the Run Script from Prompt 02.

### Signing flow — correct order

1. `scripts/build-engine.sh` → universal Mach-O at `engine-artifacts/jellyclaw`.
2. Xcode builds the `.app`. The Run Script from Prompt 02 fires and signs the embedded binary with `Engine.entitlements` + Hardened Runtime + timestamp.
3. `scripts/codesign-bundle.sh` (invoked by `release.sh` after Xcode build) signs the parent app with `Jelly-Claw.entitlements` + Hardened Runtime + timestamp. The inner binary's signature survives this because codesign does not re-sign children unless `--deep` is passed — and we do not pass `--deep` at this stage.
4. `hdiutil` wraps the `.app` in a `.dmg`.
5. `codesign` signs the `.dmg` itself (separate signature for the container).
6. `notarytool` submits the `.dmg` to Apple.
7. `stapler staple` embeds the ticket into the `.dmg` AND the `.app` (both, because users who mount-and-copy lose the .dmg ticket).

### scripts/release.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${APPLE_SIGNING_IDENTITY:?e.g. Developer ID Application: George Trushevskiy (TEAMID)}"
: "${APPLE_TEAM_ID:?}"
: "${NOTARY_PROFILE:=JELLYCLAW_NOTARY}"

cd "$ROOT"
"$ROOT/scripts/build-engine.sh"

echo "→ xcodebuild archive"
ARCHIVE="$ROOT/build/Jelly-Claw.xcarchive"
rm -rf "$ARCHIVE"
xcodebuild -project Jelly-Claw.xcodeproj \
  -scheme Jelly-Claw -configuration Release \
  -archivePath "$ARCHIVE" \
  -destination 'generic/platform=macOS' \
  CODE_SIGN_IDENTITY="$APPLE_SIGNING_IDENTITY" \
  OTHER_CODE_SIGN_FLAGS="--timestamp" \
  archive

echo "→ export app"
EXPORT="$ROOT/build/export"
rm -rf "$EXPORT"
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT" \
  -exportOptionsPlist "$ROOT/scripts/ExportOptions.plist"

APP="$EXPORT/Jelly-Claw.app"
"$ROOT/scripts/codesign-bundle.sh" "$APP"

echo "→ build dmg"
DMG="$ROOT/build/Jelly-Claw.dmg"
rm -f "$DMG"
hdiutil create -volname "Jelly-Claw" -srcfolder "$APP" -ov -format UDZO "$DMG"
codesign --force --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$DMG"

"$ROOT/scripts/notarize.sh" "$DMG"
"$ROOT/scripts/verify-release.sh" "$APP" "$DMG"
echo "→ release artifact: $DMG"
```

### scripts/codesign-bundle.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
APP="$1"
: "${APPLE_SIGNING_IDENTITY:?}"
APP_ENT="$(cd "$(dirname "$0")/.." && pwd)/Jelly-Claw/Jelly-Claw.entitlements"
ENGINE_ENT="$(cd "$(dirname "$0")/.." && pwd)/Engine.entitlements"

# 1. Sign the embedded engine FIRST with its own entitlements.
ENGINE="$APP/Contents/Resources/jellyclaw-engine/jellyclaw"
if [[ -f "$ENGINE" ]]; then
  codesign --force --options=runtime --timestamp \
    --entitlements "$ENGINE_ENT" \
    --sign "$APPLE_SIGNING_IDENTITY" \
    "$ENGINE"
fi

# 2. Sign every bundled framework (Sparkle etc.) and helper.
find "$APP/Contents/Frameworks" -type d -name "*.framework" -print0 2>/dev/null | while IFS= read -r -d '' fw; do
  codesign --force --options=runtime --timestamp \
    --sign "$APPLE_SIGNING_IDENTITY" "$fw"
done

# 3. Sign the parent app LAST with the app entitlements.
codesign --force --options=runtime --timestamp \
  --entitlements "$APP_ENT" \
  --sign "$APPLE_SIGNING_IDENTITY" \
  "$APP"

codesign --verify --deep --strict --verbose=2 "$APP"
```

### scripts/notarize.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
DMG="$1"
: "${NOTARY_PROFILE:=JELLYCLAW_NOTARY}"

echo "→ notarytool submit ($(date -u))"
xcrun notarytool submit "$DMG" \
  --keychain-profile "$NOTARY_PROFILE" \
  --wait

echo "→ staple dmg"
xcrun stapler staple "$DMG"

# Also staple the .app inside the mounted .dmg so copy-out users keep the ticket.
MNT="$(hdiutil attach "$DMG" -nobrowse -readwrite | awk '/\/Volumes\//{print $3}' | tail -1)"
trap 'hdiutil detach "$MNT" -quiet || true' EXIT
xcrun stapler staple "$MNT/Jelly-Claw.app" || true
```

One-time setup on the developer Mac (document this in RELEASE-CHECKLIST.md):

```bash
xcrun notarytool store-credentials "JELLYCLAW_NOTARY" \
  --apple-id "george@example.com" \
  --team-id "TEAMID" \
  --password "<app-specific password>"
```

### scripts/verify-release.sh

```bash
#!/usr/bin/env bash
set -euo pipefail
APP="$1"; DMG="$2"
codesign --verify --deep --strict --verbose=2 "$APP"
spctl -a -t exec -vv "$APP"
spctl -a -t open --context context:primary-signature -vv "$DMG"
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"
echo "OK — signed, notarized, stapled, Gatekeeper-accepted."
```

### scripts/ExportOptions.plist

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>developer-id</string>
  <key>signingStyle</key><string>manual</string>
  <key>teamID</key><string>$(APPLE_TEAM_ID)</string>
  <key>uploadBitcode</key><false/>
  <key>uploadSymbols</key><true/>
</dict></plist>
```

### GitHub Actions — .github/workflows/release.yml

```yaml
name: release
on:
  push:
    tags: ["v*"]
  workflow_dispatch: {}
jobs:
  macos:
    runs-on: macos-14
    timeout-minutes: 90
    env:
      APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
      APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
      APPLE_ID: ${{ secrets.APPLE_ID }}
      APPLE_APP_PASSWORD: ${{ secrets.APPLE_APP_PASSWORD }}
      KEYCHAIN_PASSWORD: ${{ secrets.KEYCHAIN_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
        with: { path: jelly-claw }

      - uses: actions/checkout@v4
        with:
          repository: gtrush03/jellyclaw-engine
          path: jellyclaw-engine
          token: ${{ secrets.ENGINE_REPO_PAT }}

      - uses: oven-sh/setup-bun@v2
      - uses: maxim-lobanov/setup-xcode@v1
        with: { xcode-version: '16' }

      - name: Setup keychain + cert
        run: |
          security create-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
          security default-keychain -s build.keychain
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
          security set-keychain-settings -t 3600 -u build.keychain
          echo "${{ secrets.APPLE_CERTIFICATE_P12 }}" | base64 -d > cert.p12
          security import cert.p12 -k build.keychain \
            -P "${{ secrets.APPLE_CERTIFICATE_PASSWORD }}" -T /usr/bin/codesign
          security set-key-partition-list -S apple-tool:,apple: \
            -s -k "$KEYCHAIN_PASSWORD" build.keychain

      - name: Register notarytool profile
        run: |
          xcrun notarytool store-credentials "JELLYCLAW_NOTARY" \
            --apple-id "$APPLE_ID" \
            --team-id "$APPLE_TEAM_ID" \
            --password "$APPLE_APP_PASSWORD"

      - name: Build + sign + notarize
        working-directory: jelly-claw
        env:
          JELLYCLAW_ENGINE_ROOT: ${{ github.workspace }}/jellyclaw-engine
        run: ./scripts/release.sh

      - uses: softprops/action-gh-release@v2
        with:
          files: jelly-claw/build/Jelly-Claw.dmg
          draft: true
          generate_release_notes: true

      - name: Sign appcast entry + publish
        working-directory: jelly-claw
        run: |
          # Sparkle EdDSA signature for this release's .dmg
          ./scripts/sign-update.sh build/Jelly-Claw.dmg > build/appcast-signature.txt
          # Upload/patch the appcast.xml (hosted wherever — S3/R2/GitHub Pages)
```

Required repo secrets:
- `APPLE_SIGNING_IDENTITY` — full identity string `"Developer ID Application: Name (TEAMID)"`.
- `APPLE_TEAM_ID` — the 10-char team ID.
- `APPLE_ID` — the developer account email.
- `APPLE_APP_PASSWORD` — app-specific password.
- `APPLE_CERTIFICATE_P12` — base64 of the exported `.p12`.
- `APPLE_CERTIFICATE_PASSWORD` — password for the `.p12`.
- `KEYCHAIN_PASSWORD` — any string; CI-only keychain.
- `ENGINE_REPO_PAT` — PAT that can clone the (private) jellyclaw-engine repo.
- `SPARKLE_ED_PRIVATE_KEY` — for signing appcast entries.

### MAS (Mac App Store / TestFlight) — explicitly out of scope for v1

Document in `RELEASE-CHECKLIST.md`:

> Jelly-Claw v1 ships **Developer ID + notarization only**, not Mac App Store. Reasons:
>
> 1. **App Sandbox is required for MAS.** Our architecture spawns the embedded `jellyclaw` engine via `Process` (see `BRIDGE-DESIGN.md §4`). Sandbox blocks arbitrary child-process spawning.
> 2. **Workaround path (for future).** Refactor the engine into an XPC service with a `LaunchAgent` that spawns it outside the sandbox. That's ~2 weeks of additional work, and it doesn't gain us a distribution channel we need right now — direct downloads + Homebrew cover our audience.
> 3. **TestFlight for Mac requires a MAS build.** Not worth the sandbox refactor for beta distribution alone. For Phase-17 betas we use signed-but-unreleased `.dmg` files shared via direct links to a whitelist of emails.
>
> Revisit if distribution demand justifies the sandbox work. Tracked as `ROADMAP.md` item for Q1 2027.

### Distribution

- **Primary:** direct download from GitHub Releases at `github.com/gtrush03/jelly-claw/releases`. Each tag produces a stapled `.dmg`.
- **Secondary:** Homebrew cask. Author `homebrew-tap/Casks/jelly-claw.rb` in a separate repo (`gtrush03/homebrew-jelly`). `brew install --cask gtrush03/jelly/jelly-claw`. This is picked up by Phase 18 for the public launch; land the cask file here so Phase 18 just has to flip visibility.

### Auto-update (Sparkle)

- Add Sparkle via SPM in Xcode: File → Add Package Dependencies → `https://github.com/sparkle-project/Sparkle` → pin to latest 2.x.
- Generate EdDSA keypair with `generate_keys` from Sparkle's tools. Store the **public key** in `Info.plist` under `SUPublicEDKey`. Store the **private key** in CI secret `SPARKLE_ED_PRIVATE_KEY` (never in the repo).
- `Info.plist` additions:

```xml
<key>SUFeedURL</key><string>https://releases.jelly-claw.com/appcast.xml</string>
<key>SUPublicEDKey</key><string>...base64 pubkey...</string>
<key>SUEnableAutomaticChecks</key><true/>
```

- `appcast.template.xml` skeleton — CI fills in version, URL, signature, description:

```xml
<?xml version="1.0"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>Jelly-Claw</title>
    <item>
      <title>{{VERSION}}</title>
      <sparkle:releaseNotesLink>https://github.com/gtrush03/jelly-claw/releases/tag/{{TAG}}</sparkle:releaseNotesLink>
      <pubDate>{{PUBDATE}}</pubDate>
      <enclosure url="{{DMG_URL}}"
                 sparkle:edSignature="{{ED_SIG}}"
                 length="{{DMG_BYTES}}"
                 type="application/octet-stream" />
      <sparkle:minimumSystemVersion>12.0</sparkle:minimumSystemVersion>
    </item>
  </channel>
</rss>
```

### RELEASE-CHECKLIST.md (human runbook)

Markdown checklist:

- [ ] Tag the canonical engine: `cd /Users/gtrush/Downloads/jellyclaw-engine && git tag engine-vX.Y.Z && git push --tags`.
- [ ] Wait for engine CI green; capture the release binary.
- [ ] In `jelly-claw`, run `scripts/build-engine.sh` → verify `engine-artifacts/VERSION` matches engine tag.
- [ ] Bump `CFBundleShortVersionString` in `Info.plist` and `CFBundleVersion` (build number).
- [ ] `git commit -m "release: vX.Y.Z"` and `git tag vX.Y.Z && git push --tags`.
- [ ] Watch `.github/workflows/release.yml` complete.
- [ ] Draft release on GitHub; smoke-test DMG on a clean macOS VM (no dev cert trusted).
- [ ] Publish release; update appcast.xml via the CI job.
- [ ] Post release note in `CHANGELOG.md`.

### ROLLBACK-RUNBOOK.md

- **Severity assessment:** P0 (app won't launch / data loss) → pull immediately. P1 (feature regression) → patch release within 24h.
- **Pull a broken release:** `gh release edit vX.Y.Z --draft`; delete the DMG from releases; mark the appcast entry as skipped:

```xml
<item>
  <sparkle:criticalUpdate sparkle:version="X.Y.Z">false</sparkle:criticalUpdate>
  <sparkle:ignoreSkippedUpgradesBelowVersion>X.Y.Z</sparkle:ignoreSkippedUpgradesBelowVersion>
  ...
</item>
```

- Push updated appcast so existing installs don't pull the bad build.
- Notify users via in-app banner (Prompt 03's overlay already supports one-off notices) or email if catastrophic.
- Tag a patch release `vX.Y.Z+1` that reverts the breaking commit, goes through the full CI flow.

### Verification

- [ ] `scripts/release.sh` completes locally with `spctl: accepted, source=Notarized Developer ID`.
- [ ] `stapler validate` succeeds on both the `.app` and the `.dmg`.
- [ ] Install on a **fresh macOS VM** with no dev certs — Gatekeeper accepts without the "unidentified developer" dialog.
- [ ] Launch app → bridge starts → voice trigger works → quit cleanly.
- [ ] Tag a test version `v0.1.0-rc1` and push; Actions workflow turns green and produces a draft release with the DMG.
- [ ] Downgrade to vN-1 locally, then launch vN → Sparkle detects the newer appcast entry and prompts to upgrade.

### Common pitfalls

- **`notarytool` is the only supported tool** as of November 2023 — `altool` was deprecated. Error messages if you mix them are cryptic.
- **`--deep` at parent-sign time breaks the child** — we sign child first with its own entitlements, then parent WITHOUT `--deep`. If you flip this, codesign re-signs the child with the parent's entitlements (no JIT) and the binary crashes at first run.
- **Hardened Runtime must be on for both** — Xcode GUI: target → Signing & Capabilities → `+ Capability` → Hardened Runtime (should already be there post-Prompt-02).
- **Mic + speech-recognition entitlements are not inherited by the child** — the embedded engine doesn't use them; only the parent app prompts the user.
- **Notarization silently fails if timestamps are missing** — always pass `--timestamp`.
- **`spctl` ≠ Gatekeeper** — spctl on the build machine may pass because the cert is locally trusted. Always test on a different machine.
- **Team ID mismatch between cert and notarytool profile** produces "A new main bundle identifier is not registered…" — recreate the notary profile with the exact team ID shown by `security find-identity`.
- **Sparkle with sandbox** — if you ever re-enable sandbox, you need the Sparkle XPC helper (`sparkle-project/Sparkle/XPC Helpers/`). Unsandboxed, none of that is needed.
- **.dmg signature is separate from .app signature** — sign both. If only one is signed, Safari's quarantine causes a second Gatekeeper dialog.

### Why this matters

Phase 17's first three prompts produce working code on George's Mac. This prompt produces a .dmg that opens on anyone else's Mac without scary dialogs. Without notarization, the feature is a demo; with it, it's a product. This is also the prompt that lets the Phase 18 open-source release point users at an actual install command — the Homebrew cask in a separate repo will consume DMGs built by this pipeline.

### Git commit

```bash
git -C /Users/gtrush/Downloads/jelly-claw add -A
git -C /Users/gtrush/Downloads/jelly-claw commit -m "release: sign + notarize + staple pipeline, Sparkle auto-update, Actions workflow"
```

### Final Phase 17 sign-off

Run:

```bash
./scripts/release.sh
./scripts/verify-release.sh build/export/Jelly-Claw.app build/Jelly-Claw.dmg
```

If both exit 0 and a fresh-VM install launches cleanly, Phase 17 is complete. Update `COMPLETION-LOG.md`:

- Change `- [ ] Phase 17` to `- [x] ✅ Phase 17`
- Progress bar: `[█████████████████░░░] 17/20 phases complete (85%)`
- Current phase → `18`
- Session log row: today's date, session N, Phase 17, sub-prompt 04, "✅ complete — notarized DMG shipped".

---

## Session closeout

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`, substituting `<NN>` with `17`. Mark sub-prompt `17.04` complete AND Phase 17 ✅ complete. Commit the log update:

```bash
git -C /Users/gtrush/Downloads/jellyclaw-engine add COMPLETION-LOG.md STATUS.md
git -C /Users/gtrush/Downloads/jellyclaw-engine commit -m "docs: phase 17 complete — jelly-claw integration shipped"
```

Next phase: start a new Claude Code session and run `prompts/phase-18/01-<first-open-source-release-prompt>.md`.
