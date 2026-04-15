# Phase 18 — Open-source release — Prompt 03: Community, launch blog, HN, Product Hunt, outreach

**When to run:** After Prompts 01 + 02 are both complete — `jellyclaw.dev` live, `npm install -g jellyclaw` works on a clean machine, `brew install gtrush03/jellyclaw/jellyclaw` works on a clean Mac, `v0.1.0` tagged on GitHub with desktop binaries attached. This is the final Phase 18 prompt — completing it marks Phase 18 ✅.
**Estimated duration:** 5–7 hours for prep + 8-hour launch day monitoring window
**New session?** Yes — fresh session; launch day itself should have a clean context
**Model:** Claude Opus 4.6 (1M context)

---

## Session startup

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md`, substituting `<NN>` with `18` and `<name>` with `open-source-release`.

---

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-18-open-source-release.md` Steps 9–10 (launch + monitor).
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/MASTER-PLAN.md` §1 ("Why this exists") — the launch narrative must reflect this exactly: Claurst solo-maintainer risk, OpenCode UX gap, jellyclaw as thin wrapper.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/ROADMAP.md` Q2 2026 success criteria so the announcement does not over-promise.
4. Skim recent Show HNs in the AI tooling space (OpenCode, Goose, Cline, Aider, Continue) to calibrate expectations and tone.
5. WebFetch:
   - `https://news.ycombinator.com/showhn.html` — Show HN rules: must be something people can try, title starts `Show HN:`, URL is the thing itself
   - `https://www.producthunt.com/launch` — launch guide, maker's comment, hunter vs self-launch
   - `https://discord.com/developers/docs/resources/guild` — server creation, widget embed, webhook channel for GH notifications
   - `https://dev.to/p/editor_guide` — canonical cross-post support
   - `https://shields.io/` — badges for README
6. Resolve library IDs for `vercel/og` (if adding press-kit OG) and query docs.

## Implementation task

Stand up the Discord, write the launch blog post, draft the HN Show, the X thread, the Product Hunt listing, prep the outreach DM list, then execute launch day with a 48-hour monitoring window.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/src/content/blog/introducing-jellyclaw.mdx` — the launch post
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/src/pages/press.astro` — press kit page (populated here)
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/public/press/` — logo variants (SVG + PNG @1x/@2x), screenshots, hero quotes, bios
- `/Users/gtrush/Downloads/jellyclaw-engine/docs-site/public/demo.mp4` — 30s demo (same as landing; verify ≤8 MB, H.264, silent or subtle SFX only)
- `/Users/gtrush/Downloads/jellyclaw-engine/launch/hn-show.md` — HN submission text + pinned first comment
- `/Users/gtrush/Downloads/jellyclaw-engine/launch/x-thread.md` — 8-tweet thread draft
- `/Users/gtrush/Downloads/jellyclaw-engine/launch/ph-listing.md` — Product Hunt listing copy + assets checklist
- `/Users/gtrush/Downloads/jellyclaw-engine/launch/outreach-dms.md` — per-person DM drafts (never send the same copy twice)
- `/Users/gtrush/Downloads/jellyclaw-engine/launch/canned-responses.md` — stock replies for common issue types during the 48h window
- `/Users/gtrush/Downloads/jellyclaw-engine/launch/postmortem-template.md` — to be filled +7d after launch

### Discord server setup

1. Create server `jellyclaw` at `https://discord.com/channels/@me` → `Add a Server` → `Create My Own`.
2. Channels:
   - `#welcome` (read-only, rules + install link)
   - `#announcements` (read-only, webhook from GitHub releases)
   - `#help` (primary support)
   - `#skills` (community skill sharing)
   - `#mcp-servers` (community MCP sharing)
   - `#contributors` (PR discussion)
   - `#showcase` (what-I-built)
   - `#feedback` (feature ideas)
   - `#off-topic`
