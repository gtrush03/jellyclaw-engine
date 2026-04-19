# Phase 08 Hosting — Prompt T6-03: GitHub Actions Fly.io deploy pipeline

**When to run:** After T6-01 (Dockerfile + fly.toml present and building green). T5 prompts must have landed first so the engine itself is deploy-ready. This tier only wires CI — no engine source changes.
**Estimated duration:** 1 hour
**New session?** Yes.
**Model:** Claude Opus 4.6 (1M context).

## Context

Agent 1 authored a working GitHub Actions workflow inside `docs/hosting/01-fly-deployment.md` § CI/CD. Your job is to copy it into `.github/workflows/fly-deploy.yml` verbatim, add a staging variant (`.github/workflows/fly-staging.yml`) on the `staging` branch with the same gates, document the required secrets, and provide one-shot setup instructions for George.

**Do not change Agent 1's deploy strategy.** Rolling is the choice for Alpha. Blue/green is explicitly deferred.

## Research task

1. Read `docs/hosting/01-fly-deployment.md` § CI/CD end-to-end. The yaml block under `.github/workflows/fly-deploy.yml` is your source of truth. Note that Agent 1's version deploys to staging FIRST on pushes to main, smoke-checks `/v1/health`, then promotes to prod. Preserve that two-stage pattern in the prod workflow.
2. `ls /Users/gtrush/Downloads/jellyclaw-engine/.github/` — check current state. Agent 1 noted this directory may be untracked. If `.github/workflows/` already has content, read it and integrate rather than overwrite.
3. Look at `engine/package.json` scripts — confirm `typecheck`, `test`, and `build` are all present and invokable. The workflow runs these as gates.
4. Grep the repo for existing references to `FLY_API_TOKEN` or `flyctl` to find any stale CI config you need to supersede. If you find any, record their paths in the closeout.
5. Check whether the repo uses `npm`, `bun`, or both for CI. `CLAUDE.md` says `bun run build / test / lint`, but Agent 1's snippet uses `npm ci && npm run build && npm test`. Pick **bun** — the repo's primary toolchain per `CLAUDE.md` — and adapt Agent 1's yaml accordingly. `bun install --frozen-lockfile && bun run build && bun run typecheck && bun run test` is the production gate.
6. Read `engine/package-lock.json` vs `engine/bun.lockb` existence — only whichever lockfile is checked in should be used for CI caching.
7. WebFetch the current `superfly/flyctl-actions/setup-flyctl` README (`https://github.com/superfly/flyctl-actions`) to confirm the action reference (`@master` vs `@v1`) is still current. If `@master` is deprecated in favor of a pinned tag, use the pinned tag.

## Implementation task

### Files to create / modify

- **Create** `.github/workflows/fly-deploy.yml` — production deploy on push to `main`. Adapt Agent 1's snippet:
  - Trigger: `push` to `main` + `workflow_dispatch`.
  - Concurrency group `fly-deploy-prod-${{ github.ref }}`, `cancel-in-progress: false`.
  - Steps: checkout → setup bun (`oven-sh/setup-bun@v2`) → `bun install --frozen-lockfile` → `bun run typecheck` → `bun run test` → `bun run build` → `superfly/flyctl-actions/setup-flyctl@<pinned-tag>` → `flyctl deploy --app jellyclaw-staging --remote-only --strategy rolling --wait-timeout 300` → smoke curl `https://jellyclaw-staging.fly.dev/v1/health` with retry → `flyctl deploy --app jellyclaw-prod --remote-only --strategy rolling --wait-timeout 300`.
  - Env: `FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}` on both deploy steps.
  - Timeout: `timeout-minutes: 15` per Agent 1.

- **Create** `.github/workflows/fly-staging.yml` — staging-only deploy on push to `staging` branch:
  - Trigger: `push` to `staging` + `workflow_dispatch`.
  - Concurrency group `fly-deploy-staging-${{ github.ref }}`, `cancel-in-progress: true` (staging can cancel older deploys).
  - Same install + build + test gates.
  - Only one deploy step: `flyctl deploy --app jellyclaw-staging --remote-only --strategy rolling --wait-timeout 300`.
  - Follow-up smoke: curl `https://jellyclaw-staging.fly.dev/v1/health`.
  - Env: `FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}`.

