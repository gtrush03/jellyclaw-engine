# Phase 19 — Post-launch stabilization — Prompt 02: Issue triage protocol

**When to run:** **Every Friday, 15:00 America/New_York.** Phase 19 §Cadences lists Mon/Thu; we shift to Friday here to spread load across the week (Monday is the rebase; Thursday is just too close to the rebase to get fresh signal). Any P0-labeled issue bypasses the cadence and gets a same-day response regardless of the day. During launch week (first 7 days post-Phase 18), run daily.
**Estimated duration per run:** 1–2 hours; longer in launch week or after a popular post surge.
**New session?** Yes — fresh session each Friday.
**Model:** Claude Opus 4.6 (1M context)

> ⚠ **ONGOING PROMPT.** Do NOT mark Phase 19 ✅ complete. Update the phase-19 detail block's "Last triage run" + "Next triage run" fields each time.

---

## Session startup

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `19` and `<name>` with `post-launch-stabilization`.

**Add to the startup block:** *"This is an ONGOING cron-scheduled prompt. Do NOT mark Phase 19 ✅ complete. Update the phase-19 detail block's 'Last triage run' field with today's date and 'Next triage run' with next Friday."*

---

## Research task (fresh each run)

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-19-post-launch.md` — §Issue-triage runbook, §Feature request gate, §Acceptance criteria (recurring).
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/docs/triage-log.md` — last 4 weeks. Note trending categories (every-week bugs → probably a regression to root-cause in a dedicated session).
3. Check Discord `#help` and `#feedback` backlog — some issues arrive there first and should be mirrored into GitHub Issues if they're reproducible bugs.

## Implementation task

Triage every open issue, assign labels + priority, respond within SLA, redirect misfiled features to skill/agent/MCP, close stale, and log metrics.

### Step-by-step

1. **Enumerate untriaged.**
   ```bash
   gh issue list --repo gtrush03/jellyclaw-engine \
     --state open --label "needs-triage" --limit 100 --json number,title,author,createdAt
   gh issue list --repo gtrush03/jellyclaw-engine \
     --state open --search "no:label" --limit 100 --json number,title,author,createdAt
   ```
   Any issue without a label is implicitly `needs-triage`. `needs-triage` label exists; new-issue templates (Phase 18 Prompt 02) apply it automatically — untemplated issues do not get it, which is why the second command exists.

2. **Per-issue classification.** For each issue:
   - Read the body fully. Not skim. Every field.
   - Check for duplicate: `gh issue list --search "in:title,body <keywords>"`. If dupe, close with `gh issue close <n> --reason "not planned" --comment "Dup of #M, consolidating discussion there. Thanks!"` and label `duplicate`.
   - **Type label** (exactly one): `bug`, `feature`, `docs`, `security`, `question`, `duplicate`, `invalid`.
   - **Priority label** (exactly one):
     - `P0-security` — CVE-class or data-loss. 24h acknowledge, 7-day fix.
     - `P1-correctness` — real bug, real user, real break. 72h acknowledge, 30-day fix.
     - `P2-ux` — annoying but not breaking. 1-week acknowledge, no fix commitment.
     - `P3-nice-to-have` — polish or edge case. 2-week acknowledge, backlog.
   - **Area label**: `area/engine`, `area/cli`, `area/desktop`, `area/docs`, `area/mcp`, `area/provider`, `area/skill`, `area/subagent`.
   - **Help-wanted signals**: `good first issue` when well-scoped + <2h effort + unambiguous; `help wanted` for larger issues the maintainer won't get to this quarter.
   - **Remove `needs-triage` once the above are set.**

