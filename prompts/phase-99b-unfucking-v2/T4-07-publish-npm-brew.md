---
id: T4-07-publish-npm-brew
tier: 4
title: "Publish @jellyclaw/engine to npm + Homebrew formula + CI release workflow"
scope:
  - "package.json"
  - "engine/package.json"
  - "engine/bin/jellyclaw"
  - "engine/bin/jellyclaw-serve"
  - "engine/bin/jellyclaw-daemon"
  - ".npmignore"
  - ".github/workflows/release.yml"
  - "scripts/publish-npm.sh"
  - "scripts/build-brew-formula.sh"
  - "scripts/jellyclaw-doctor.ts"
  - "engine/src/cli/doctor.ts"
  - "engine/src/cli/doctor.test.ts"
  - "engine/src/cli/main.ts"
  - "docs/install.md"
  - "docs/release.md"
  - "homebrew/jellyclaw.rb.template"
depends_on_fix:
  - T4-06-tauri-desktop-sidecar
tests:
  - name: npm-pack-contains-bins
    kind: shell
    description: "npm pack produces a tarball whose bin/ directory contains jellyclaw, jellyclaw-serve, jellyclaw-daemon and is <30MB"
    command: "bun run test scripts -t npm-pack-valid"
    expect_exit: 0
    timeout_sec: 120
  - name: npm-install-global-smoke
    kind: shell
    description: "npm pack + npm install -g <tarball> in a tmp sandbox produces a working jellyclaw command"
    command: "scripts/publish-npm.sh --dry-run --sandbox /tmp/jc-npm-smoke && /tmp/jc-npm-smoke/bin/jellyclaw --version"
    expect_exit: 0
    timeout_sec: 300
  - name: brew-formula-generated
    kind: shell
    description: "scripts/build-brew-formula.sh writes a Homebrew formula with correct sha256 + url for the current release tag"
    command: "scripts/build-brew-formula.sh --tag v0.0.1 --dmg-url https://example/j.dmg --dmg-sha $(printf deadbeef | shasum -a 256 | awk '{print $1}')"
    expect_exit: 0
    timeout_sec: 30
  - name: doctor-passes-on-clean-install
    kind: shell
    description: "jellyclaw doctor exits 0 with all green checks on a fresh install (node, bun, scheduler socket optional, paths writable)"
    command: "bun run test engine/src/cli/doctor -t doctor-clean-install-exits-0"
    expect_exit: 0
    timeout_sec: 30
  - name: release-workflow-yaml-valid
    kind: shell
    description: ".github/workflows/release.yml is valid YAML, triggered on v* tags, publishes to npm and updates the homebrew tap"
    command: "bun run test scripts -t release-workflow-valid"
    expect_exit: 0
    timeout_sec: 20
human_gate: true
max_turns: 85
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 180
---

# T4-07 — Publish @jellyclaw/engine (npm + Homebrew + CI)

## Context
`package.json:2` today sets `"private": true` and `"name": "@jellyclaw/engine-root"`. Nothing ships anywhere. T4-06 produced a signed DMG + single-file engine binary; T4-07 wraps those into two first-class install paths users actually reach for:

1. **`npm install -g @jellyclaw/engine`** — for the developer audience. `bin` entries point at the compiled binary so `jellyclaw` works immediately post-install.
2. **`brew install gtrush/jellyclaw/jellyclaw`** — for the macOS audience. A custom tap at `gtrush/homebrew-jellyclaw` carries a formula that downloads the signed DMG artifact from T4-06.

Plus: a `jellyclaw doctor` subcommand that catches install-time misconfigurations, and a CI release workflow that automates both publishes on tag.

Reference material:
- `package.json:13-16` — current bin entries; we extend with `jellyclaw-daemon` (T4-01) and ensure all three point at the right target post-publish.
- `package.json:87-91` — current workspaces config; we narrow what ships in the published `@jellyclaw/engine` package.
- `engine/bin/jellyclaw` and `engine/bin/jellyclaw-serve` already exist; `jellyclaw-daemon` arrives via T4-01.
- Homebrew custom tap convention: `gtrush/homebrew-jellyclaw` → formula at `Formula/jellyclaw.rb` → `brew install gtrush/jellyclaw/jellyclaw`.

## Root cause (from audit)
With zero published artifacts, every new user has to clone the repo and `bun install`. This is the last remaining gap to the hero use case promised on the repo cover: "open-source Claude Code replacement the world uses." Without npm + brew, the world cannot, in fact, use it.

## Fix — exact change needed