- **Create** `docs/deploy-secrets.md` — documents every required secret, where it's set, and the one-time bootstrap commands. Contents:
  ```markdown
  # Deploy secrets — jellyclaw hosted

  Two layers of secrets: GitHub Actions (CI auth into Fly) and Fly (runtime env).

  ## GitHub Actions secrets (set via `gh secret set`)

  | Name             | Purpose                              | How to obtain                           |
  | ---------------- | ------------------------------------ | --------------------------------------- |
  | `FLY_API_TOKEN`  | flyctl auth for deploy workflows     | `fly auth token` (one-time per operator) |

  One-time bootstrap (run from the repo root, after `gh auth login`):

  ```bash
  export FLY_API_TOKEN=$(fly auth token)
  gh secret set FLY_API_TOKEN --body "$FLY_API_TOKEN"
  ```

  ## Fly runtime secrets (set via `fly secrets set`)

  Required for `jellyclaw-prod` AND `jellyclaw-staging` (use separate keys per env):

  | Name                     | Purpose                                    | T6-02 notes                |
  | ------------------------ | ------------------------------------------ | -------------------------- |
  | `ANTHROPIC_API_KEY`      | Managed Anthropic key for the Alpha tier   | Different key per env      |
  | `JELLYCLAW_TOKEN`        | Bearer token that API clients must present | `openssl rand -hex 32`     |
  | `BROWSERBASE_API_KEY`    | Browserbase hosted MCP auth (optional)     | See `docs/browserbase-setup.md` |
  | `BROWSERBASE_PROJECT_ID` | Browserbase project scope                  | Same                       |
  | `OPENROUTER_API_KEY`     | OpenRouter provider (optional, non-default)| Only if tenant opts in     |

  One-time bootstrap (prod):

  ```bash
  fly secrets set \
    ANTHROPIC_API_KEY=sk-ant-… \
    JELLYCLAW_TOKEN=$(openssl rand -hex 32) \
    --app jellyclaw-prod

  # Optional
  fly secrets set \
    BROWSERBASE_API_KEY=bb_live_… \
    BROWSERBASE_PROJECT_ID=proj_… \
    --app jellyclaw-prod
  ```

  Repeat with `--app jellyclaw-staging` using a cheaper Sonnet-only key for staging.

  ## Rotation

  - `JELLYCLAW_TOKEN`: `fly secrets set JELLYCLAW_TOKEN=$(openssl rand -hex 32)`. Fly restarts the Machine; ~30s brownout on rolling strategy.
  - `FLY_API_TOKEN`: `fly auth token` → `gh secret set FLY_API_TOKEN --body "$NEW_TOKEN"`. No restart needed.
  - `ANTHROPIC_API_KEY` / `BROWSERBASE_*`: same `fly secrets set` pattern. Coordinate with any tenants who may be mid-session.
  ```

### Files NOT to touch

- `Dockerfile`, `fly.toml` — owned by T6-01.
- Any engine source.
- Any existing `.github/` files unless they duplicate what we're adding (if so, note and supersede).

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

# Ensure parent dir exists (GH Actions wants exactly .github/workflows/)
mkdir -p .github/workflows
ls -la .github/workflows/

# Syntactic validation with actionlint (install if missing)
if ! command -v actionlint >/dev/null 2>&1; then
  echo "[info] actionlint not installed — attempting Homebrew install"
  brew install actionlint || {
    echo "[warn] actionlint install failed; falling back to gh workflow view"
  }
fi

if command -v actionlint >/dev/null 2>&1; then
  actionlint .github/workflows/fly-deploy.yml
  actionlint .github/workflows/fly-staging.yml
else
  # Fallback: yamllint or raw YAML parse
  python3 -c "import yaml; yaml.safe_load(open('.github/workflows/fly-deploy.yml'))" && echo "fly-deploy.yml parses"
  python3 -c "import yaml; yaml.safe_load(open('.github/workflows/fly-staging.yml'))" && echo "fly-staging.yml parses"
fi

