# Release Process

This document describes the release procedure for maintainers.

## Prerequisites

1. **npm account** with publish access to `@jellyclaw/engine`
2. **Apple Developer account** with signing certificate and notarization credentials
3. **GitHub PAT** with access to push to `gtrush/homebrew-jellyclaw`

## Release Checklist

### 1. Pre-release verification

```bash
# Ensure clean working tree
git status

# Run full test suite
bun run typecheck
bun run lint
bun run test

# Test the build
bun run build

# Dry-run npm publish
scripts/publish-npm.sh --dry-run --sandbox /tmp/jc-release-test
/tmp/jc-release-test/bin/jellyclaw --version
/tmp/jc-release-test/bin/jellyclaw doctor --json
rm -rf /tmp/jc-release-test
```

### 2. Version bump

Update version in:
- `engine/package.json` — canonical version
- `desktop/src-tauri/tauri.conf.json` — desktop app version

```bash
# Example
sed -i '' 's/"version": "0.0.1"/"version": "0.1.0"/' engine/package.json
sed -i '' 's/"version": "0.1.0"/"version": "0.1.0"/' desktop/src-tauri/tauri.conf.json
```

### 3. Update CHANGELOG

Add release notes to `CHANGELOG.md`:

```markdown
## [0.1.0] - 2024-XX-XX

### Added
- Feature description

### Fixed
- Bug fix description

### Changed
- Change description
```

### 4. Commit and tag

```bash
git add -A
git commit -m "chore(release): v0.1.0"
git tag v0.1.0
git push origin main --tags
```

### 5. CI handles the rest

The GitHub Actions workflow (`.github/workflows/release.yml`) automatically:

1. Builds the universal engine binary
2. Creates a signed, notarized DMG
3. Publishes to npm with `@jellyclaw/engine@latest`
4. Updates the Homebrew tap formula
5. Creates a GitHub Release with release notes

### 6. Post-release verification

After CI completes:

```bash
# Verify npm
npm view @jellyclaw/engine

# Test npm install
npm install -g @jellyclaw/engine
jellyclaw --version
jellyclaw doctor

# Verify Homebrew (macOS)
brew update
brew install gtrush/jellyclaw/jellyclaw
jellyclaw --version

# Check GitHub Release
# https://github.com/gtrush03/jellyclaw-engine/releases
```

## Secrets Configuration

The following secrets must be configured in GitHub repository settings:

| Secret | Description |
|--------|-------------|
| `NPM_TOKEN` | npm automation token with publish access |
| `BREW_TAP_TOKEN` | GitHub PAT with push access to homebrew-jellyclaw |
| `APPLE_SIGNING_IDENTITY` | Code signing identity (e.g., "Developer ID Application: Name") |
| `APPLE_TEAM_ID` | Apple Developer Team ID |
| `APPLE_NOTARIZATION_APPLE_ID` | Apple ID for notarization |
| `APPLE_NOTARIZATION_PASSWORD` | App-specific password for notarization |
| `APPLE_NOTARIZATION_TEAM_ID` | Team ID for notarization |

## Rollback

If a release has critical issues:

### npm

```bash
npm unpublish @jellyclaw/engine@0.1.0
# or deprecate
npm deprecate @jellyclaw/engine@0.1.0 "Critical bug, use 0.0.1"
```

### Homebrew

Update the formula to point to the previous version:

```bash
cd homebrew-jellyclaw
git revert HEAD
git push
```

### GitHub Release

1. Go to Releases page
2. Edit the release
3. Mark as pre-release or delete