### 1. Package split — `engine/package.json` becomes the published artifact
- Root `package.json` stays private (`"private": true`) and keeps the workspace setup.
- New `engine/package.json` (or updated if already present) with:
  ```json
  {
    "name": "@jellyclaw/engine",
    "version": "0.0.1",
    "description": "Open-source embeddable Claude Code replacement (wraps OpenCode).",
    "type": "module",
    "license": "MIT",
    "author": "George Trushevskiy",
    "homepage": "https://github.com/gtrush03/jellyclaw-engine",
    "repository": { "type": "git", "url": "https://github.com/gtrush03/jellyclaw-engine.git" },
    "bin": {
      "jellyclaw": "./bin/jellyclaw",
      "jellyclaw-serve": "./bin/jellyclaw-serve",
      "jellyclaw-daemon": "./bin/jellyclaw-daemon"
    },
    "files": ["bin/", "dist/", "README.md", "LICENSE", "CHANGELOG.md"],
    "engines": { "node": ">=20.6" }
  }
  ```
- The bin shims (`engine/bin/jellyclaw`, etc.) are POSIX `#!/usr/bin/env node` shims that `require("../dist/cli/main.js")`, exactly as they do today. The **compiled binary** from T4-06 is NOT in the npm package (too large; OS-specific). Users who want the single-file binary reach for `brew` or download the DMG from Releases.
- Critical: T0-01's basename-based dispatch (for `jellyclaw-serve`) and T4-01's for `jellyclaw-daemon` both work unchanged because the shims live in `bin/` of the installed package and symlinks preserve basename.

### 2. `.npmignore`
- Exclude `desktop/`, `.autobuild/`, `.orchestrator/`, `logs/`, `dist/bin/` (the compiled binary), test fixtures, phases docs, integration docs, prompts, `*.test.ts`, `*.spec.ts`.
- Explicitly include `dist/` (compiled TypeScript output) and `bin/`.
- Target tarball size: **<30MB**. Enforced in `scripts/publish-npm.sh`.

