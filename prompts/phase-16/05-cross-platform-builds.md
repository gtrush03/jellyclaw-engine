# Phase 16 — Desktop App Polish — Prompt 05: Cross-platform builds (Linux + Windows + CI)

**When to run:** After 16.04 is marked done. **Final prompt of Phase 16.**
**Estimated duration:** 8–12 hours (much of it waiting on CI + cert issuance)
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with 16. Verify 16.01–16.04 all ticked.

---

## Research task

Read:

1. `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-16-desktop-polish.md` — step 6 (Linux/Windows builds) + acceptance criteria.
2. `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-15/05-macos-dmg-build-and-sign.md` — the macOS pipeline we're extending into a matrix.
3. `/Users/gtrush/Downloads/jellyclaw-engine/desktop/src-tauri/tauri.conf.json` — target list, bundle identifier.
4. `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — what we claim about reproducibility + signature verification.

Fetch:

- `https://v2.tauri.app/distribute/sign/windows/` — Windows signing steps, `signtool` flags, Azure Trusted Signing vs file-based certs.
- `https://v2.tauri.app/distribute/sign/linux/` — GPG signing for AppImage + .deb + .rpm (not required by package managers but expected by security-conscious users).
- `https://v2.tauri.app/distribute/flathub/` — Flathub submission flow (if present; otherwise https://docs.flathub.org/docs/for-app-authors/submission/).
- `https://www.ssl.com/how-to/how-to-sign-a-windows-executable-file/` — OV cert application + signtool usage.
- `https://docs.github.com/en/actions/use-cases-and-examples/creating-larger-workflows/using-workflow-templates` + `https://github.com/tauri-apps/tauri-action` — canonical Tauri release workflow.
- `https://learn.microsoft.com/en-us/windows-hardware/drivers/dashboard/attestation-signing-a-kernel-driver-for-public-release` — background on SmartScreen reputation.
- `https://wiki.archlinux.org/title/PKGBUILD` — AUR package format.

## Implementation task

Deliver four things:

1. **Linux builds** — `.AppImage`, `.deb`, `.rpm`, plus a Flathub manifest and an AUR `PKGBUILD`.
2. **Windows builds** — `.msi` via WiX, code-signed with an OV cert.
3. **GitHub Actions matrix workflow** that builds + signs + uploads all targets from a single `v*.*.*` tag.
4. **Release runbook + rollback runbook** for the human parts (cert rotation, broken release recovery, download-page update).

### Files to create/modify

```
.github/workflows/release.yml
.github/workflows/release-matrix-test.yml          # dry-run on PRs
desktop/src-tauri/tauri.conf.json                  # Linux + Windows bundle blocks
desktop/src-tauri/wix/main.wxs                     # WiX template (minimal override)
desktop/src-tauri/windows-signing.md               # cert process notes
packaging/flatpak/dev.jellyclaw.desktop.yml        # Flathub manifest
packaging/flatpak/dev.jellyclaw.desktop.desktop    # .desktop file
packaging/flatpak/dev.jellyclaw.desktop.metainfo.xml
packaging/aur/PKGBUILD
packaging/aur/.SRCINFO
scripts/gen-manifest.mjs                           # R2 manifest builder (called from release workflow)
scripts/upload-r2.mjs                              # aws-s3-compatible R2 upload
docs/releases/RUNBOOK.md
docs/releases/ROLLBACK.md
docs/releases/TEST-MATRIX.md
cloudflare/workers/downloads/                      # public download page
```

### Prerequisites (before running this prompt)

- macOS machine from prompt 15.05 (Apple Developer ID cert in keychain, App Store Connect API key).
- Tauri updater key from prompt 16.04 (ed25519).
- **Windows OV code-signing cert ordered** — SSL.com OV is ~$219/yr, GlobalSign ~$299/yr, SSL.com EV ~$349/yr. OV is fine for MSI+signtool; EV accelerates SmartScreen reputation but requires a hardware token (YubiKey FIPS). For MVP: OV. Process: identity verification (D-U-N-S + phone callback) takes 1–5 business days. **Start this now** — it blocks Windows release but not Linux.
- Cloudflare account with R2 enabled + a Wrangler API token with R2 write scope.
- Flathub account + a PR-able fork of `github.com/flathub/flathub` (the submission lives at `github.com/flathub/dev.jellyclaw.desktop` once approved).

### Step-by-step

**1. Tauri config: Linux + Windows bundle blocks.**

```json
// tauri.conf.json (excerpt)
{
  "bundle": {
    "active": true,
    "targets": ["app", "dmg", "updater", "nsis", "msi", "appimage", "deb", "rpm"],
    "identifier": "dev.jellyclaw.desktop",
    "category": "DeveloperTool",
    "publisher": "Jellyclaw",
    "homepage": "https://jellyclaw.dev",
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"],
    "linux": {
      "deb": {
        "depends": ["libwebkit2gtk-4.1-0", "libgtk-3-0", "libayatana-appindicator3-1", "librsvg2-2"]
      },
      "rpm": {
        "depends": ["webkit2gtk4.1", "gtk3", "libappindicator-gtk3", "librsvg2"]
      },
      "appimage": { "bundleMediaFramework": true }
    },
    "windows": {
      "webviewInstallMode": { "type": "downloadBootstrapper" },
      "wix": {
        "language": "en-US",
        "template": "wix/main.wxs",
        "upgradeCode": "B8F2E7A0-4A3D-4B8E-9C1F-1E0D5B2A3C4F"
      },
      "signCommand": null,
      "certificateThumbprint": null,
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

`signCommand` + `certificateThumbprint` are set at CI time via env substitution; leaving them null here keeps local dev builds fast.

**2. Linux: AppImage + .deb + .rpm.**

- **AppImage** is the path-agnostic universal binary. Tauri bundles `libwebkit2gtk` inside when `bundleMediaFramework: true`. Target glibc 2.31+ (Ubuntu 20.04 baseline). Build on Ubuntu 22.04 runner for broad compatibility; 24.04's newer glibc breaks older distros.
- **.deb** depends on `libwebkit2gtk-4.1-0` (Ubuntu 22.04+, Debian 12+). For older systems, users install the AppImage.
- **.rpm** depends on `webkit2gtk4.1`. Fedora 38+, RHEL 9+, openSUSE Tumbleweed.
- **Install libs on the CI runner:**

  ```bash
  sudo apt-get update
  sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
                          libssl-dev build-essential curl wget file
  ```

**3. Flathub manifest** (`packaging/flatpak/dev.jellyclaw.desktop.yml`):

```yaml
app-id: dev.jellyclaw.desktop
runtime: org.gnome.Platform
runtime-version: '46'
sdk: org.gnome.Sdk
sdk-extensions:
  - org.freedesktop.Sdk.Extension.rust-stable
  - org.freedesktop.Sdk.Extension.node20
command: jellyclaw
finish-args:
  - --share=ipc
  - --share=network
  - --socket=wayland
  - --socket=fallback-x11
  - --device=dri
  - --filesystem=home
  - --talk-name=org.freedesktop.Notifications
build-options:
  append-path: /usr/lib/sdk/rust-stable/bin:/usr/lib/sdk/node20/bin
modules:
  - name: jellyclaw
    buildsystem: simple
    build-commands:
      - cd desktop && pnpm install --frozen-lockfile && pnpm tauri build --bundles deb
      - install -Dm755 src-tauri/target/release/jellyclaw /app/bin/jellyclaw
      - install -Dm644 dev.jellyclaw.desktop.desktop /app/share/applications/dev.jellyclaw.desktop.desktop
      - install -Dm644 dev.jellyclaw.desktop.metainfo.xml /app/share/metainfo/dev.jellyclaw.desktop.metainfo.xml
      - install -Dm644 icons/128x128.png /app/share/icons/hicolor/128x128/apps/dev.jellyclaw.desktop.png
    sources:
      - type: archive
        url: https://github.com/gtrush03/jellyclaw-engine/archive/refs/tags/v1.0.0.tar.gz
        sha256: <fill at release>
```

Flathub submission: fork `flathub/flathub`, add the manifest, open a PR. Review takes ~2 weeks. Once merged, publish updates by PR-ing `flathub/dev.jellyclaw.desktop` with bumped version + sha256. The auto-update UI is greyed out inside Flathub because Flatpak manages updates itself — detect via `FLATPAK_ID` env var and hide the banner.

**4. AUR** (`packaging/aur/PKGBUILD`):

```bash
# Maintainer: George Trushevskiy <george@...>
pkgname=jellyclaw-bin
pkgver=1.0.0
pkgrel=1
pkgdesc="Embeddable open replacement for Claude Code"
arch=('x86_64' 'aarch64')
url="https://jellyclaw.dev"
license=('Apache-2.0')
depends=('webkit2gtk-4.1' 'gtk3' 'libayatana-appindicator' 'librsvg')
source_x86_64=("https://releases.jellyclaw.dev/bin/linux/x86_64/jellyclaw_${pkgver}_amd64.deb")
source_aarch64=("https://releases.jellyclaw.dev/bin/linux/aarch64/jellyclaw_${pkgver}_arm64.deb")
sha256sums_x86_64=('SKIP')   # regenerated by release script
sha256sums_aarch64=('SKIP')
package() {
  bsdtar -xf "data.tar.gz" -C "$pkgdir"
}
```

Community-maintained: no code-signing required, no cost, but George personally pushes updates via `git push aur master`. `.SRCINFO` is generated by `makepkg --printsrcinfo > .SRCINFO`.

**5. Windows: MSI + signing.**

WiX template (`wix/main.wxs`): start from Tauri's default and override only what's needed — upgrade code, ARP icon, Start Menu group name. Do NOT modify the component GUIDs (Tauri regenerates them per build).

Signing with an OV cert (once issued as a `.pfx`):

```powershell
# On the Windows runner (Azure-hosted, `windows-latest`)
$env:WIN_PFX_B64 | Out-File -FilePath cert.pfx.b64
certutil -decode cert.pfx.b64 cert.pfx
Import-PfxCertificate -FilePath cert.pfx -CertStoreLocation Cert:\CurrentUser\My -Password (ConvertTo-SecureString -String $env:WIN_PFX_PASSWORD -AsPlainText -Force)

# Signtool is part of the Windows 10 SDK; GitHub runners have it at:
& "C:\Program Files (x86)\Windows Kits\10\bin\10.0.22621.0\x64\signtool.exe" sign `
   /fd SHA256 `
   /td SHA256 `
   /tr http://timestamp.digicert.com `
   /a `
   "src-tauri\target\release\bundle\msi\Jellyclaw_1.0.0_x64_en-US.msi"
```

Tauri's bundler can invoke signtool automatically when `certificateThumbprint` + `digestAlgorithm` + `timestampUrl` are set in `tauri.conf.json`. Pass the thumbprint from the imported cert via env substitution (see workflow below).

**SmartScreen reputation.** New certs always trigger "Windows protected your PC" on first launches. Reputation builds over weeks of download volume. EV certs bypass this from day one at ~$130/yr higher cost + a hardware token. For MVP use OV + document the "More info → Run anyway" path on the download page.

**6. GitHub Actions workflow** (`.github/workflows/release.yml`):

```yaml
name: release
on:
  push:
    tags: ['v*.*.*']

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-14
            args: '--target aarch64-apple-darwin'
            target: darwin-aarch64
          - platform: macos-13                   # x86_64 (Intel runners still ship as macos-13)
            args: '--target x86_64-apple-darwin'
            target: darwin-x86_64
          - platform: ubuntu-22.04
            args: '--target x86_64-unknown-linux-gnu --bundles appimage,deb,rpm'
            target: linux-x86_64
          - platform: windows-latest
            args: '--target x86_64-pc-windows-msvc'
            target: windows-x86_64
    runs-on: ${{ matrix.platform }}
    timeout-minutes: 90

    env:
      TAURI_SIGNING_PRIVATE_KEY:        ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}

    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm, cache-dependency-path: desktop/pnpm-lock.yaml }
      - uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.target == 'darwin-aarch64' && 'aarch64-apple-darwin' ||
                       matrix.target == 'darwin-x86_64'  && 'x86_64-apple-darwin'  ||
                       matrix.target == 'windows-x86_64' && 'x86_64-pc-windows-msvc' ||
                                                            'x86_64-unknown-linux-gnu' }}

      - name: Cache cargo
        uses: swatinem/rust-cache@v2
        with: { workspaces: "desktop/src-tauri -> target" }

      - name: Install Linux deps
        if: startsWith(matrix.platform, 'ubuntu')
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
               libayatana-appindicator3-dev librsvg2-dev libssl-dev \
               file fakeroot rpm

      - name: Import Apple cert
        if: startsWith(matrix.platform, 'macos')
        env:
          APPLE_CERT_P12:       ${{ secrets.APPLE_CERT_P12 }}
          APPLE_CERT_PASSWORD:  ${{ secrets.APPLE_CERT_PASSWORD }}
          KEYCHAIN_PASSWORD:    ${{ secrets.KEYCHAIN_PASSWORD }}
        run: |
          security create-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
          security default-keychain -s build.keychain
          security unlock-keychain -p "$KEYCHAIN_PASSWORD" build.keychain
          echo "$APPLE_CERT_P12" | base64 -d > cert.p12
          security import cert.p12 -k build.keychain -P "$APPLE_CERT_PASSWORD" -T /usr/bin/codesign
          security set-key-partition-list -S apple-tool:,apple: -s -k "$KEYCHAIN_PASSWORD" build.keychain

      - name: Import Windows cert
        if: startsWith(matrix.platform, 'windows')
        shell: pwsh
        env:
          WIN_PFX_B64:      ${{ secrets.WIN_PFX_B64 }}
          WIN_PFX_PASSWORD: ${{ secrets.WIN_PFX_PASSWORD }}
        run: |
          [IO.File]::WriteAllBytes("cert.pfx", [Convert]::FromBase64String($env:WIN_PFX_B64))
          $pw = ConvertTo-SecureString -String $env:WIN_PFX_PASSWORD -AsPlainText -Force
          $cert = Import-PfxCertificate -FilePath cert.pfx -CertStoreLocation Cert:\CurrentUser\My -Password $pw
          "WIN_CERT_THUMBPRINT=$($cert.Thumbprint)" >> $env:GITHUB_ENV

      - name: Install deps
        working-directory: desktop
        run: pnpm install --frozen-lockfile

      - name: Build, sign, upload
        uses: tauri-apps/tauri-action@v0
        with:
          tagName: ${{ github.ref_name }}
          releaseName: 'Jellyclaw ${{ github.ref_name }}'
          releaseBody: 'See CHANGELOG.md'
          releaseDraft: true
          prerelease: false
          args: ${{ matrix.args }}
          projectPath: desktop
        env:
          # macOS
          APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
          APPLE_ID:               ${{ secrets.APPLE_ID }}
          APPLE_PASSWORD:         ${{ secrets.APPLE_PASSWORD }}
          APPLE_TEAM_ID:          ${{ secrets.APPLE_TEAM_ID }}
          # Windows — Tauri reads TAURI_CONF_JSON merge
          TAURI_CONF_JSON: |
            { "bundle": { "windows": { "certificateThumbprint": "${{ env.WIN_CERT_THUMBPRINT }}" } } }

      - name: Upload binaries to R2
        env:
          R2_ACCESS_KEY: ${{ secrets.R2_ACCESS_KEY }}
          R2_SECRET_KEY: ${{ secrets.R2_SECRET_KEY }}
          R2_ACCOUNT:    ${{ secrets.R2_ACCOUNT }}
          R2_BUCKET:     jellyclaw-releases-binaries
        run: node scripts/upload-r2.mjs --target ${{ matrix.target }} --tag ${{ github.ref_name }}

  publish-manifest:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build R2 manifest from GitHub release
        env: { GH_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
        run: node scripts/gen-manifest.mjs --tag ${{ github.ref_name }} > latest.json
      - name: Upload manifest
        env:
          R2_ACCESS_KEY: ${{ secrets.R2_ACCESS_KEY }}
          R2_SECRET_KEY: ${{ secrets.R2_SECRET_KEY }}
          R2_ACCOUNT:    ${{ secrets.R2_ACCOUNT }}
        run: |
          npx wrangler r2 object put jellyclaw-releases-manifests/latest.json \
            --file latest.json --remote
```

Secrets required (document in `docs/releases/RUNBOOK.md`):

`APPLE_CERT_P12`, `APPLE_CERT_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` (app-specific), `APPLE_TEAM_ID`, `KEYCHAIN_PASSWORD`, `WIN_PFX_B64`, `WIN_PFX_PASSWORD`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_ACCOUNT`.

**7. Test matrix** (`docs/releases/TEST-MATRIX.md`):

| OS                  | Arch     | Installer | Verification |
| ------------------- | -------- | --------- | ------------ |
| macOS 13 Ventura    | x86_64   | .dmg      | Gatekeeper accepts, app launches, engine sidecar starts |
| macOS 14 Sonoma     | arm64    | .dmg      | ditto |
| macOS 15 Sequoia    | arm64    | .dmg      | ditto + Notification Center grants permission |
| Windows 10 22H2     | x86_64   | .msi      | SmartScreen shows "unrecognized" warning → Run anyway succeeds |
| Windows 11 23H2     | x86_64   | .msi      | passive install, Start Menu entry correct |
| Ubuntu 22.04        | x86_64   | .deb, AppImage | `dpkg -i`, `./Jellyclaw.AppImage` |
| Ubuntu 24.04        | x86_64   | .deb, AppImage | ditto |
| Fedora 40           | x86_64   | .rpm, AppImage | `dnf install ./...rpm` |
| Debian 12           | x86_64   | .deb      | apt install works |
| Arch (latest)       | x86_64   | AUR       | `yay -S jellyclaw-bin` |

Use Parallels + VMware + UTM for VMs. Document the VM snapshots so they can be reset between releases.

**8. Download page** (Cloudflare Worker at `downloads.jellyclaw.dev`):

Renders an HTML page that reads `latest.json` from R2 and shows:

- "Download for macOS (Apple Silicon / Intel)" auto-detected via `navigator.userAgentData`
- SHA256 for each artifact (HEAD to binary URL → `x-amz-meta-sha256`)
- Release date, release notes, "See all versions"

**9. Release runbook** (`docs/releases/RUNBOOK.md`):

```
1. Merge all release PRs into main.
2. Update desktop/package.json + CHANGELOG.md.
3. git tag v1.0.1 && git push --tags
4. Watch GitHub Actions `release` workflow. Expect ~40 min total.
5. Once all 4 platforms green + draft release is created, download each artifact and VM-test per TEST-MATRIX.
6. Edit the GitHub release: unmark "draft", publish.
7. `publish-manifest` job fires → R2 latest.json updated.
8. Verify: on a machine with an older install, relaunch → UpdateBanner within 10s.
9. Post to Discord + Twitter (see templates/).
```

**10. Rollback runbook** (`docs/releases/ROLLBACK.md`):

```
Scenarios:
A. Broken binary for one platform only
B. Broken binary for all platforms
C. Auto-update itself is broken (wrong signature, wrong URL)

A: delete the bad asset from the GitHub release; re-run gen-manifest with --exclude-platform darwin-aarch64
B: rewrite R2 latest.json to point at the previous version (keep 3 previous versions in R2 under versions/<x>.json)
C: revert the manifest key in R2; push a hotfix build; announce in #announcements

Never delete binaries from R2 — auto-update relies on old URLs remaining valid for existing installs resuming downloads.
```

### Tests to add

- `release-matrix-test.yml` — same matrix as `release.yml` but `--target x86_64` only and `releaseDraft: true --dry-run` on PR; ensures the matrix compiles on every PR.
- `scripts/gen-manifest.test.mjs` — unit tests for manifest shape, semver ordering, missing-platform fallback.
- Manual VM tests per TEST-MATRIX on every release.

### Verification

```bash
# Local end-to-end dry run (Linux only, no cert needed)
cd /Users/gtrush/Downloads/jellyclaw-engine/desktop
pnpm install
pnpm tauri build --bundles appimage,deb,rpm
ls src-tauri/target/release/bundle/appimage/
ls src-tauri/target/release/bundle/deb/
ls src-tauri/target/release/bundle/rpm/

# Confirm dependencies
dpkg-deb -I src-tauri/target/release/bundle/deb/*.deb | grep -i depends

# CI smoke — push a tag to a scratch branch
git tag v0.9.99-test
git push origin v0.9.99-test
# Watch Actions; expect 4 green jobs + 1 draft release + 4 artifacts
# Delete the scratch release + tag after verification
```

### Common pitfalls

- **glibc version mismatch.** Building on Ubuntu 24.04 produces binaries that won't load on Ubuntu 22.04. Always build on the oldest supported distro (22.04). glibc is forward-compatible, not backward.
- **AppImage + zypak/sandboxing.** Flatpak sandboxing + Electron-style sandboxing don't apply to Tauri, but users on NixOS / bubblewrap setups may need `--no-sandbox`-style workarounds. Document in TEST-MATRIX.
- **Timestamp URL drops.** `http://timestamp.digicert.com` occasionally 500s. The workflow should retry signing 3x with a 30s backoff.
- **Wix GUID stability.** `upgradeCode` MUST remain constant across all releases; otherwise users get two installed copies side-by-side instead of an upgrade.
- **Azure Trusted Signing.** An alternative to file-based certs; cheaper ($10/mo) but requires Azure AD. Documented as future option; MVP uses file-based PFX.
- **Secrets in PR workflows.** The `release-matrix-test.yml` must NOT have access to signing secrets (use `pull_request` trigger, not `pull_request_target`). Unsigned dry-run only.
- **macos-13 runner deprecation.** GitHub sunset macos-12 already; macos-13 is next. Rename matrix target to `macos-14-large` when the deprecation notice lands.
- **Flathub review cycle** is 1–4 weeks. Plan v1.0 launch assuming Flathub lags by 2 weeks; ship AppImage for Flathub-impatient Linux users in the meantime.
- **RPM on Fedora Silverblue.** Silverblue uses rpm-ostree, which doesn't install regular RPMs. Flatpak is the only path there. Document.
- **Windows Defender real-time scanning** blocks signtool on GitHub runners occasionally. Retry logic + 60s timeout on the signtool invocation.
- **Universal macOS + sidecar arch.** Prompt 15.05 ships a universal binary. Do NOT switch to per-arch here without also splitting the R2 manifest — the updater URL is served per target.
- **R2 public bucket + custom domain.** Custom domain must have Cloudflare proxy ON for R2 public access to work; OFF = 403. Easy to miss.
- **Github release assets vs R2 binaries.** We upload to BOTH — GitHub for discoverability + manual downloads, R2 for the updater. Don't rely on GitHub for updater URLs (rate limits apply).
- **SmartScreen reputation is per-cert, not per-publisher.** Rotating certs resets reputation. Budget one cert per 2-3 year cycle.

### Why this matters

Phase 15 proved we can ship one platform. Phase 16.05 proves we can ship all three, repeatably, from a tag push, with signatures that survive `codesign --verify`, `signtool verify /pa`, and `tauri signer verify`. Without this, Jellyclaw is a "Mac app" — with it, Jellyclaw is software people can install from Arch, Fedora, Ubuntu, Debian, Windows 10, Windows 11, and three macOS versions with equal confidence. Phase 18 (open-source release) starts from here.

---

## Session closeout

Paste `COMPLETION-UPDATE-TEMPLATE.md` with `<NN>=16`. Mark 16.05 complete **AND Phase 16 ✅ complete**. Update progress bar to `16/20`. Commit `docs: phase 16 complete — desktop app polish`. Next phase: `prompts/phase-17/01-<name>.md` (see `prompts/phase-17/` for the first prompt of Jellyclaw integration).

🎉 Phase 16 shipping condition: a user on macOS, Windows, or Linux can download, install, launch, dispatch a wish, approve a tool, get a response, and receive an auto-update — all without opening a terminal.
