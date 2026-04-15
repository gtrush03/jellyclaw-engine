---
phase: 19
name: "Post-launch stabilization"
duration: "ongoing"
depends_on: [18]
blocks: []
---

# Phase 19 — Post-launch stabilization

## Dream outcome

Jellyclaw stays healthy without George being on-call. A weekly upstream-rebase cadence keeps OpenCode current. Issue triage is fast. Feature requests pass through a clear review gate. Contributors are onboarded smoothly. Quarterly themes guide where effort lands.

## Deliverables

- `docs/maintenance-runbook.md`
- Weekly `rebase-upstream.yml` scheduled workflow
- Issue-triage cadence: Mon/Thu
- Release cadence: patch as needed, minor monthly, major when warranted
- Feature-request template with "why" gate
- Contributor ladder doc
- Quarterly review doc template

## Cadences

### Weekly — Mondays
- Run `pnpm outdated` report
- Run upstream-rebase workflow: pull `opencode-ai@latest`, re-run full test suite, file issue if patch conflicts
- Triage new issues + PRs (<24 h first response)

### Bi-weekly
- Dependency updates (Dependabot PRs; CI must pass)
- Security scan (npm audit, gitleaks)

### Monthly
- Minor release if features ready
- Cost reconciliation vs provider billing
- Burn-in telemetry review

### Quarterly
- Theme-setting: focus area (e.g., Q3: "cost reduction"; Q4: "team workflows")
- Kill-list: remove features with <1% usage
- Roadmap refresh

## Runbooks

### Upstream-rebase runbook
1. `pnpm add opencode-ai@latest @opencode-ai/sdk@latest @opencode-ai/plugin@latest --filter engine`
2. Run full test suite
3. If patch conflicts → open issue, pin back to last known good, start patch-refresh branch
4. Run scenario tier against live API
5. Publish patch release if clean

### Issue-triage runbook
- Label: `bug`, `feature`, `question`, `docs`, `good first issue`
- Prioritize: P0 (data loss/security) → same day; P1 (regression) → 3 d; P2 → backlog
- Close with template response if dupe / out of scope

### Security response runbook
- CVE reported → private advisory
- Patch on `security/<id>` branch
- Coordinated disclosure after fix ships
- Credit reporter in advisory

### Hot-rollback runbook
If jellyclaw introduces a regression that breaks Genie users in the wild:
1. Revert to last-known-good tag
2. Publish `v<current>-hotfix.1` with revert
3. Document in CHANGELOG
4. Root-cause post-mortem within 72 h

## Feature request gate

All features must answer:
1. Who's the user? (persona)
2. What's the pain they feel today?
3. Why can't a skill/agent/MCP server solve it outside the core?
4. Cost to maintain (high/medium/low)?

If 3 can be answered "a skill/agent/MCP can solve it" → redirect the author to write that instead.

## Contributor ladder

- **Drive-by** — one-off PR
- **Regular** — 3+ merged PRs, can self-assign issues
- **Maintainer** — commit access, review rights

## Quarterly review template

```
## Q<N> review
- Stars / downloads
- Open issues trend
- P0/P1 bug count
- Notable shipped features
- Notable killed features
- Theme for next quarter
- Unmet needs observed in issues
```

## Acceptance criteria (recurring)

- [ ] First response on new issues <24 h on weekdays
- [ ] Upstream rebase attempted weekly
- [ ] No P0 older than 72 h open
- [ ] CHANGELOG current
- [ ] Security advisories within 7 d of fix

## Risks + mitigations

- **Burnout / solo bus-factor** → recruit 1+ maintainer post-launch; document runbooks so knowledge isn't in one head.
- **Upstream OpenCode direction diverges** → quarterly review decides fork-vs-stay; kept as an explicit option.
- **Issue flood after a popular post** → issue templates + canned responses + temporarily pin "How to help triage" thread.

## Files touched

- `docs/maintenance-runbook.md`
- `.github/workflows/rebase-upstream.yml`
- `docs/contributor-ladder.md`
- `docs/quarterly-reviews/Q<N>.md`
