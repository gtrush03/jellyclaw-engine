# Phase 08 Hosting — Prompt T7-03: frontend-design skill

**When to run:** After T7-05 (skill cap raise) if landed; otherwise the skill ships terse under the 1536-byte injection cap and gets inlined anyway via the Skill tool. Functional either way.
**Estimated duration:** 1–2 hours
**New session?** Yes.
**Model:** Claude Opus 4.7 (1M context).

## Dependencies

- **T7-05 (soft).** Not blocking. If T7-05 has raised the injection cap to 6144 B and the body cap to 32 KB, this skill can be the full ~9 KB version (mirrors the upstream `frontend-design` skill George has in `~/.claude/plugins/cache/claude-plugins-official/compound-engineering/skills/frontend-design/` and `~/.claude/plugins/cache/claude-plugins-official/frontend-design/`). If T7-05 is NOT landed yet, ship a **terse ~1.2 KB variant** whose description fits under injection, and whose body still loads via the Skill tool (parser cap is 8 KB — terse fits fine).
- **No other T-prompt dependencies.**

## Context

When jellyclaw builds HTML/CSS/JS today — a landing page, a dashboard, a components demo — the default aesthetic is the one Anthropic's model converges on without guidance: gradient backgrounds, emoji icons, rounded cards, generic system fonts, drop shadows everywhere, three-line "welcome to our platform!" copy. It's legible but it's not **distinctive**. Claude Code solved this upstream with a `frontend-design` skill (present in both `compound-engineering` plugin cache and, separately, a top-level `frontend-design` plugin — George has both). The skill is a **design brief, not a framework**: constrained palette, real typography hierarchy, breathing whitespace, consistent radius scale, anti-emoji-gradient rules, examples of "great" vs "generic" patterns.

We port that essence into jellyclaw's skill system so any agent on this engine — inside Genie, inside the TUI, via the HTTP API — picks up the design brief whenever UI work happens. No code changes: skills are markdown + frontmatter.

The skill is **declarative, not prescriptive about tools**. It tells the model WHAT good looks like and WHAT to avoid. Tool use (Read, Write, browser_take_screenshot) is the model's choice.

## Research task

1. `ls ~/.claude/plugins/cache/claude-plugins-official/` — find `frontend-design/` and `compound-engineering/skills/frontend-design/`. Read both SKILL.md files. They may differ; pick the stronger one as the base. Measure the body byte count with `wc -c <path>`.
2. Read `~/.claude/plugins/cache/claude-plugins-official/frontend-design/SKILL.md` end-to-end. Note its structure: (a) design principles, (b) palette guidance, (c) typography rules, (d) spacing scale, (e) anti-patterns list, (f) examples.
3. Read `engine/src/skills/types.ts` — confirm the `SkillFrontmatter` schema. Your new skill's frontmatter must pass Zod validation: `name` kebab-case `[a-z0-9-]+`, `description` 1–1536 chars, optional `trigger` + `allowed_tools`.
4. Read `engine/src/skills/parser.ts:64-69` — the `SKILL_BODY_MAX_BYTES` cap is **8 KB** today. Bodies above that throw `SkillLoadError` and the skill is skipped entirely. If T7-05 has shipped, the cap is 32 KB — check `engine/src/skills/types.ts:31` for the live value.
5. Read `engine/src/skills/inject.ts:29` — `DEFAULT_INJECTION_MAX_BYTES = 1536`. The description (not the body) is what lands in the system prompt. Keep the description under ~220 chars (Zod allows 1536 but shorter is better — leaves room for other skills in the block).
6. Read `skills/commit/SKILL.md` and `skills/review/SKILL.md` — the only two shipped skills today. Mirror their frontmatter shape exactly.
7. Read `docs/skills.md` — understand where to document the new skill. T7-03 adds a row to the example-skills section.
8. WebFetch one reference for the aesthetic we're aiming at: `https://vercel.com/design` or `https://linear.app` — these are what "distinctive, not generic" looks like in 2026. Do NOT copy copy; use it to calibrate the anti-pattern list.

## Implementation task

Author a `frontend-design` skill that teaches the model constrained-palette, typography-first, anti-generic-gradient design. Ship it with a tight description + substantive body. Document in `docs/skills.md`. Verify with a before/after HTML generation test.

### Files to create / modify

