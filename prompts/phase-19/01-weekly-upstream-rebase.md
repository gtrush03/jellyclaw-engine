# Phase 19 — Post-launch stabilization — Prompt 01: Weekly upstream rebase

**When to run:** **Every Monday, 09:00 America/New_York.** This is a recurring cron-scheduled prompt, not a one-shot. Schedule via the Claude Code `schedule` skill or an external cron runner. If a Monday is a holiday, run the next business day. If a CVE drops in OpenCode mid-week, run *immediately* — don't wait for Monday.
**Estimated duration per run:** 1–2 hours on a clean rebase; up to a full day if patches conflict.
**New session?** Yes — fresh session every Monday.
**Model:** Claude Opus 4.6 (1M context)

> ⚠ **ONGOING PROMPT.** Do NOT mark Phase 19 ✅ complete. Phase 19 is explicitly "ongoing" per `phases/PHASE-19-post-launch.md`. After each run, update the phase-19 detail block's "Last run" + "Next run" fields and append a row to the session log. Never flip the phase checkbox.

---

## Session startup

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `19` and `<name>` with `post-launch-stabilization`.

**Add to the startup block:** *"This is an ONGOING cron-scheduled prompt. Do NOT mark Phase 19 ✅ complete. Update the phase-19 detail block's 'Last run' field with today's date, 'Next run' with next Monday, and append to the session log."*

---

