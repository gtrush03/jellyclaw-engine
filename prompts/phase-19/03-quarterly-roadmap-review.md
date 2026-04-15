# Phase 19 — Post-launch stabilization — Prompt 03: Quarterly roadmap review

**When to run:** **First week of each quarter — January, April, July, October.** Target the first Monday of that week, block a full afternoon. Trigger early (within 2 weeks) if a major external signal demands re-planning: Anthropic ships Claude Code as an embeddable SDK, OpenCode announces a major direction shift, a jellyclaw CVE hits CVSS ≥8, or an acquisition offer lands.
**Estimated duration per run:** 4–6 hours — focused half-day. Do not multi-task.
**New session?** Yes — fresh session each quarter.
**Model:** Claude Opus 4.6 (1M context)

> ⚠ **ONGOING PROMPT.** Do NOT mark Phase 19 ✅ complete. Update the phase-19 detail block's "Last quarterly review" + "Next quarterly review" fields.

---

## Session startup

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `19` and `<name>` with `post-launch-stabilization`.

**Add to the startup block:** *"This is an ONGOING cron-scheduled prompt. Do NOT mark Phase 19 ✅ complete. Update the phase-19 detail block's 'Last quarterly review' field with today's date and 'Next quarterly review' with the first Monday of next quarter."*

---