- **Create** `skills/frontend-design/SKILL.md` — directory form (recommended per `docs/skills.md:53-55`). Frontmatter:

  ```yaml
  ---
  name: frontend-design
  description: Apply when building any HTML/CSS/React/Vue UI — landing pages, dashboards, components, marketing sites. Enforces constrained palette, real typography hierarchy, breathing whitespace, consistent radius/spacing scale, and blocks the generic-AI aesthetic (gradient + emoji + floating cards). Invoke at the START of UI work, not after.
  trigger: "when building HTML, CSS, React, Vue, landing pages, components, dashboards, or any UI work — invoke this BEFORE writing markup, not after"
  allowed_tools: [Read, Write, Edit, Grep, Glob, Bash]
  ---
  ```

  Body content (Markdown, ~1.0–1.5 KB if pre-T7-05, ~6–9 KB post-T7-05). The terse version MUST hit these beats:

  - **Color discipline (60-30-10).** One dominant neutral (60%), one supporting tone (30%), one accent (10%). NEVER more than 3 hues visible at once. Black/white/one-accent > gradients. If using a gradient, two stops max, angle not random (135° default), saturation under 50%.
  - **Typography hierarchy.** Pick ONE display font + ONE body font. Display for H1/H2; body for everything else. Three sizes max in the hierarchy (e.g., 48px / 20px / 14px). Line-height: 1.1 for display, 1.5 for body, 1.3 for UI chrome. Letter-spacing: -0.02em on display, 0 on body, +0.05em on ALL-CAPS chrome.
  - **Spacing scale.** Pick one unit (usually 4 px or 8 px) and stack it: 4 / 8 / 16 / 24 / 32 / 48 / 64 / 96. NEVER ad-hoc values (17 px, 23 px). Radius: pick ONE value (6 or 8 px) and use it everywhere — cards, buttons, inputs. Exception: pill buttons (999 px).
  - **Whitespace is the design.** If a layout feels busy, the fix is always "add whitespace." Section vertical padding: 96–160 px. Text column max-width: 640–720 px. Card internal padding: 24–32 px. NEVER edge-to-edge text without a max-width.
  - **Anti-patterns (blocked).** No emoji in production UI (reserve for chat/error states). No "✨ Welcome to our platform" hero copy. No `background: linear-gradient(purple, pink)`. No drop shadows above `0 1px 3px rgba(0,0,0,.1)` for subtle elevation — anything heavier is a modal/overlay concern. No centered-everything layouts unless explicitly requested. No rounded-3xl everywhere. No floating cards on colorful backgrounds (the card on gradient look). No emoji bullet points.
  - **Real-world defaults (system font stack, no Google Fonts unless explicit).**
    - Display: `"Inter Display", "Helvetica Neue", Inter, system-ui, -apple-system, sans-serif`
    - Body: `Inter, -apple-system, "Segoe UI", Roboto, sans-serif`
    - Mono (code): `"JetBrains Mono", "Fira Code", ui-monospace, monospace`
  - **Copywriting rules.** Every headline answers "what does this do, in 5 words?" Every subheadline adds ONE specific detail. No "seamless," "powerful," "innovative," "revolutionary." Verbs > adjectives. Concrete > abstract.
  - **Review checklist before shipping.** (1) Count the distinct colors — ≤3? (2) Count the font sizes — ≤4? (3) Is there a max-width on body text? (4) Is the radius value consistent? (5) Did I use any emoji I can't justify? (6) Does the hero copy say something specific or "welcome to the future"?

  If T7-05 is landed, the full body should include 2–3 **worked examples**: a "generic AI" hero block and its "constrained-palette" rewrite, side by side. Each example is ~1 KB of commented HTML/CSS. Without T7-05, omit the examples and point the model at the Skill-tool-loaded full body.

- **Modify** `docs/skills.md` — in the example-skills table/section, add a row for `frontend-design`:
  ```markdown
  | `frontend-design` | UI design brief: constrained palette, typography hierarchy, spacing scale, anti-generic rules. Invoke before any HTML/CSS/React work. |
  ```
  Place near `commit` and `review` in the same table.

- **Optional** `skills/frontend-design/examples/` — if we're going full-size, two files:
  - `generic-hero.html` — the anti-pattern (3-color gradient, emoji, floaty card).
  - `constrained-hero.html` — the rewrite (one bg, one accent, real H1, 720 px max-width, zero emoji).
  Both short (~60 lines each). The skill body references them by filename.

- **Update** `COMPLETION-LOG.md` — append `08.T7-03 ✅`.

### Verification protocol — before/after HTML generation

The real test isn't unit-test-shaped. It's: **does the agent produce visibly better HTML when this skill is loaded?**

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run build

# A. Agent WITHOUT the skill (baseline — temporarily move it aside)
mv skills/frontend-design /tmp/frontend-design.bak
./dist/cli.js run --permission-mode bypassPermissions --max-turns 4 \
  "Build a landing page for 'Umbra Coffee' — a single-origin specialty roaster.
   Write one self-contained index.html at /tmp/baseline.html. Hero + 3 feature cards + CTA." \
  > /tmp/baseline.log 2>&1
mv /tmp/frontend-design.bak skills/frontend-design

# B. Agent WITH the skill
./dist/cli.js run --permission-mode bypassPermissions --max-turns 6 \
  "Build a landing page for 'Umbra Coffee' — a single-origin specialty roaster.
   Write one self-contained index.html at /tmp/with-skill.html. Hero + 3 feature cards + CTA." \
  > /tmp/with-skill.log 2>&1