## Research task (fresh each run)

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-19-post-launch.md` — specifically the "Weekly — Mondays" cadence and the "Upstream-rebase runbook" (§Runbooks).
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/docs/weekly-rebase-log.md` — the last N entries. Note anything flagged as "deferred" — those should surface this week.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` §3 and §4 — the CVE response posture. If the upstream diff this week touches any file in the CVE-2026-22812 attack surface (`server/`, `auth/`, `cors/`, `http/`), treat it as potentially security-relevant.
4. Read `/Users/gtrush/Downloads/jellyclaw-engine/patches/*.patch` — our four patches. Any file touched upstream that our patches also touch is a probable conflict.

## Implementation task

Pull OpenCode upstream, categorize commits, refresh patches, run the full test suite, decide to ship or pin, and log results.

### Step-by-step

1. **Pull upstream.**
   ```bash
   cd /Users/gtrush/Downloads/jellyclaw-engine/engine/opencode
   git fetch upstream
   git log --oneline --no-merges HEAD..upstream/main > /tmp/upstream-new-commits.txt
   wc -l /tmp/upstream-new-commits.txt
   ```
   If zero commits: short-circuit to Step 8 (log "no upstream changes this week").

2. **Categorize commits.** Read every commit message. Tag each into one of four buckets, ordered by urgency:
   - **Security (S)**: anything matching `security`, `CVE`, `auth`, `cors`, `sandbox`, `fix.*inject`. Urgent — rebase + release within 48h.
   - **Features (F)**: new tools, new providers, new flags. Evaluate for adoption. Most can wait a minor release.
   - **Refactors (R)**: internal reshuffles. High conflict risk with our patches even though they add no user value.
   - **Chore (C)**: docs, deps, CI. Low priority; still merge so `pnpm outdated` stays quiet.
   Write the categorization into `/tmp/upstream-categorized.md` — this becomes the body of the release PR description if we ship.

3. **Check patch-conflict surface.**
   ```bash
   cd /Users/gtrush/Downloads/jellyclaw-engine
   for p in patches/*.patch; do
     echo "=== $p ==="
     grep -E '^(\+\+\+|\-\-\-)' "$p" | awk '{print $2}' | sort -u
   done > /tmp/patch-touched-files.txt

   cd engine/opencode
   git diff --name-only HEAD..upstream/main > /tmp/upstream-touched-files.txt

   comm -12 \
     <(sort -u /tmp/patch-touched-files.txt | sed 's|^a/||;s|^b/||') \
     <(sort -u /tmp/upstream-touched-files.txt)
   ```
   The intersection is your conflict set. Empty intersection → patches apply cleanly; proceed fast. Non-empty → Step 5 will need manual refresh.

4. **Attempt the upgrade.**
   ```bash
   cd /Users/gtrush/Downloads/jellyclaw-engine
   pnpm add opencode-ai@latest @opencode-ai/sdk@latest @opencode-ai/plugin@latest \
            --filter engine
   pnpm install
   pnpm patch-package                     # re-apply patches
   ```
   If `patch-package` errors "patch does not apply" for any of our four patches, move to Step 5. Otherwise jump to Step 6.

5. **Refresh a conflicting patch.**
   ```bash
   cd /Users/gtrush/Downloads/jellyclaw-engine
   pnpm patch opencode-ai@<new-version>      # opens an editable copy
   # manually port the patch's intent to the new upstream structure
   # verify the exploit the patch fixes is still reproduced without the patch and blocked with it
   pnpm patch-commit <path>                  # regenerates patches/<name>.patch
   ```
   Critical: **do not silently drop a patch because it's annoying.** Each of our four patches fixes a real threat documented in `engine/SECURITY.md`. If a refresh takes >2h, stop and file an issue to track — pin to previous OpenCode version, ship security fixes only from backports, and schedule a dedicated "patch refresh" session outside the Monday slot.

6. **Full test suite.**
   ```bash
   bun run lint
   bun run typecheck
   bun run test
   bun run test:integration     # if Phase 11 wired this
   ./scripts/golden-wishes.sh   # 5-prompt byte-parity check against Claude Code
   ```
   Every check must pass. The golden-wishes script is the spec: if stream-json output drifts from Claude Code, we break downstream Genie. Treat any diff as a blocking failure even if tests pass.

7. **Decision.**
   - All green → bump patch version via `pnpm changeset`, write changeset note summarizing the upstream changes (reuse `/tmp/upstream-categorized.md`), commit, push, tag → release workflow publishes.
   - Security bucket is non-empty → ship **today** regardless of other buckets, even if it's a patch-only bump with partial feature adoption.
   - Tests fail, feature-caused → pin back to last-known-good `opencode-ai` version in `engine/package.json`, open a tracking issue titled `[upstream-sync] <date> regression in <module>`, label `blocked-on-upstream`, ship security patches only (cherry-pick), schedule patch-refresh outside this slot.
   - Tests fail, our-patch-caused → the refresh in Step 5 was wrong. Revert the refresh, re-pin previous version, re-open the patch refresh as a dedicated task.

8. **Log.** Append to `/Users/gtrush/Downloads/jellyclaw-engine/docs/weekly-rebase-log.md`:
   ```markdown
   ## <YYYY-MM-DD>

   - **Upstream commits pulled:** <N> (S: <n> / F: <n> / R: <n> / C: <n>)
   - **Patch refresh needed:** <none | list>
   - **Tests:** <X/Y green>
   - **Golden wishes:** <pass | diff>
   - **Decision:** <shipped v<x.y.z> | pinned to v<x.y.z>, tracking #<issue>>
   - **Notes:** <any commentary>
   - **Time spent:** <Xh>
   ```

9. **Update COMPLETION-LOG.md** (Phase 19 block, **update-in-place**):
   - Bump "Last run" field to today
   - Bump "Next run" field to next Monday (or sooner if security backlog)
   - Increment "Runs to date" counter
   - Append row to Phase 19 session log: `<date> | <session#> | 19 | upstream-rebase | <shipped v<x.y.z> | pinned>`
   - **Do not** change the Phase 19 checkbox to ✅.

### Automation — GitHub Actions partial

Set up `.github/workflows/weekly-upstream-sync.yml` (runs automatically Mondays 09:00 ET = 13:00 UTC) that does Steps 1–6 and opens a PR if the tests pass. This prompt is still needed weekly — a human must read the PR, run the golden-wishes locally (it requires a live API key), and decide to merge. The automation narrows the weekly time commitment from 1–2h to 20min on clean weeks.

```yaml
name: Weekly upstream sync
on:
  schedule:
    - cron: '0 13 * * 1'   # Mondays 13:00 UTC = 09:00 ET
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm add opencode-ai@latest @opencode-ai/sdk@latest @opencode-ai/plugin@latest --filter engine
      - run: pnpm patch-package
      - run: bun run test
      - name: Open PR
        uses: peter-evans/create-pull-request@v7
        with:
          branch: chore/weekly-upstream-sync
          title: 'chore(deps): weekly upstream sync'
          commit-message: 'chore(deps): weekly upstream sync'
          labels: automated,upstream-sync
```

### Security priority — CVE runbook shortcut

If upstream's changelog or GitHub Security Advisories mention anything security-related, skip the normal Monday cadence:
- **T+0 (discovery):** run Steps 1–6 immediately. Do not batch with feature commits.
- **T+24h:** cherry-pick the fix onto our last-released tag if full sync is blocked.
- **T+48h:** publish the patch release. Advisory goes to `security.jellyclaw.dev/advisories/<id>`.
- Credit the upstream reporter and OpenCode team in the release notes.

Dependabot is configured (Phase 18 Prompt 02) to fail CI on known-vulnerable deps; treat a Dependabot failure in `opencode-ai` or `@opencode-ai/*` as an implicit CVE signal.

### Verification

- `cat docs/weekly-rebase-log.md | tail -20` shows today's entry
- `COMPLETION-LOG.md` Phase 19 block shows today as "Last run"; Phase 19 is **not** marked ✅
- If shipped: `npm view @jellyclaw/engine version` reflects the new version within 15min of merge
- If pinned: the tracking issue is labeled `blocked-on-upstream` and pinned in the repo

### Common pitfalls

- **Silent patch drops.** `pnpm patch-package` happily installs nothing if a patch becomes a no-op against new upstream. Always diff the running code against the patch's intent — do not trust exit code 0.
- **Golden-wishes flake.** If one wish diffs by a trailing newline, fix the diff tool, not the wish. Do not silently update the golden to match current output — that kills the entire point of byte-parity.
- **Forgetting to bump.** Changesets won't publish without a changeset file; merging without one silently wastes a run. The workflow should fail if no changeset exists but there is a dependency bump.
- **Marking the phase complete.** The single biggest failure mode of a "recurring" prompt is the model flipping the ✅ box because it completed the task. **Phase 19 is ongoing; the run is complete, the phase is never complete.** The startup template's extra line exists precisely because of this footgun.
- **Monday holidays.** Christmas, New Year's Day, July 4 (US observance). Run the next business day and note the offset in the log.
- **Running two runs in one day** after a missed Monday — don't. Roll forward; pick up next Monday. The log shows the gap honestly.

### Why this matters

OpenCode ships. Fast. Our value prop is "OpenCode plus Claude Code UX plus our four security patches" — that only holds if we rebase. Skipping two weeks means the next rebase is a 2× bigger diff with 2× the conflict probability, and bugs compound. Meanwhile CVEs do not wait. A weekly cadence is the cheapest way to keep the patch set alive and the project trustworthy. This is the single most important Phase 19 habit — skipping it slowly kills the project's claim to be "hardened OpenCode."

---

## Session closeout

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`, substituting `<NN>` with `19`.

**NEVER mark Phase 19 ✅ complete.** Only update:
- "Last run" = today
- "Next run" = next Monday
- "Runs to date" +=1
- Append the session log row
- Note any spinoff issues (e.g. tracking issue numbers) in Phase 19 Notes

Tell the user: *"Phase 19 weekly rebase run <N> complete. Shipped v<x.y.z> / pinned to v<x.y.z>. Next run: Monday <date>."*