## Research task (fresh each quarter)

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-19-post-launch.md` — §Quarterly cadence, §Quarterly review template.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/ROADMAP.md` in full. This is the artifact you are about to edit.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/CHANGELOG.md` — all releases this quarter.
4. Read `/Users/gtrush/Downloads/jellyclaw-engine/docs/weekly-rebase-log.md` — the 13 weekly entries of this quarter.
5. Read `/Users/gtrush/Downloads/jellyclaw-engine/docs/triage-log.md` — the 13 Friday entries of this quarter.
6. Read the prior quarterly review at `/Users/gtrush/Downloads/jellyclaw-engine/docs/quarterly-reviews/Q<N-1>.md` (if exists) — honest retro of the prior quarter's "3 big goals" is the first lens on this quarter.
7. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — any §3 additions this quarter? Any new advisories?
8. Scan the competitive landscape:
   - `gh repo list sst --topic ai` + skim OpenCode release notes
   - `github.com/block/goose/releases` (Goose)
   - `github.com/cline/cline/releases`
   - `github.com/All-Hands-AI/OpenHands/releases`
   - Anthropic blog + changelog for Claude Code SDK movement
9. Grep issue labels for trends — top 3 `area/*` labels this quarter, top 5 reopened issues.

## Implementation task

Retro + forward-plan: close the books on last quarter, pick 3 big goals for next quarter, publish a transparent "State of Jellyclaw" blog, host an AMA.

### Step-by-step

1. **Pull quarterly metrics.** The dashboard queries (save as `scripts/quarterly-metrics.sh`):
   ```bash
   # GitHub stars + forks + contributors
   gh api repos/gtrush03/jellyclaw-engine | jq '{stars:.stargazers_count,forks:.forks_count,watchers:.subscribers_count}'
   gh api repos/gtrush03/jellyclaw-engine/contributors --paginate | jq 'length'

   # npm weekly downloads
   curl -s "https://api.npmjs.org/downloads/range/last-month/@jellyclaw/engine" | jq
   curl -s "https://api.npmjs.org/downloads/range/last-month/jellyclaw" | jq

   # Issue ratio
   gh issue list --state open --limit 1000 --json number | jq 'length'
   gh issue list --state closed --search "closed:>$(date -v-3m +%Y-%m-%d)" --limit 1000 --json number | jq 'length'

   # Discord — via widget API (if public)
   curl -s "https://discord.com/api/guilds/<guild-id>/widget.json" | jq '.presence_count,.members|length'

   # Plausible — last-90d uniques to jellyclaw.dev
   # (fetch via Plausible Stats API with the shared token)

   # Genie cost savings — look up Genie billing before/after jellyclaw adoption
   ```
   Drop output into `docs/quarterly-reviews/Q<N>.md` metrics section.

2. **Retrospect vs last quarter's "3 big goals."** Copy last quarter's goals verbatim. For each, answer:
   - Shipped? Pushed? Killed?
   - If pushed: what blocked it? Is the blocker still real?
   - If killed: what replaced it?
   - If shipped: what's the evidence?
   Be uncomfortably honest. This section is published.

3. **Community feedback synthesis.**
   - Top 10 most-upvoted feature requests: `gh issue list --state open --label feature --sort reactions --limit 10`
   - Top 10 most-discussed issues: `gh issue list --state open --sort comments --limit 10`
   - Top 5 recurring Discord themes (from triage-log.md cross-refs)
   - Top 5 most-visited docs pages (Plausible)
   - Top 3 outbound clicks to competitors (Plausible) — signal that we're missing something they have

4. **Competitive check.**
   - OpenCode shipped this quarter: <list> → which should we adopt vs differentiate from?
   - Goose shipped: <list>
   - Cline shipped: <list>
   - OpenHands shipped: <list>
   - Anthropic Claude Code SDK movement? (existential question for jellyclaw's value prop)
   The product strategy answer here is: double down on what OpenCode doesn't do (embedding, Claude Code byte-parity, MCP polish), not chase.

5. **Security retro.**
   - Any CVEs this quarter? Response time vs the SECURITY §4 24h target?
   - Any close calls? Upstream CVEs that *would* have hit us if we'd adopted the feature earlier?
   - Update `engine/SECURITY.md` if threat model changed — note the change in the quarterly doc.

6. **Kill list.** Features with <1% usage (per telemetry, if enabled, or Discord mentions). Document in CHANGELOG.md under a `Deprecated` heading; remove in the following quarter's minor release. Example: a provider that nobody uses + that upstream OpenCode now handles natively is a prime kill candidate.

7. **Pick 3 big goals for next quarter.** Three — not five, not seven. Goals are commitments; picking more than three dilutes each. Each goal:
   - Has an owner (usually the maintainer; sometimes a Maintainer-role contributor)
   - Has a measurable DoD
   - Has an explicit "not-doing" clause for the temptation twin
   Example template:
   > Q3 Goal 1: **Ship the voice-trigger primitive** (per ROADMAP Q3). DoD: an SDK consumer can register a wake-word and get an async event stream. Owner: George. Not-doing: the jelly-claw integration — that's Q3 Goal 2.

8. **Update `ROADMAP.md`.**
   - Move completed items to CHANGELOG.md under the right version.
   - Move killed items to a `## Retired ideas` section with a one-line obituary (why we killed it — this prevents zombie revival three quarters later).
   - Promote top community-requested features (if they pass the §Feature gate from triage) to next quarter or two.
   - Set the 3 big goals at the top of the next quarter's section.

9. **Publish "State of Jellyclaw Q<N>" blog.** Template at `/Users/gtrush/Downloads/jellyclaw-engine/launch/quarterly-blog-template.md`. Structure:
   - **By the numbers** — the dashboard values (no spin)
   - **What shipped** — major features + releases + security fixes
   - **What slipped** — the honest list, with why
   - **What was killed** — brief
   - **Community highlights** — first-time contributors, notable community skills/MCP servers, a quote or two from Discord (with permission)
   - **Next quarter's 3 goals** — the commitments
   - **Thanks** — specific contributor shoutouts
   Post to `jellyclaw.dev/blog/state-of-jellyclaw-q<N>`, cross-post to dev.to + X.

10. **Run a Discord AMA.** 1-hour voice channel session within the week of publishing the blog. Announce in `#announcements` 48h before. Pin the most-asked questions + answers to the channel description afterward. Record the voice (with consent) and upload the transcript to `docs/amas/q<N>.md`.

11. **Team / scaling review.** Every quarter, check:
    - Discord active members (messages/week, not just join count): if >500, consider hiring a first FT maintainer via GitHub Sponsors / OpenCollective
    - Contributors count: if >20 with 3+ merges each, formalize the Maintainer role with real commit authority
    - Corporate adopters: any? If yes, ask for a "Powered by jellyclaw" logo permission; if no, ask "what blocks you?" and redirect to a feature
    - Burnout check (self): am I shipping out of love or fear? If fear, reduce scope. Solo-maintainer burnout is the #1 risk (§Risks + mitigations in PHASE-19).

12. **Ownership transfer protocol (prep, even if not executed).** Even if not transferring this quarter, keep a `docs/succession.md` up to date:
    - Current maintainer's contact + secrets location
    - What access each secret grants (NPM_TOKEN, HOMEBREW_TAP_TOKEN, VERCEL_DEPLOY_HOOK, Discord owner, domain registrar)
    - Bus-factor: if X were to walk away tomorrow, who has the next-most context?
    - Handoff checklist for when the transfer does happen

13. **Update COMPLETION-LOG.md (update-in-place).**
    - "Last quarterly review" = today
    - "Next quarterly review" = first Monday of next quarter
    - "Quarterly reviews to date" +=1
    - Append session log row: `<date> | <session#> | 19 | q-review | Q<N> shipped — <goal-count>/3, next Q goals: <list>`
    - **Do not** mark the phase ✅.

### Quarterly blog template

Save at `/Users/gtrush/Downloads/jellyclaw-engine/launch/quarterly-blog-template.md`:

```mdx
---
title: 'State of Jellyclaw — Q<N> <year>'
description: 'Quarterly retrospective and Q<N+1> goals.'
pubDate: <YYYY-MM-DD>
tags: [quarterly, roadmap]
---

# State of Jellyclaw — Q<N> <year>

## By the numbers
- GitHub stars: <N> (Δ <+/-N>)
- npm weekly downloads: <N>
- Discord members: <N> (<active_last_week>)
- Contributors: <N>
- Open issues / closed this quarter: <N> / <N>
- Advisories published: <N>
- Genie production cost-savings vs Claude Code: $<N>/mo (since adoption)

## What shipped
...

## What slipped
...

## What we retired
...

## Community highlights
...

## Next quarter's 3 goals
1. ...
2. ...
3. ...

## Thanks
Specific thanks to @<contributor>, @<contributor>, ...
```

### Verification

- `docs/quarterly-reviews/Q<N>.md` exists and is complete
- `ROADMAP.md` updated — current-quarter items moved, next-quarter goals set
- `CHANGELOG.md` shows any killed features under `Deprecated`
- Quarterly blog published, cross-posted
- AMA scheduled + announced in Discord `#announcements`
- COMPLETION-LOG.md "Last quarterly review" = today, Phase 19 **not** marked ✅

### Common pitfalls

- **Spin.** The quarterly blog's credibility is the retro's honesty. "We didn't ship X because we were busy shipping Y" reads as mature; "We shipped X ahead of schedule 🚀" reads as BS when X is obviously incomplete.
- **Too many goals.** Three. Not four. Not "three and a stretch." The maintainer's calendar literally cannot hold more.
- **Adopting everything a competitor ships.** A real strategy says no. OpenCode shipping a new provider doesn't mean we adopt it — we're the Claude-Code-byte-parity + hardened-embedding project, not the feature-superset.
- **Skipping the AMA because it's embarrassing.** Live voice questions are the single best signal about where users actually get stuck. Skipping it means the next quarter's goals are uninformed.
- **Marking the phase complete.** Same risk as 01 + 02. Phase 19 never flips to ✅ — the review is done; the phase is ongoing.
- **Ownership-transfer doc staleness.** The `docs/succession.md` must be updated every quarter; a succession doc that's 18 months stale is worse than no succession doc.
- **Burnout denial.** If the honest answer to "am I shipping out of love or fear" is fear, the Q<N+1> 3-goal list should include "reduce scope of X by 50%" or "recruit one co-maintainer."

### Why this matters

Without a forcing function, the roadmap drifts into "whatever feels urgent this week." Quarterly reviews are how we trade short-term reactivity for medium-term direction. The blog is how we keep the community trust (they see the honest retro and trust the next goal list). The AMA is the cheapest focus-group available. The succession doc is the one thing that makes jellyclaw survivable past its current maintainer — and jellyclaw's entire origin story (MASTER-PLAN §1) is literally about not being single-maintainer-fragile like Claurst was. Skipping this is re-creating the problem jellyclaw was built to solve.

---

## Session closeout

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`, substituting `<NN>` with `19`.

**NEVER mark Phase 19 ✅ complete.** Update only:
- "Last quarterly review" = today
- "Next quarterly review" = first Monday of next quarter
- "Quarterly reviews to date" +=1
- Append quarterly log row with the 3 new goals

Tell the user: *"Phase 19 Q<N> review complete. Goals for Q<N+1>: (1) <goal>, (2) <goal>, (3) <goal>. Next review: <date>."*
