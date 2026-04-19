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

## Manual verification after first deploy

1. `fly logs --app jellyclaw-staging` — confirm the container came up and `/v1/health` is answering.
2. `curl https://jellyclaw-staging.fly.dev/v1/health | jq .` — 200, `ok:true`.
3. `fly status --app jellyclaw-staging` — `min_machines_running` matches `fly.toml`, all Machines `passing`.
4. Trigger a manual prod deploy: `gh workflow run fly-deploy.yml` OR push a trivial commit to `main`.
