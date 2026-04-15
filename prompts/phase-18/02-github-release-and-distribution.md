# Phase 18 — Open-source release — Prompt 02: GitHub release, npm, Homebrew, release automation

**When to run:** After Phase 18 Prompt 01 is complete (docs site live at `jellyclaw.dev` + `docs.jellyclaw.dev`). This prompt depends on the docs URL being live because `package.json.homepage`, the brew formula, and the GitHub repo "About" sidebar all reference it. Must run before Prompt 03 — the announcement needs install commands that actually work.
**Estimated duration:** 6–8 hours (plus a full clean-VM rebuild verification cycle)
**New session?** Yes — start a fresh Claude Code session
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `18` and `<name>` with `open-source-release`.

---

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-18-open-source-release.md` Steps 1–5, 7–8 (history hygiene, legal, public repo, npm, brew, security, CHANGELOG).
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` end to end — the GitHub SECURITY.md we ship must reflect the threat model, disclosure process, and CVE policy. Copy §4 (Incident Response) and §6 (Update Channel & CVE Policy) verbatim.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/CHANGELOG.md` current state — first public release entry is `v0.1.0 — Initial public release`.
4. Read `/Users/gtrush/Downloads/jellyclaw-engine/MASTER-PLAN.md` §3 (dream outcome) and the `ROADMAP.md` Q2 2026 section — v0.1.0 is the *first public* release; v1.0.0 is reserved for Phase 13 complete + 30 days in Genie prod. Do not jump to 1.0 here.
5. WebFetch:
   - `https://docs.npmjs.com/creating-and-publishing-scoped-public-packages` — scoped public scope + 2FA
   - `https://docs.npmjs.com/generating-provenance-statements` — npm provenance via GitHub Actions OIDC
   - `https://docs.brew.sh/Formula-Cookbook` — formula anatomy, `test do` block
   - `https://docs.brew.sh/Taps` — custom tap directory structure, naming `homebrew-<name>`
   - `https://docs.brew.sh/Cask-Cookbook` — cask for the desktop .dmg
   - `https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/about-coordinated-disclosure-of-security-vulnerabilities` — coordinated disclosure process
   - `https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/creating-a-repository-security-advisory` — creating GHSAs
   - `https://cli.github.com/manual/gh_repo_edit` — `gh repo edit --visibility public`
   - `https://github.com/changesets/changesets` — Changesets workflow
   - `https://www.conventionalcommits.org/en/v1.0.0/` — Conventional Commits
   - `https://www.contributor-covenant.org/version/2/1/code_of_conduct/` — CoC v2.1
6. Resolve library IDs via `mcp__plugin_compound-engineering_context7__resolve-library-id` for `changesets/changesets` and query `query-docs` for "changesets github action" and "provenance publish".

## Implementation task

Take the jellyclaw-engine repo public, publish `@jellyclaw/engine` + `jellyclaw` CLI to npm with provenance, create the Homebrew tap with formula + cask, and wire release automation so future releases are a tag push.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/SECURITY.md` (repo root — separate from `engine/SECURITY.md`, which remains the deep threat model; the root file is the one-page disclosure policy GitHub surfaces)
- `/Users/gtrush/Downloads/jellyclaw-engine/CODE_OF_CONDUCT.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/CONTRIBUTING.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/NOTICE` — attribution to OpenCode (MIT), Claurst, Genie, Hermes, pi-mono
- `/Users/gtrush/Downloads/jellyclaw-engine/.github/ISSUE_TEMPLATE/bug.yml`, `feature.yml`, `question.yml`, `config.yml` (disables blank issues, redirects security to GHSA)
- `/Users/gtrush/Downloads/jellyclaw-engine/.github/PULL_REQUEST_TEMPLATE.md`
- `/Users/gtrush/Downloads/jellyclaw-engine/.github/CODEOWNERS`
- `/Users/gtrush/Downloads/jellyclaw-engine/.github/dependabot.yml`
- `/Users/gtrush/Downloads/jellyclaw-engine/.github/workflows/test.yml` (probably exists; update if so)
- `/Users/gtrush/Downloads/jellyclaw-engine/.github/workflows/release.yml` (new)
- `/Users/gtrush/Downloads/jellyclaw-engine/.changeset/config.json` — Changesets config
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/package.json` — `name: "@jellyclaw/engine"`, `publishConfig.access: "public"`, `publishConfig.provenance: true`, `repository`, `bugs`, `homepage`
- `/Users/gtrush/Downloads/jellyclaw-engine/cli/package.json` — `name: "jellyclaw"` (unscoped), same publish config
- `/Users/gtrush/Downloads/jellyclaw-engine/gpg/security-pubkey.asc` — PGP public key for `security@gtru.xyz`
- **Separate tap repo:** `github.com/gtrush03/homebrew-jellyclaw/Formula/jellyclaw.rb` and `Casks/jellyclaw-desktop.rb`