3. **Respond within SLA.** Acknowledge every new issue:
   - **Bug**: "Thanks — I can / can't reproduce locally. Could you share <specific missing info>?" Link to relevant SPEC section if applicable.
   - **Feature**: run the §Feature request gate questions (who's the user / what's the pain / can a skill/agent/MCP solve it / maintenance cost). Most features fail question 3 — redirect with a **specific pointer**, not vague "write a skill":
     > Thanks for proposing this. It looks like this could live as a skill rather than core — the SKILL.md in `docs/skills/authoring.mdx` walks through the shape. The key piece you'd need is `$ARGUMENTS`-based dispatch; see the `git-commit` built-in skill for a minimal example. If you land a working skill, happy to PR-review it into the community registry.
   - **Security**: **do not comment.** Move to a private GHSA: `gh api repos/gtrush03/jellyclaw-engine/security-advisories -f summary='<title>' -f description='<body>'`, close the public issue with *"Moved to private advisory per SECURITY.md."*
   - **Question**: answer if answerable in <5 lines, otherwise point to Discord `#help` with a one-sentence summary they can paste there.
   - **Docs**: if it's a simple fix and the reporter wants to PR it, label `good first issue` and write "PRs welcome — `docs-site/src/content/docs/<path>`."

4. **Reproduce P0 and P1 bugs.** For every `P1-correctness` and `P0-security`:
   ```bash
   cd /Users/gtrush/Downloads/jellyclaw-engine
   # build the exact reported version
   git checkout v<reported-version>
   bun install && bun run build
   # run the reproduction steps verbatim
   ```
   If reproduced → create a failing test, link the test commit in the issue, then reset back to `main` for the fix. If not reproduced → ask for minimal repro with an explicit template and label `needs-repro`. After 14 days without response, close with a canned "reopen with repro" note.

5. **Stale cleanup.** Issues with no activity for 30 days and no fix-in-flight: label `stale` + canned comment: *"Marking stale due to 30d inactivity — reopen if still relevant; otherwise this closes in 7 days."* Stale-bot (GitHub Action) does the close-after-7d for us; set up `.github/workflows/stale.yml` on first run.

6. **PR triage.** Same flow for open PRs:
   - Confirm the PR has a linked issue (if not, comment asking)
   - Confirm a changeset exists (from PR template)
   - Confirm tests pass
   - If first-time contributor → comment welcoming them + link CONTRIBUTING.md
   - Request specific changes (not "clean this up"), or merge, or close with explanation

7. **Log.** Append to `/Users/gtrush/Downloads/jellyclaw-engine/docs/triage-log.md`:
   ```markdown
   ## <YYYY-MM-DD>

   - **Issues triaged today:** <N>
   - **New issues opened this week:** <N>
   - **Open issues total:** <N>
   - **By priority:** P0 <n> / P1 <n> / P2 <n> / P3 <n>
   - **Redirected to skill/agent/MCP:** <N>
   - **Closed as duplicate:** <N>
   - **Security advisories opened:** <N>
   - **PRs triaged:** <N>
   - **SLA breaches:** <list issue numbers, if any>
   - **Average first-response time this week:** <Xh>
   ```

8. **COMPLETION-LOG.md (update-in-place).**
   - "Last triage run" = today
   - "Next triage run" = next Friday
   - "Triage runs to date" +=1
   - Append session log row: `<date> | <session#> | 19 | issue-triage | triaged <N>, P0 <n>, SLA clean`
   - **Do not** mark the phase ✅.

### SLA enforcement

Post a GitHub Project board (`Triage`) with columns: `Inbox → P0 → P1 → P2 → P3 → Done`. Issues auto-move via GH Actions on label changes. At each triage run, **every issue older than its SLA must be addressed first** — either progress, communicated re-estimate, or downgrade with reason. A quiet SLA breach is a louder project-health signal than any individual bug.

### Label setup (first run only)

```bash
gh label create "needs-triage" --color "fbca04" --description "Awaiting triage"
gh label create "bug" --color "d73a4a"
gh label create "feature" --color "a2eeef"
gh label create "docs" --color "0075ca"
gh label create "security" --color "000000" --description "Handle privately"
gh label create "question" --color "d876e3"
gh label create "duplicate" --color "cfd3d7"
gh label create "invalid" --color "e4e669"
gh label create "P0-security" --color "b60205"
gh label create "P1-correctness" --color "d93f0b"
gh label create "P2-ux" --color "fbca04"
gh label create "P3-nice-to-have" --color "c2e0c6"
gh label create "area/engine" --color "5319e7"
gh label create "area/cli" --color "5319e7"
gh label create "area/desktop" --color "5319e7"
gh label create "area/docs" --color "5319e7"
gh label create "area/mcp" --color "5319e7"
gh label create "area/provider" --color "5319e7"
gh label create "area/skill" --color "5319e7"
gh label create "area/subagent" --color "5319e7"
gh label create "good first issue" --color "7057ff"
gh label create "help wanted" --color "008672"
gh label create "needs-repro" --color "fbca04"
gh label create "blocked-on-upstream" --color "000000"
gh label create "stale" --color "cccccc"
gh label create "automated" --color "ededed"
gh label create "upstream-sync" --color "ededed"
```