### 3. `scripts/publish-npm.sh`
- Bash, `set -euo pipefail`.
- Flags: `--dry-run`, `--sandbox <dir>` (installs into a throwaway prefix for smoke testing), `--tag <npm-tag>` (default `latest`).
- Steps:
  1. Verify tree is clean and on a tagged commit; abort otherwise.
  2. `bun run typecheck && bun run lint && bun run test`.
  3. `bun run build` (tsup → `engine/dist/`).
  4. From `engine/` directory: `npm pack` → inspect tarball, assert size < 30MB, assert `package/bin/jellyclaw` exists and is executable (`tar -tzf … | grep 'package/bin/jellyclaw$'`).
  5. In `--dry-run` mode: `npm install -g <tarball> --prefix <sandbox>`; verify `<sandbox>/bin/jellyclaw --version` exits 0.
  6. Otherwise: `npm publish --tag <tag>` using `NODE_AUTH_TOKEN` from env (GitHub Actions's `NPM_TOKEN` secret).
- Fails loud if npm token missing in non-dry-run mode.

### 4. `scripts/build-brew-formula.sh` + `homebrew/jellyclaw.rb.template`
- Template (Ruby, Homebrew formula DSL):
  ```ruby
  class Jellyclaw < Formula
    desc "Open-source Claude Code replacement (wraps OpenCode)"
    homepage "https://github.com/gtrush03/jellyclaw-engine"
    url "__DMG_URL__"
    sha256 "__DMG_SHA256__"
    version "__VERSION__"
    depends_on :macos => :monterey

    def install
      # Extract the .app from the DMG and drop the binary into bin/.
      system "hdiutil", "attach", "-nobrowse", "-mountpoint", buildpath/"mnt", "--", cached_download
      bin.install buildpath/"mnt/Jellyclaw.app/Contents/Resources/jellyclaw-engine/jellyclaw"
      system "hdiutil", "detach", buildpath/"mnt"
    end

    test do
      assert_match "jellyclaw", shell_output("#{bin}/jellyclaw --version")
    end
  end
  ```
- `scripts/build-brew-formula.sh --tag vX.Y.Z --dmg-url <url> --dmg-sha <sha>` substitutes the three placeholders and writes `homebrew/jellyclaw.rb`. In CI, a follow-up step checks out `gtrush/homebrew-jellyclaw`, copies the formula to `Formula/jellyclaw.rb`, commits, and pushes.

### 5. `engine/src/cli/doctor.ts` + registration
- `jellyclaw doctor` subcommand — health check matrix:
  | Check                                       | Pass criteria                                             | Severity |
  | ------------------------------------------- | --------------------------------------------------------- | -------- |
  | Node version                                | `>= 20.6`                                                 | error    |
  | Bun version (if compiled binary path)       | `>= 1.1`                                                  | warn     |
  | `~/.jellyclaw/` writable                    | mkdir + write a sentinel + unlink                         | error    |
  | `~/.claude/` exists                         | directory present                                         | warn     |
  | `~/.claude/skills/` readable                | readdir no error                                          | warn     |
  | `~/.claude/plugins/` readable (T4-05)       | readdir no error                                          | warn     |
  | Scheduler socket (T4-01) reachable          | ipc status verb returns within 1s                         | info     |
  | Anthropic creds reachable (from T0-02)      | key or oauth token present                                | warn     |
  | MCP config parseable                        | Zod ok on `~/.claude/mcp.json`                            | warn     |
  | Tool registry size                          | > 0 builtins + any MCP + any plugin tools                 | error    |
- Output: colorized checklist; `--json` mode for programmatic consumption; exit code 0 if all `error` checks pass, 1 otherwise. Warns and infos never flip the exit code.
- Register in `engine/src/cli/main.ts` alongside existing subcommands.
- Tests in `engine/src/cli/doctor.test.ts` include `doctor-clean-install-exits-0` (fake-fs with happy-path) and `doctor-missing-creds-warns-not-errors`.

### 6. `.github/workflows/release.yml`
- Triggers on tag `v*`.
- Jobs (sequential by design):
  1. **build-engine-binary** (macos-14) — runs `scripts/build-engine.sh --target universal --sign "$SIGNING_IDENTITY"`. Uploads artifact.
  2. **build-dmg** (macos-14) — depends on (1); invokes T4-06's `scripts/build-dmg.sh` in real mode (not `--ci-mode=mock`). Uploads signed + notarized + stapled DMG artifact and emits `dmg_url` + `dmg_sha256` outputs.
  3. **publish-npm** (ubuntu-latest) — depends on (1); runs `scripts/publish-npm.sh --tag latest` with `NODE_AUTH_TOKEN=$NPM_TOKEN`.
  4. **update-brew-tap** (ubuntu-latest) — depends on (2); runs `scripts/build-brew-formula.sh --tag $GITHUB_REF_NAME --dmg-url <from job 2> --dmg-sha <from job 2>`, then pushes to `gtrush/homebrew-jellyclaw` using a PAT in `BREW_TAP_TOKEN`.
  5. **github-release** (ubuntu-latest) — depends on (2) and (3); creates a GitHub Release from the tag, attaches the DMG and npm tarball.
- Secrets declared (required in workflow): `NPM_TOKEN`, `BREW_TAP_TOKEN`, plus the five Apple secrets already listed in T4-06.
- Each job writes a summary to `GITHUB_STEP_SUMMARY` with the artifact URLs + sha256s.

### 7. Docs
- `docs/install.md` — three user-facing paths (npm, brew, DMG); sample sessions for each; "verify with `jellyclaw doctor`".
- `docs/release.md` — maintainer-facing release procedure: version bump → tag push → CI → GitHub Release → verification checklist.

## Acceptance criteria
- `npm pack` produces a <30MB tarball containing all three bin entries (maps to `npm-pack-contains-bins`).
- Global install in a sandbox prefix yields a working `jellyclaw --version` (maps to `npm-install-global-smoke`).
- Brew formula generator writes valid Ruby with correct url + sha + version (maps to `brew-formula-generated`).
- `jellyclaw doctor` exits 0 on a clean install (maps to `doctor-passes-on-clean-install`).
- Release workflow YAML is valid and uses `v*` tag triggers (maps to `release-workflow-yaml-valid`).
- `bun run typecheck` + `bun run lint` + full suite pass.

## Out of scope
- Do NOT actually publish to npm or push to the brew tap from within the prompt execution. The worker verifies the scripts work end-to-end in `--dry-run` mode only. Real publishes happen on tag push by the CI workflow, not during autobuild.
- Do NOT implement auto-update in the shipped artifact. Upgrades are via `npm update -g @jellyclaw/engine` or `brew upgrade jellyclaw`.
- Do NOT implement a Linux distribution path (apt, dnf, AUR, Snap, Flatpak) — Linux users take the npm path. A later prompt can add Linux packagers.
- Do NOT implement a Chocolatey / Scoop / winget path. Windows is out of scope at this tier.
- Do NOT change root `package.json`'s `"private": true` flag — the root is and remains unpublishable. The published package is `engine/`.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/cli/doctor
scripts/publish-npm.sh --dry-run --sandbox /tmp/jc-npm-selfcheck
/tmp/jc-npm-selfcheck/bin/jellyclaw --version
/tmp/jc-npm-selfcheck/bin/jellyclaw doctor --json
scripts/build-brew-formula.sh --tag v0.0.1 \
  --dmg-url https://example.com/jellyclaw.dmg \
  --dmg-sha $(printf deadbeef | shasum -a 256 | awk '{print $1}')
grep -c "__DMG_URL__\|__DMG_SHA256__\|__VERSION__" homebrew/jellyclaw.rb
rm -rf /tmp/jc-npm-selfcheck
```