3. Roles: `Contributor` (granted after 1 merged PR), `Beta Tester` (self-assign), `Maintainer` (CODEOWNERS on GH), `Bot`.
4. Bots: Carl-bot (moderation + auto-role), GitHub webhook → `#contributors` + `#announcements` (new issue, new PR, new release), Statbot (weekly activity).
5. Enable **Community** in Server Settings (unlocks discovery, rules channel, welcome screen).
6. Generate a **vanity invite** `discord.gg/jellyclaw` (requires Boost Level 3, or just use a permanent non-vanity invite initially). Put the link on the landing page and README.
7. Paste CoC v2.1 into `#welcome` and pin.

### Launch blog post — `introducing-jellyclaw.mdx`

1500 words, conversational, **no marketing adjectives**. Frontmatter:
```yaml
---
title: 'Introducing Jellyclaw'
description: 'Open-source Claude Code — a thin, patched wrapper on OpenCode that matches Claude Code UX and that you, not Anthropic, own.'
pubDate: 2026-05-05   # Tuesday — see timing note below
tags: [launch, jellyclaw]
heroImage: /press/hero.png
---
```

Structure:

1. **The problem (150 words).** I was running Genie — my own dispatcher — on top of Anthropic's `claude -p`. Every prompt was a subshell into a binary I didn't control. When Anthropic changed the event format in a patch release, my pipelines broke for six hours. When I wanted to add a custom tool, the options were "hope Anthropic adds it" or "fork the binary and maintain the fork."
2. **The alternative paths I considered (150 words).** OpenCode (mature, different UX), Claurst (clean-room Rust reimplementation, one maintainer, me), Goose (Block's thing, good but not drop-in), Cline (VSCode-only). None were "same UX, I own it, community behind it."
3. **What jellyclaw is (200 words).** Thin wrapper on OpenCode ≥1.4.4. Patched in four places: subagent hook fire (closes the #5894 bypass), localhost-only bind, secret scrubbing on tool results, bearer auth on HTTP. Event translation layer so stream-json output is byte-identical to Claude Code's. Same tool surface (14 tools), same skill semantics, same subagent contract.
4. **Architecture (300 words, with a simple diagram).** Genie dispatches → jellyclaw CLI → OpenCode core → provider (Anthropic direct, OpenRouter fallback, local). Plugin hooks fire everywhere including subagents. MCP client included. Desktop shell is a Tauri 2 app that speaks to the engine over the HTTP server (mode B, bearer-authed, localhost-only).
5. **Key differentiators (200 words).** vs OpenCode: Claude Code UX compatibility, hook bypass closed, hardened for embedding. vs Goose: MCP-native from day 1. vs Cline: works anywhere, not just a VS Code extension.
6. **How to install (100 words).** Three blocks: brew, npm, download.
7. **What's next (150 words).** Q3: voice triggers + jelly-claw video integration. Q4: third-party skills registry + plugin marketplace.
8. **Credits (150 words).** Dax Raad and Adam Doty for OpenCode. Mario Zechner for pi-mono's architecture that inspired the event loop. Kuber Mehta for Claurst — the original clean-room effort. Nous Research for Hermes. Anthropic for Claude Code itself.
9. **CTA (50 words).** Star, Discord, try it, tell me what breaks.

Cross-post: dev.to (canonical link back to jellyclaw.dev), Hashnode, Medium.

### X launch thread — `launch/x-thread.md`

8 tweets, pin to profile. Example first tweet:
> I open-sourced jellyclaw — a Claude Code alternative you actually own.
>
> Same CLI, same events, same tool surface. Built on OpenCode with four security patches and a Claude-Code-compatible event translation layer.
>
> `brew install gtrush03/jellyclaw/jellyclaw`
>
> 🧵

Tweets 2–3: the problem (Anthropic owns the CLI; when it changes, your pipelines break). Tweet 4: architecture (1-image diagram). Tweet 5: demo (embed `demo.mp4`). Tweet 6: the four security patches one-liner each. Tweet 7: credits tag `@daxraad`, `@adamdotdev` (OpenCode), `@badlogicgames` (Mario), Claurst author. Tweet 8: CTA — GitHub, Discord, docs URLs.

Tag accounts (do not spray): `@simonw`, `@badlogicgames`, `@dhh` (he appreciates Rails-philosophy-in-Ruby parallels), `@karpathy`. Follow each a day before; mentions from strangers with 0 following are auto-muted.

### Hacker News Show — `launch/hn-show.md`

- **Title:** `Show HN: Jellyclaw – Open-source Claude Code replacement with MCP and subagents`
- **URL:** `https://github.com/gtrush03/jellyclaw-engine` (HN prefers the repo over a marketing site for Show HN)
- **First comment (submitter-pinned, post immediately after submitting):**
  > Hi HN — George here. Jellyclaw is a thin wrapper on OpenCode that matches Claude Code's event format and tool surface so I can run my dispatcher (Genie) without shelling out to Anthropic's proprietary binary.
  >
  > What I'd love feedback on: (1) the event-translation layer in engine/src/events — is the discriminated-union shape the right call, or should I follow OpenCode's stream shape directly? (2) the four security patches, especially patches/001-subagent-hook-fire.patch — I'd like to upstream this but want a sanity check. (3) whether the hardening model in engine/SECURITY.md §2 is paranoid-enough for embedding in a desktop app.
  >
  > Happy to answer anything. Not looking for "why not Langchain" comments — I've been through it.

- **Timing:** **Tuesday, 09:00 America/New_York.** This is the historically highest front-page yield for Show HN (high East Coast workday + early PT). Avoid Monday (backlog flood), Friday (dead-zone).
- **Engagement:** Stay on for 4–6 hours. Reply to every top-level comment within 30 minutes during the first 2 hours; every reply bumps freshness score. Never delete or flag your own comments. If a critique is right, concede.

### Product Hunt listing — `launch/ph-listing.md`

- **Tagline (60 chars max):** `Open-source Claude Code. Yours to own.`
- **Description:** lift the first 2 paragraphs of the blog post
- **Topics:** Developer Tools, Open Source, Artificial Intelligence, GitHub
- **Media:** 5 images — (1) hero GIF, (2) CLI screenshot with a wish completing, (3) desktop app screenshot, (4) architecture diagram, (5) skills example. Plus the 30s demo video.
- **Maker's comment:** post at T+0 — same content as the HN first comment but warmer.
- **Timing:** **Tuesday OR Wednesday launch.** Never Monday (too much competition from weekend submissions), never Friday–Sunday (low traffic). Launch 00:01 PT to get a full 24h.
- **24h pre-launch:** email Discord + Twitter + any mailing list. Ask for *notifications*, not upvotes (upvote-asking violates PH TOS and tanks ranking).
- **Goal:** top 10 of the day. Top 3 is a stretch goal.

### Practitioner outreach — `launch/outreach-dms.md`

Send DMs or emails 5–7 days before launch asking for an **embargo quote** or "take a look if you've got 15 minutes" note. Never ask for an upvote or retweet — that's tacky and backfires. Never send the same copy to two people.

- **Simon Willison** (`@simonw`, DMs open) — largest indie AI audience, writes daily. Angle: "I read your post on Claude Code event parsing; the translation layer in jellyclaw tries to solve what you described." Offer to put him in the credits.
- **Mario Zechner** (`@badlogicgames`) — author of pi-mono. Angle: "Crediting pi-mono's event loop architecture; would you be okay with the attribution in NOTICE?" Genuine, he'll appreciate the lineage respect.
- **Dax Raad** (`@daxraad`) + **Adam Doty** (`@adamdotdev`) — OpenCode team. Angle: "We upstream the subagent hook fix (see patches/001). Want to open the PR against OpenCode main before our launch so it lands as a joint announcement?" This is the highest-leverage outreach — upstream endorsement legitimizes the fork framing.
- **Block / Goose team** — competitive but respectful. Angle: "Different product (we embed, you stand-alone) but same provider strategy; quick read for pattern sharing?"
- **Kuber Mehta** (Claurst author) — the original clean-room effort. Angle: explicit credit in the blog post + `NOTICE`. Offer co-maintainership on jellyclaw's Rust-bindings track if we build one.
- **Alex Albert** (Anthropic DevRel) — see if Anthropic will amplify. Low probability but costless. Angle: "We're Claude Code API-compatible and route through your direct API so your caching works; would you mind a heads-up signal boost?"

### Press kit — `press.astro` + `public/press/`

Logo variants (SVG, PNG @1x/@2x, dark-bg + light-bg versions), 5 product screenshots, two pre-approved quotes from the maker, short + long bio, contact (`press@gtru.xyz`), embed code for the demo video.

### Analytics setup + launch-day dashboard

- Plausible already installed (prompt 01). Create a shared dashboard link (`https://plausible.io/share/jellyclaw.dev`).
- Screenshot "+24h after launch" Plausible dashboard, GitHub insights (stars/clones/referrers), npm (`npm-stat.com`), Discord (member count), PH (rank). Store in `launch/metrics-t+24h.png` for the retrospective.

### Launch-day runbook (the actual Tuesday)

- **T-24h:** Announce to Discord + X followers "launching tomorrow 9am ET." No link — just anticipation.
- **T-1h (08:00 ET):** coffee, close Slack, silence all notifications except Discord `#help` and GitHub issues.
- **T=0 (09:00 ET):** submit HN → post first comment → launch PH → post X thread → publish blog → Discord `#announcements`. All within 10 minutes.
- **T+10m–T+6h:** respond to every comment, issue, DM. Canned responses from `launch/canned-responses.md` for repetitive stuff (install failure, node version, provider config), custom for anything thoughtful.
- **T+24h:** screenshot metrics. Sleep.
- **T+48h:** review; ship a patch release fixing the top 3 feedback items.
- **T+7d:** write `launch/postmortem.md` — what went right, what broke, star count, Discord growth, npm downloads, worth redoing?

### Verification

- Discord server live, `#help` staffed, GitHub webhook firing into `#announcements`
- Blog post live at `https://jellyclaw.dev/blog/introducing-jellyclaw`
- Press kit at `https://jellyclaw.dev/press`
- HN submission on front page (aim: top 30 during Tuesday workday)
- PH top 10 of the day
- GitHub: ≥500 stars, ≥20 forks in the first 24h
- Discord: ≥100 members joined via the launch
- npm: first-day downloads tracked via `npm-stat.com`

### Common pitfalls

- **HN flag risk.** "Show HN:" titles that look like marketing get flagged in minutes. Keep the title factual, put the URL on the repo, first comment is factual not salesy.
- **PH launch depends on the hunter.** Self-launching is fine — a hunter is overrated — but make sure the maker's profile has non-launch activity first (avoid the "brand new account → launch" red flag).
- **Demo video with voiceover = disaster at 2am for insomniac hackers.** Silent demo with on-screen captions only.
- **Simultaneous X thread + HN post gets mass-downvoted** on HN as "promoted." Delay the X thread by 30 minutes; by then HN's anti-brigading has settled the rank.
- **Issue flood.** Pre-pin a "How to report a bug so I can actually fix it" issue; link it from the Welcome channel.
- **Private advisories accidentally made public.** In the 48h window, triple-check that any security report gets moved into a GHSA Draft, not an open issue.

### Why this matters

Launch day is the only free marketing this project ever gets. A botched launch — slow docs, wrong install command, missing context — makes the second launch 10× harder because "oh, that project" sets the narrative. A good launch gives the project a 6-month runway of ambient visibility: people see jellyclaw in their feed, remember it, try it when the use case appears. The 48h window after launch is also the single best recruiting window for contributors — every drive-by PR in those two days is pure signal.

---

## Session closeout

Paste the contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`, substituting `<NN>` with `18` and `<sub-prompt>` with `03-community-and-announcement`.

This is the **final** Phase 18 sub-prompt. If launch succeeded (HN submitted, blog live, Discord up, all three install paths verified), mark Phase 18 ✅ in the checklist and detail block. Update the progress bar counter. Update "Current phase" to Phase 19. Then suggest: *"✅ Phase 18 complete. Phase 19 is ongoing — schedule `prompts/phase-19/01-weekly-upstream-rebase.md` as a cron job starting the first Monday after launch."*