# gh workflow view (requires gh auth; if unavailable, skip)
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh workflow view fly-deploy.yml --yaml 2>/dev/null || echo "[info] workflow not yet on a pushed branch — view-via-gh will work after first push"
fi
```

### Acceptance criteria

1. `.github/workflows/fly-deploy.yml` exists, triggers on push to `main`, runs `bun` install + typecheck + test + build gates, then deploys to staging THEN prod with a `/v1/health` smoke between them.
2. `.github/workflows/fly-staging.yml` exists, triggers on push to `staging`, same gates, deploys only to `jellyclaw-staging`.
3. Both workflows use `FLY_API_TOKEN` from GitHub secrets (never baked in).
4. Both workflows pass `actionlint` (or the Python YAML parse fallback if actionlint is unavailable on the worker).
5. `docs/deploy-secrets.md` exists and documents all secrets listed above.
6. The workflows reference the same `flyctl` GitHub Action version. Pick a pinned tag, not `@master` (per Agent 1's note with updated advice from your WebFetch).
7. Repo status: `git status` shows only the three new files — no accidental changes to engine source.

### Tests to add

None executable. The deploy pipeline itself is the "test"; it runs on the next push. Instead, document a manual verification checklist in `docs/deploy-secrets.md`:

```markdown
## Manual verification after first deploy

1. `fly logs --app jellyclaw-staging` — confirm the container came up and `/v1/health` is answering.
2. `curl https://jellyclaw-staging.fly.dev/v1/health | jq .` — 200, `ok:true`.
3. `fly status --app jellyclaw-staging` — `min_machines_running` matches `fly.toml`, all Machines `passing`.
4. Trigger a manual prod deploy: `gh workflow run fly-deploy.yml` OR push a trivial commit to `main`.
```

### Common pitfalls

- **Do NOT use `npm ci`**. Agent 1's snippet did, but the repo's actual toolchain per `CLAUDE.md` is Bun. The lockfile is `bun.lockb` (or `bun.lock`), and `bun install --frozen-lockfile` is the equivalent of `npm ci`. Swapping toolchains in CI vs local is a classic CI-only failure source.
- **Do NOT set `cancel-in-progress: true` on the prod workflow.** Agent 1 explicitly set `cancel-in-progress: false` for prod — a half-finished prod deploy must complete (or fail) on its own terms, not get interrupted by a newer push. Staging can cancel (cheap to redo).
- **Do NOT deploy to prod without staging smoke.** The prod workflow has a mandatory ordering: staging deploy → staging health check → prod deploy. A staging health-check failure MUST abort the prod step.
- **`superfly/flyctl-actions/setup-flyctl@master`** — Agent 1 used `@master`. Check the action's README via WebFetch (see research step 7) and pin to whichever tagged release is current. If `@master` is still the documented reference, keep it and add a `# TODO: pin when tagged release lands` comment.
- **Don't add `FLY_API_TOKEN` to the env of steps that don't need it.** Only the flyctl deploy + smoke steps need it. Leak scope minimization.
- **`jellyclaw-staging.fly.dev` is assumed** — if George chose a different staging app name, update the smoke URL. Don't guess; read `fly.toml` for the canonical staging app name (it's `jellyclaw-staging` per Agent 1's design, but verify).
- **The smoke curl must tolerate transient 502s during rollout.** Use `curl --fail --retry 5 --retry-delay 5` (Agent 1's pattern). Do not add `--retry-all-errors` — that hides 500s that should fail the deploy.
- **GH Actions permissions.** Default `GITHUB_TOKEN` is enough for our workflows (read-only checkout). Do NOT request `contents: write` or similar. If Agent 1's snippet had a `permissions:` block, copy it verbatim; otherwise leave it implicit (reads-only default).

## Verification checklist

- [ ] Both workflow YAMLs parse (actionlint or YAML loader).
- [ ] `bun run typecheck` gates are present in both.
- [ ] Prod workflow deploys staging first, then prod.
- [ ] Staging workflow only touches `jellyclaw-staging`.
- [ ] `FLY_API_TOKEN` referenced as a secret, never inlined.
- [ ] `docs/deploy-secrets.md` exists and lists all required secrets.
- [ ] `git status` shows only three new files + any COMPLETION-LOG update.
- [ ] No engine source changes.

## Closeout

1. Append to `COMPLETION-LOG.md`: `08.T6-03 ✅` with the flyctl action pin used.
2. Emit a reminder for George: `REMINDER: run \`fly auth token | gh secret set FLY_API_TOKEN --body -\` ONCE before first deploy.`
3. Print `DONE: T6-03` on success, `FAIL: T6-03 <reason>` on fatal failure.
