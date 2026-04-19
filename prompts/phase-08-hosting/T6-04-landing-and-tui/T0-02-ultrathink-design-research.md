---
id: T0-02-ultrathink-design-research
tier: 0
title: "4-agent parallel design research → T6-04-DESIGN-BRIEF.md"
scope:
  - T6-04-DESIGN-BRIEF.md
  - tmp/t6-04-design/
depends_on_fix:
  - T0-01-cli-smoke-anthropic
tests:
  - name: brief-exists
    kind: shell
    description: "T6-04-DESIGN-BRIEF.md exists, has all 4 sections"
    command: |
      set -e
      test -f T6-04-DESIGN-BRIEF.md
      grep -q '## 1. Brand palette' T6-04-DESIGN-BRIEF.md
      grep -q '## 2. TUI target mockups' T6-04-DESIGN-BRIEF.md
      grep -q '## 3. Landing page' T6-04-DESIGN-BRIEF.md
      grep -q '## 4. Demo embed strategy' T6-04-DESIGN-BRIEF.md
    expect_exit: 0
    timeout_sec: 10
  - name: brief-word-count
    kind: shell
    description: "brief is substantive (>= 1500 words)"
    command: "wc -w < T6-04-DESIGN-BRIEF.md | awk '{exit ($1 < 1500) ? 1 : 0}'"
    expect_exit: 0
    timeout_sec: 5
human_gate: false
max_turns: 50
max_cost_usd: 15
max_retries: 2
estimated_duration_min: 35
---

# T0-02 — Ultrathink design brief (4 parallel agents)

## Context
T6-04 touches brand, TUI, landing, and demo recording. If we redesign mid-tier
we waste autobuild runs. This prompt runs 4 parallel research subagents, each
owning one slice, and synthesizes the outputs into a single design brief the
remaining tiers consume as source-of-truth.

## Inputs the agents should read
- `engine/src/tui/theme/brand.ts` — current JellyClaw palette (cyan/violet/amber)
- `site/images/` — existing JPG assets
- `engine/SPEC.md` § Goals — one-line pitch source
- `docs/hosting/03-tui-distribution.md` — ttyd + xterm.js design
- `docs/hosting/05-productization.md` — if exists, read for copy cues
- `SOUL.md` + `CLAUDE.md` — voice + tone
- `tmp/t6-04-baseline/SUMMARY.md` — baseline smoke results

## Work — spawn 4 subagents in parallel (single message, multiple tool uses)

### Agent A — brand palette refinement
Use the `Explore` subagent type. Brief:
> Read `engine/src/tui/theme/brand.ts`, `site/images/*.jpg`, `SOUL.md`. Propose
> a **refined palette** that works across three surfaces: Ink TUI (256-color
> safe), web TUI (xterm.js truecolor), HTML landing (CSS variables). Output:
> hex tokens table + rationale + accessibility notes (WCAG AA contrast
> against `abyss`/`foam`). Keep the existing 7 tokens as a stable baseline;
> propose at most 3 additions or adjustments, each with justification. Under
> 500 words.

### Agent B — TUI target mockups
Use the `Explore` subagent type. Brief:
> Read `engine/src/tui/components/*.tsx`, `app.tsx`, `state/`, `hooks/`. For
> each of these components draft an **ASCII mockup** of the target polished
> look (post-T1): splash, boot-animation, jellyfish spinner, transcript,
> tool-call, diff-view, status-bar, input-box. Each mockup is a fenced code
> block with a caption. Highlight 3 specific polish wins per component
> (e.g. "status-bar: show model pill + cost pill + context-used pill, right
> aligned"). Under 800 words.

### Agent C — landing page copy + structure
Use the `general-purpose` subagent type. Brief:
> Read `engine/SPEC.md` § 2 Goals, `SOUL.md`, `README.md`. Draft the full
> landing page copy for `site/index.html`:
> - Hero: h1 wordmark, one-line pitch (< 15 words), CTA button copy
> - Features: 3 cards (Bash / Browser / Web-search) — 2 sentences each
> - "Why jellyclaw": 3 bullets vs Claude Code
> - Try-it CTA footer + BYOK disclaimer
> - meta: `<title>`, `<meta description>` (≤160 chars), og:image spec
> Tone: direct, technical, confident, no marketing fluff. Max 350 words total
> of copy in the output.

### Agent D — demo embed strategy
Use the `general-purpose` subagent type. Brief:
> Research 3 options for embedding a live-ish demo in `site/index.html`:
> (1) asciinema-player JS + a `.cast` file, (2) looping `.webm`/`.mp4`, (3)
> static screenshot carousel. For each: weight (KB), CSP implications,
> accessibility (does it need captions?), how to record the source. Pick a
> winner and justify. Include exact record command (e.g. `asciinema rec`) and
> duration (≤30s). Under 400 words.

## Synthesis
After all 4 agents return, write `T6-04-DESIGN-BRIEF.md` at repo root with
exactly these sections:

```
# T6-04 Design Brief

**Produced:** <YYYY-MM-DD>
**Status:** authoritative for tiers T1–T3

## 1. Brand palette
<Agent A output, lightly edited>

## 2. TUI target mockups
<Agent B output, lightly edited>

## 3. Landing page
<Agent C output — copy blocks preserved verbatim>

## 4. Demo embed strategy
<Agent D output>

## Cross-cutting decisions
- Palette version bumped to: <X>
- TUI work order (T1 tier sequence)
- Landing hero asset choice (from site/images/)
- Demo format: <asciinema|webm|screenshots> — rationale
```

Also save each agent's raw output to `tmp/t6-04-design/agent-{a,b,c,d}.md`
for traceability.

## Acceptance criteria
- `T6-04-DESIGN-BRIEF.md` exists at repo root with all 4 numbered sections
  and a "Cross-cutting decisions" section.
- `tmp/t6-04-design/agent-a.md` through `agent-d.md` exist.
- Word count ≥ 1500 (enough substance for T1/T2/T3 to consume).
- No engine source edited.

## Out of scope
- Do not implement any of the TUI changes — that's T1.
- Do not write HTML/CSS — that's T2.
- Do not record the actual demo — that's T2-01.

## Verification the worker should self-run before finishing
```bash
ls T6-04-DESIGN-BRIEF.md
wc -w T6-04-DESIGN-BRIEF.md
ls tmp/t6-04-design/agent-*.md
echo "DONE: T0-02-ultrathink-design-research"
```