### Prerequisites check

```bash
which gh && gh --version                         # >=2.40
gh auth status                                   # authenticated
which gitleaks || brew install gitleaks
gitleaks detect --source . --verbose             # MUST be clean
grep -rnw . -e 'ANTHROPIC_API_KEY' --include='*.ts' | grep -v 'process.env' # only refs, no literals
ls -la .env* 2>/dev/null                         # must not be tracked
git ls-files | xargs grep -l 'sk-ant-' 2>/dev/null # MUST be empty

which npm && npm --version                       # >=10
npm whoami                                       # must be logged in
npm access ls-packages @jellyclaw 2>/dev/null || echo "scope not yet claimed"

which brew && brew --version                     # any recent
which pnpm && pnpm --version                     # 9.x
```

If `gitleaks` finds anything, STOP. Do not make the repo public until the history is clean. Use `git filter-repo` (not `git filter-branch` — deprecated) to strip. See Step 1.

### Step-by-step implementation

1. **History hygiene.**
   - `gitleaks detect --source . --verbose` — must be clean.
   - `git log --all --full-history --source --pretty=format:'%H %s' > /tmp/all-commits.txt` and scan for words like `secret`, `password`, `token` — sanity check.
   - If anything leaked: `pip install git-filter-repo && git filter-repo --path .env --invert-paths --force` then force-push the sanitized tree to a new private mirror before making public. Destructive, confirm with user first.
   - Ensure `.gitignore` covers `.env`, `.env.local`, `*.pem`, `*.key`, `secrets/`.

2. **Legal.**
   - Verify `LICENSE` is MIT (Phase 00).
   - Trademark check for "jellyclaw" — search USPTO TESS + WIPO Global Brand DB before public launch. Ship anyway if no active mark on "software development tools" (Nice class 9 / 42); document the check result in `NOTICE`.
   - Write `NOTICE`:
     ```
     Jellyclaw
     Copyright (c) 2026 George Trushevskiy
     Licensed under the MIT License (see LICENSE).

     This product includes software developed by:
     - OpenCode (https://github.com/sst/opencode) — MIT License
     - Hermes Agent (https://github.com/NousResearch/hermes-agent)
     - pi-mono (Mario Zechner) — MIT License
     - Claurst (Kuber Mehta) — MIT License

     See engine/opencode/LICENSE for upstream OpenCode copyright.
     ```

3. **Write `SECURITY.md`** at repo root (short, links to the deep model):
   ```markdown
   # Security Policy

   ## Supported versions
   | Version | Supported |
   | ------- | --------- |
   | 0.x     | ✅ until 1.0 ships |
   | <1.0    | N/A       |

   ## Reporting a vulnerability
   Email `security@gtru.xyz` (PGP: see `gpg/security-pubkey.asc`).
   Or open a [private Security Advisory](https://github.com/gtrush03/jellyclaw-engine/security/advisories/new).

   **Do not open a public issue.** We honor a 90-day disclosure window
   per our [CVE policy](engine/SECURITY.md#6-update-channel--cve-policy).
   We credit reporters in the advisory unless they prefer anonymity.

   Full threat model: [`engine/SECURITY.md`](engine/SECURITY.md).
   ```

4. **Write `CODE_OF_CONDUCT.md`** — drop in Contributor Covenant v2.1 verbatim, with `security@gtru.xyz` as the enforcement contact.

5. **Write `CONTRIBUTING.md`** — dev setup, test commands (from CLAUDE.md), Conventional Commits, PR checklist:
   ```markdown
   # Contributing to Jellyclaw

   ## Dev setup
   bun install; bun run build; bun run test

   ## Before opening a PR
   - [ ] `bun run lint` clean
   - [ ] `bun run typecheck` clean
   - [ ] `bun run test` green
   - [ ] New behavior has a test (TDD preferred)
   - [ ] Commit messages follow Conventional Commits (feat:/fix:/chore: …)
   - [ ] Changeset added (`pnpm changeset`)
   - [ ] Docs updated in `docs-site/` if user-facing

   ## Picking something to work on
   Look at `phases/` — we work phase-by-phase. Issues tagged
   `good first issue` are scoped small enough to land in an evening.

   ## Code review
   Maintainers aim to first-respond in 72h. Reviews focus on:
   - Does it belong in core, or as a skill/agent/MCP? (§Feature gate)
   - Does it add a hook bypass? (see engine/SECURITY.md §2.8)
   ```