### Saved searches (`gh alias set`)

```bash
gh alias set t-inbox 'issue list --label needs-triage --state open'
gh alias set t-p0 'issue list --label P0-security --state open'
gh alias set t-overdue-p1 'issue list --label P1-correctness --state open --search "created:<$(date -v-3d +%Y-%m-%d)"'
gh alias set t-stale 'issue list --label stale --state open'
```

### Discord triage hot-path

During the launch week and after any popular post, Discord `#help` is noisier and faster than GitHub. Lurk in `#help` for 10 minutes at the start of each run; mirror any reproducible bug into GitHub Issues with the reporter's consent (tag them on the mirrored issue). Set Discord notifications for `@Maintainer` mention + DMs only — do not try to live-watch `#help`.

### Community maintainers (as the project grows)

Per the Phase 19 contributor ladder: after someone merges 3+ PRs and demonstrates good triage judgment in the Discord, offer them Collaborator access (triage-only via the `triage` role) + a Maintainer role on Discord. Start with one; resist the temptation to promote anyone who just shows up with a hot take.

### Verification

- `gh issue list --label needs-triage` returns `[]` at end of run
- `docs/triage-log.md` shows today's entry
- COMPLETION-LOG.md "Last triage run" = today, Phase 19 **not** marked ✅
- No `P0-security` is >24h old and unresponded
- No `P1-correctness` is >72h old and unresponded

### Common pitfalls

- **Responding too personally to critique.** Launch-adjacent issues attract snark. Reply factually, move on.
- **Accidentally over-promising a fix timeline.** "I'll look at this next week" becomes a quote that resurfaces in 3 months. Say "logged; labeled P2, no committed fix window."
- **Feature creep via backdoor.** A feature request with "it's just a small change" is the classic trap. The §Feature request gate exists precisely because. Answer the 4 questions in the issue comment — the answer is the decision record.
- **Duplicate detection blindness.** Always search before triaging. A fresh duplicate merged into the original keeps the discussion coherent.
- **Marking the phase complete.** Same risk as 01 — Phase 19 never flips to ✅. The runbook is done; the phase is never done.
- **Ignoring Discord signal.** GitHub issues overrepresent power users; Discord is where new users bounce off and never file anything. If a Discord question recurs 3× in a week, it's a docs bug, not a user bug.

### Quarterly metric review hook

Every 4th triage run, check:
- Is avg first-response <72h for P1? (target SLA)
- Is the open-issue count rising faster than close rate? (→ time to grow triage team)
- What are the top 3 area labels this quarter? (→ signal for next quarter's roadmap theme)
These feed directly into Prompt 03's quarterly review.

### Why this matters

The first 90 days of issues set the culture. If response time drifts to a week, the project becomes "dead-looking" and real users stop filing. Triage also surfaces the real product-market-fit signal — the top 3 complaint categories in the first quarter *are* the roadmap for the second quarter, regardless of what the maintainer planned. Skipping a triage run costs more than skipping a feature week.

---

## Session closeout

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`, substituting `<NN>` with `19`.

**NEVER mark Phase 19 ✅ complete.** Update only:
- "Last triage run" = today
- "Next triage run" = next Friday (or sooner if launch week)
- "Triage runs to date" +=1
- Append triage log row
- Note any new P0 that needs cross-session attention

Tell the user: *"Phase 19 triage run <N> complete: <N> issues triaged, <N> SLA breaches. Next run: Friday <date>."*