# Inspect both
wc -l /tmp/baseline.html /tmp/with-skill.html
echo "--- baseline gradients ---"
grep -c "linear-gradient\|radial-gradient" /tmp/baseline.html || true
echo "--- with-skill gradients ---"
grep -c "linear-gradient\|radial-gradient" /tmp/with-skill.html || true
echo "--- baseline emoji ---"
grep -oP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' /tmp/baseline.html | wc -l
echo "--- with-skill emoji ---"
grep -oP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' /tmp/with-skill.html | wc -l
echo "--- baseline Google Fonts ---"
grep -c "fonts.googleapis" /tmp/baseline.html || true
echo "--- with-skill Google Fonts ---"
grep -c "fonts.googleapis" /tmp/with-skill.html || true

# Open both side-by-side in a browser for visual comparison.
open /tmp/baseline.html /tmp/with-skill.html 2>/dev/null || true
```

### Expected output

- Skill loads at engine startup with no parser warnings. `jellyclaw run --verbose "list skills" 2>&1 | grep frontend-design` returns the skill.
- Injection block in the system prompt contains `- skill:frontend-design — <description>`. Verify by running with `LOG_LEVEL=debug` and greping "Available skills".
- Before/after comparison:
  - `/tmp/baseline.html` — emoji count > 0, gradient count ≥ 1, likely a Google Fonts link.
  - `/tmp/with-skill.html` — emoji count = 0, gradient count 0 or 1 (subtle if any), system font stack, ≤3 distinct hex colors in the CSS.
- Opened in browser: `/tmp/with-skill.html` reads as "someone deliberate designed this"; `/tmp/baseline.html` reads as "AI default aesthetic."

### Tests to add

- `engine/src/skills/parser.test.ts` — add one case: parsing `skills/frontend-design/SKILL.md` succeeds (no throw) under the current body cap. Binds the skill into CI so a regression in cap sizing breaks build immediately.
- `engine/src/skills/registry.test.ts` — add one case: with a discovery root pointing at `skills/`, the registry loads `frontend-design` successfully (`registry.get("frontend-design")` returns a skill).
- No new design-verification test in CI — the before/after HTML comparison is manual.

### Common pitfalls

- **Description length.** `SkillFrontmatter.description` is capped at 1536 chars by Zod, but the injection cap is 1536 **bytes total** for the entire block. Keep this skill's description under ~220 chars so 6–8 other skills also fit. Count with `echo -n "..." | wc -c`.
- **Body over 8 KB.** Pre-T7-05, the parser rejects bodies > 8192 B. Check `wc -c skills/frontend-design/SKILL.md` after authoring. If over, trim examples OR ship post-T7-05.
- **Do NOT declare `allowed_tools: [*]`.** That's not a thing. List actual tool names (Read, Write, Edit, Grep, Glob, Bash, browser_take_screenshot). Future enforcement layers key off this.
- **Do NOT embed real images/logos in the skill body.** Text only. The skill describes the aesthetic; the agent implements it with whatever tools are available.
- **Avoid prescribing a specific framework.** The skill must apply equally to vanilla HTML, React, Vue, Svelte, Astro. Color + typography + spacing rules are framework-neutral. If you catch yourself writing "in your `<StyledButton>` component," delete it.
- **The skill should NOT try to cover UX (navigation, forms, accessibility).** That's a different skill. This one is aesthetic / visual / typographic. Separate concerns = smaller skills = better cap fit.
- **Don't name the skill `design`.** Too generic; collides with users' own skills and with T7-04's `design-iterator`. `frontend-design` is specific and mirrors the upstream plugin name.
- **Character-set gotcha.** The full skill body is ASCII + a few common em-dashes. Use plain ASCII dashes (`-`) in the bullet list to avoid any invisible character that breaks YAML frontmatter parsing. Gray-matter is forgiving but not infallible.
- **The skill is a brief, not a linter.** Do not include "and if the agent violates this, throw an error" language. That's not how the skill system works — the registry loads, the model reads, the model decides. Keep the voice declarative.
- **Do not recommend specific fonts behind paywalls** (e.g., GT America, Söhne). Recommend the free system stack + Inter + JetBrains Mono. The skill is shipped to users who may not have Adobe Fonts.
- **Do NOT claim "this produces professional designs" in the body.** It produces non-generic designs. Professional requires human judgment, iteration, a designer. Keep claims modest.

## Closeout

1. Append to `COMPLETION-LOG.md`: `08.T7-03 ✅` with the skill body byte count and a one-line summary of the before/after visual delta ("baseline: 3 gradients + 5 emoji + Google Fonts; with-skill: 0 gradients + 0 emoji + system font stack").
2. Print `DONE: T7-03` on success, `FAIL: T7-03 <reason>` on fatal failure.