6. **Issue templates** at `.github/ISSUE_TEMPLATE/`:
   - `bug.yml` — structured form: what happened, repro, expected, logs, version, platform
   - `feature.yml` — the 4-question gate from PHASE-19: who, pain, can-a-skill-solve-it, maintenance cost
   - `question.yml` — redirects to Discord `#help` as primary channel
   - `config.yml` — `blank_issues_enabled: false`, `contact_links` pointing at Discord + GHSA

7. **PR template** at `.github/PULL_REQUEST_TEMPLATE.md` — summary, linked issue, checklist (tests, lint, docs, changeset), screenshots for UI changes.

8. **CODEOWNERS** — `* @gtrush03` for now; add co-maintainers as they appear per Phase 19 contributor ladder.

9. **Dependabot** at `.github/dependabot.yml`:
   ```yaml
   version: 2
   updates:
     - package-ecosystem: npm
       directory: /
       schedule: { interval: weekly, day: monday }
       open-pull-requests-limit: 5
       groups:
         opencode:
           patterns: ['opencode-ai', '@opencode-ai/*']
     - package-ecosystem: github-actions
       directory: /
       schedule: { interval: weekly }
   ```

10. **Changesets init.**
    ```bash
    pnpm add -Dw @changesets/cli
    pnpm changeset init
    ```
    Edit `.changeset/config.json` → `"access": "public"`, `"baseBranch": "main"`, `"updateInternalDependencies": "patch"`.

11. **npm scope setup.**
    ```bash
    npm login                                      # enable 2FA for publish
    npm org create jellyclaw                       # create the scope
    # in each package.json that's publishable:
    ```
    ```json
    {
      "name": "@jellyclaw/engine",
      "version": "0.1.0",
      "publishConfig": { "access": "public", "provenance": true },
      "repository": {
        "type": "git",
        "url": "git+https://github.com/gtrush03/jellyclaw-engine.git"
      },
      "bugs": { "url": "https://github.com/gtrush03/jellyclaw-engine/issues" },
      "homepage": "https://jellyclaw.dev",
      "license": "MIT"
    }
    ```
    The CLI package `jellyclaw` (unscoped — Phase 00 reserved the name) publishes with the same config but no scope.

12. **Make the repo public.**
    ```bash
    gh repo edit gtrush03/jellyclaw-engine \
      --visibility public \
      --description "Open-source Claude Code. Yours to own." \
      --homepage "https://jellyclaw.dev" \
      --add-topic ai-agents --add-topic claude-code \
      --add-topic mcp --add-topic llm-cli --add-topic opencode
    ```
    Enable in settings: Discussions, Issues, Projects, Security Advisories, Dependency graph, Dependabot alerts, Secret scanning, Push protection.

13. **Release workflow.** `.github/workflows/release.yml`:
    ```yaml
    name: Release
    on:
      push:
        branches: [main]
    permissions:
      contents: write
      pull-requests: write
      id-token: write            # required for npm provenance
    jobs:
      release:
        runs-on: ubuntu-latest
        steps:
          - uses: actions/checkout@v4
            with: { fetch-depth: 0 }
          - uses: pnpm/action-setup@v4
            with: { version: 9 }
          - uses: actions/setup-node@v4
            with: { node-version: 20, registry-url: 'https://registry.npmjs.org' }
          - run: pnpm install --frozen-lockfile
          - run: pnpm build
          - run: pnpm test
          - name: Create Release PR or Publish
            id: changesets
            uses: changesets/action@v1
            with:
              publish: pnpm changeset publish
              title: 'chore(release): version packages'
              commit: 'chore(release): version packages'
            env:
              GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
              NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          - name: Build desktop binaries
            if: steps.changesets.outputs.published == 'true'
            uses: ./.github/actions/build-desktop
          - name: Update Homebrew tap
            if: steps.changesets.outputs.published == 'true'
            run: ./scripts/update-brew.sh ${{ steps.changesets.outputs.publishedPackages }}
            env:
              HOMEBREW_TAP_TOKEN: ${{ secrets.HOMEBREW_TAP_TOKEN }}
          - name: Trigger Vercel deploy
            if: steps.changesets.outputs.published == 'true'
            run: curl -X POST ${{ secrets.VERCEL_DEPLOY_HOOK }}
    ```
    Secrets to set: `NPM_TOKEN` (automation token with 2FA-for-publish-only), `HOMEBREW_TAP_TOKEN` (PAT with `repo` on the tap repo), `VERCEL_DEPLOY_HOOK` (deploy hook URL from the docs project).

