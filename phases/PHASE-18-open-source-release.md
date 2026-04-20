---
phase: 18
name: "Open-source release"
duration: "2 days"
depends_on: [11, 14, 16, 17]
blocks: [19]
---

# Phase 18 — Open-source release

## Dream outcome

`npm install -g jellyclaw` or `brew install jellyclaw` installs a working CLI. The docs site at `jellyclaw.dev` explains the engine, walks through Quickstart, and lists phases + architecture. A GitHub repo goes public with a clean history, CHANGELOG, security policy, contribution guide. A launch blog post goes live.

## Deliverables

- Public GitHub repo at `github.com/gtrush03/jellyclaw-engine` (or chosen org)
- `npm` package `@jellyclaw/engine` + CLI package `jellyclaw`
- Homebrew formula
- Docs site on Vercel (`jellyclaw.dev`) built from `docs/`
- `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`
- Release binaries for Desktop (Phase 16) attached to GitHub Release
- Announcement blog post (personal blog + dev.to + HN Show HN)
- Discord server

## Step-by-step

### Step 1 — History hygiene
- Squash pre-public commits into a clean series, OR rewrite via `git filter-repo` to strip any secrets
- Verify: `gitleaks detect` clean
- Verify: no `.env`, no token in history

### Step 2 — Legal
- MIT license already present (Phase 00)
- Trademark check for "jellyclaw" name
- `NOTICE` file for upstream attribution (OpenCode)

### Step 3 — Public repo push
```bash
gh repo create gtrush03/jellyclaw-engine --public --source . --push
```

### Step 4 — npm publish
- Two packages: `@jellyclaw/engine` (library) + `jellyclaw` (CLI)
- `pnpm publish --filter @jellyclaw/engine --access public`
- `pnpm publish --filter jellyclaw --access public`
- Tag release `v0.1.0`

### Step 5 — Homebrew formula
Create tap repo `gtrush03/homebrew-jellyclaw`:
```ruby
class Jellyclaw < Formula
  desc "Open-source Claude Code replacement"
  homepage "https://jellyclaw.dev"
  url "https://registry.npmjs.org/jellyclaw/-/jellyclaw-0.1.0.tgz"
  sha256 "..."
  depends_on "node@20"
  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end
end
```

### Step 6 — Docs site
- Vite + Vocs (or Docusaurus/Astro Starlight)
- Structure: Home, Quickstart, Configuration, Providers, Tools, Skills, Agents, MCP, Hooks, Sessions, Desktop, Integration, Architecture, Phases
- Deploy to Vercel `jellyclaw.dev`

### Step 7 — Security + contribution
- `SECURITY.md` — vulnerability disclosure email + GPG key
- `CONTRIBUTING.md` — dev setup, test commands, PR template
- `CODE_OF_CONDUCT.md` — Contributor Covenant
- `.github/ISSUE_TEMPLATE/*.yml` bug / feature / question
- `.github/PULL_REQUEST_TEMPLATE.md`

### Step 8 — CHANGELOG
Keep-a-changelog format. First entry: `v0.1.0 — Initial public release`.

### Step 9 — Launch
- Blog post: "Why we built jellyclaw — a thin, patched wrapper on OpenCode that matches Claude Code UX"
- Show HN thread
- X thread
- Discord invite link
- Submit to `awesome-claude-code` + `awesome-mcp`

### Step 10 — Monitor launch
48 h window for rapid response:
- Track GitHub issues; triage <24 h
- Monitor npm download counts
- HN / X replies

## Acceptance criteria

- [ ] GitHub repo public, clean history, CI green on `main`
- [ ] `npm install -g jellyclaw && jellyclaw --version` works on fresh Node 20
- [ ] `brew install gtrush03/jellyclaw-engine/jellyclaw` works on fresh macOS
- [ ] Docs site live at `jellyclaw.dev`
- [ ] Desktop .dmg / .AppImage / .msi attached to `v0.1.0` release
- [ ] Blog post + Show HN live
- [ ] Discord server up

## Risks + mitigations

- **Secret leak in history** → `gitleaks` pre-publish; squash if found.
- **Name conflict on npm/brew** → pre-reserve `jellyclaw` npm name now (Phase 00 if not already).
- **Launch bug surge** → pre-write issue templates + canned responses; have 48 h free calendar.

## Dependencies to install

```
@vocs/cli@^1 OR @astrojs/starlight@^0.28
```

## Files touched

- `CHANGELOG.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `NOTICE`
- `.github/ISSUE_TEMPLATE/*.yml`, `.github/PULL_REQUEST_TEMPLATE.md`
- `docs-site/**` (or `docs/` converted)
- Homebrew tap repo
- Blog post (external)