14. **Homebrew tap.**
    ```bash
    gh repo create gtrush03/homebrew-jellyclaw --public \
      --description "Homebrew tap for jellyclaw"
    mkdir -p homebrew-jellyclaw/Formula homebrew-jellyclaw/Casks
    ```
    `Formula/jellyclaw.rb`:
    ```ruby
    class Jellyclaw < Formula
      desc "Open-source Claude Code replacement"
      homepage "https://jellyclaw.dev"
      url "https://registry.npmjs.org/jellyclaw/-/jellyclaw-0.1.0.tgz"
      sha256 "REPLACE_WITH_SHA256_OF_TARBALL"
      license "MIT"
      depends_on "node@20"

      def install
        system "npm", "install", *std_npm_args
        bin.install_symlink Dir["#{libexec}/bin/*"]
      end

      test do
        assert_match(/jellyclaw/i, shell_output("#{bin}/jellyclaw --version"))
      end
    end
    ```
    `Casks/jellyclaw-desktop.rb` (for the Phase 16 .dmg):
    ```ruby
    cask "jellyclaw-desktop" do
      version "0.1.0"
      sha256 "REPLACE_WITH_SHA256_OF_DMG"
      url "https://github.com/gtrush03/jellyclaw-engine/releases/download/v#{version}/Jellyclaw-#{version}.dmg"
      name "Jellyclaw Desktop"
      desc "Desktop UI for the jellyclaw engine"
      homepage "https://jellyclaw.dev"
      depends_on macos: ">= :sonoma"
      app "Jellyclaw.app"
      zap trash: [
        "~/Library/Application Support/dev.jellyclaw.desktop",
        "~/Library/Preferences/dev.jellyclaw.desktop.plist",
      ]
    end
    ```
    `scripts/update-brew.sh` fetches the published tarball + DMG, computes SHA256, rewrites both files, commits to the tap repo.

    User install: `brew tap gtrush03/jellyclaw && brew install jellyclaw`. Desktop: `brew install --cask jellyclaw-desktop`. Submission to homebrew-core deferred until 1k+ stars (per core rules: notable, stable, ≥75 GH stars, ≥30 forks or ≥30 watchers).

15. **First release.**
    ```bash
    pnpm changeset                                 # describe v0.1.0
    pnpm changeset version                         # bumps package.json + CHANGELOG
    git commit -am "chore(release): v0.1.0"
    git tag v0.1.0
    git push origin main --tags
    # CI runs, publishes to npm, updates brew, creates GH release
    ```

16. **Verification on a clean VM/Mac:**
    ```bash
    # Clean Mac (or fresh Orbstack Ubuntu VM):
    brew tap gtrush03/jellyclaw
    brew install jellyclaw
    jellyclaw --version        # → 0.1.0
    jellyclaw run "hello"      # smoke test

    # Or npm path:
    npm install -g jellyclaw
    jellyclaw --version
    ```

### Common pitfalls

- **`git filter-repo` is destructive.** Never run on a shared branch without coordinating. Mirror first.
- **npm provenance requires `id-token: write` permission and OIDC.** The `publishConfig.provenance: true` alone is not enough — the workflow must request the token.
- **`npm whoami` doesn't validate 2FA.** Verify publish-only 2FA is enabled in npm account settings; otherwise provenance signatures can be forged if the token leaks.
- **Homebrew rejects formulae with non-stable version URLs.** Always pin to a specific tag, never `main`.
- **`bin.install_symlink Dir["#{libexec}/bin/*"]`** requires `std_npm_args` to have installed into `libexec/`. If your npm package installs binaries elsewhere, adjust accordingly.
- **GitHub "Make public" preserves all branches.** Delete stale/throwaway branches before flipping visibility.
- **Changesets refuses to publish if the workspace is dirty.** The CI step must run on a clean checkout; don't `echo "..." >> README.md` inside the release job.
- **Desktop .dmg must be notarized before `brew install --cask`** — if Phase 16 didn't notarize, Gatekeeper will block install and the cask will look broken.

### Why this matters

This is the point of no return. Once the repo is public, the git history is public forever. Once `@jellyclaw/engine@0.1.0` is on npm, the name is claimed and the version is unretractable (npm unpublish only works for 72h). The CI release pipeline is what makes Phase 19's weekly rebase viable — without it, every security patch is a manual click-fest. Doing this sloppily now means a year of manual releases and secret-leak CVEs.

---

## Session closeout

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`, substituting `<NN>` with `18` and `<sub-prompt>` with `02-github-release-and-distribution`.

Second of three Phase 18 sub-prompts — do **not** mark Phase 18 ✅ yet. Mark sub-prompt 02 complete in the Phase 18 detail block's Notes.
