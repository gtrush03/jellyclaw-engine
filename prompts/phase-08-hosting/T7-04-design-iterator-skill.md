# Phase 08 Hosting — Prompt T7-04: design-iterator skill + workflow

**When to run:** After T7-01 (vision Read), T7-03 (frontend-design skill). T7-02 (image-gen) is optional — iterator works on HTML layouts without it, but logo/hero refinement uses it.
**Estimated duration:** 1–2 hours
**New session?** Yes.
**Model:** Claude Opus 4.7 (1M context).

## Dependencies

- **T7-01 (hard).** The iterator's core move is "screenshot → Read back → SEE → critique → edit → screenshot again." Without vision-capable Read, the agent can't see its own output — loop is blind.
- **T7-03 (hard).** The iterator critiques layouts against a design rubric. `frontend-design` is that rubric. Without it, the iterator has nothing to judge against and converges on "looks fine."
- **T7-05 (soft).** If the skill body stays under 1536 B it inlines directly; over that it lives in the Skill tool (invoked on demand). T7-05 raises the cap but isn't blocking.
- **Playwright MCP (already present from Phase 07.5).** `browser_take_screenshot` is the PNG source. If Playwright MCP isn't running, the skill tells the agent to either launch it via `scripts/jellyclaw-chrome.sh` or fall back to `bash` + `chromium --screenshot` headless.

## Context

George runs a real workflow today: ask Claude to build HTML → screenshot → eyeball → "make the hero tighter, headline is too long, CTA button is buried" → paste new HTML → screenshot → repeat 3–5 times. That's the actual loop. It works but costs one full turn per iteration, George has to stay in the loop, and judgment quality varies.

We encode the loop as a skill. The skill instructs the agent: given a goal state + current file, (a) render + screenshot, (b) Read the screenshot (vision), (c) compare against the goal, (d) propose **exactly 3** concrete changes prioritized by impact, (e) apply them via Edit, (f) re-screenshot, (g) compare before/after, (h) repeat N times or until "converged" (diminishing returns on the critique axis). No browser-automation novelty — just a tight orchestration of tools that already exist.

The skill has two modes:
1. **Static HTML iteration** — edit a file on disk, use Playwright to take a screenshot, Read the PNG, critique, edit, loop.
2. **Live page iteration** — when the file is served (e.g., Vite dev server on :5173), same loop but the screenshot source is the live URL. The agent never has to restart the server.

## Research task

1. Read `skills/commit/SKILL.md` — 21 lines, 600 B body. That's the shape your `design-iterator` skill mirrors, tightened for size. The target body size is **≤ 1200 B pre-T7-05, ≤ 4 KB post-T7-05.**
2. Read `docs/skills.md:22-30` — frontmatter schema. `description` must trigger the skill crisply. Mention "iterate / refine / improve the design" explicitly so the skill fires on natural language.
3. Read `engine/src/tools/read.ts:204-213` + the T7-01 changes — confirm image Reads now reach the model as visual blocks. If T7-01 is not landed, STOP and emit `FAIL: T7-04 — T7-01 dependency not met`.
4. Read `skills/frontend-design/SKILL.md` (T7-03's output) — this is the rubric the iterator cites. The iterator body should reference it by name: "apply the `frontend-design` skill's palette/typography/spacing checklist on each pass."
5. Read `engine/src/cli/chrome-autolaunch.ts` (Phase 07.5) — confirm how Playwright MCP's `browser_take_screenshot` tool name maps in the agent's tool list. Expected: `mcp__playwright__browser_take_screenshot` or `mcp__chrome__browser_take_screenshot` depending on the server name in `mcp.default.json`.
6. Read `prompts/phase-07.5-fix/T4-02-session-end-screenshot.md` — understand the screenshot-to-disk convention already in place. The iterator writes to a predictable tmp dir: `/tmp/jc-design-iter/<session>-<iter>.png`.
7. Grep `engine/src/tools/edit.ts` — confirm Edit supports the "before overwrite, must have Read" invariant. The iterator Reads the HTML first, edits with the Edit tool, respects that invariant.
8. WebFetch `https://playwright.dev/docs/api/class-page#page-screenshot` — confirm `animations: "disabled"` is a first-class option (mirroring T5-05's animation-freeze work). The iterator passes `animations: "disabled"` on every screenshot for deterministic pixels.
9. Look at one public reference for "iterate N times until converged" prompt patterns: `https://www.anthropic.com/news/claude-4-5-system-card` or any public agent-loop research you find. The convergence heuristic (diminishing-returns) is what prevents infinite loops.

## Implementation task

Author a `design-iterator` skill that chains existing tools into a multi-pass visual-critique loop. No engine code changes. Document. Verify with a live run that produces visibly tighter output over 3 passes.

### Files to create / modify

- **Create** `skills/design-iterator/SKILL.md` — directory form. Target ≤ 1200 B body pre-T7-05. Frontmatter:

  ```yaml
  ---
  name: design-iterator
  description: Iteratively refine a UI design through render → screenshot → critique → edit cycles. Invoke when the user says 'iterate', 'refine', 'improve', 'polish', 'tighten', or 'N times' on any HTML/CSS/React file or served URL. Uses the frontend-design rubric to critique each pass; stops at N iterations or on diminishing returns.
  trigger: "when the user asks to iterate, refine, improve, polish, tighten, or run N design passes on a UI — HTML file, served URL, component"
  allowed_tools: [Read, Write, Edit, Grep, Glob, Bash]
  ---
  ```

  Body content:

  ```markdown
  # Design iterator — multi-pass visual refinement

  **Prerequisites:** `frontend-design` skill loaded. Playwright MCP running
  (`mcp__playwright__*` tools available). Target is an HTML file on disk OR a
  live URL (e.g., `http://localhost:5173`).

  **Inputs from the user:**
  - `target`: file path or URL to iterate on.
  - `N`: number of passes (default 3, max 6).
  - `goal`: one-line description ("tighter hierarchy", "less busy", "make the CTA pop"). Optional but helps.

  ## The loop (repeat up to N times)

  For each pass `i` from 1 to N:

  1. **Snapshot current state.** If `target` is a URL, `browser_navigate` to it.
     If a file, open `file://${abs_path}` in the browser. Then
     `browser_take_screenshot({ animations: "disabled", fullPage: true,
     filename: "/tmp/jc-design-iter/pass-${i}.png" })`.
     Wait for network idle first (`browser_wait_for`).

  2. **See it.** `Read("/tmp/jc-design-iter/pass-${i}.png")`. Vision Read (T7-01)
     puts the actual pixels into your context. You now KNOW what the page looks
     like — not what you think the HTML should produce.

  3. **Critique against the rubric.** Apply the `frontend-design` checklist
     (palette ≤3 hues, font sizes ≤4, consistent radius, no generic gradients,
     no unjustified emoji, ≥96 px section padding, body max-width ≤720 px, copy
     says something specific). For each violation, state it in one sentence.

  4. **Pick exactly 3 changes.** Rank them by impact on the user's `goal`
     (or on "non-generic aesthetic" if no goal). Discard everything below top 3.
     More than 3 per pass = thrashing; fewer = under-using the pass.

  5. **Apply the changes.** If `target` is a file, use `Edit` (respecting the
     read-before-write invariant — Read the file first). If it's a served URL
     backed by a file the user owns, ask which file to edit with
     `AskUserQuestion` BEFORE editing.

  6. **Re-snapshot.** Same `browser_take_screenshot` call, filename
     `/tmp/jc-design-iter/pass-${i}-after.png`.

  7. **Compare.** Read both PNGs. One-sentence verdict: did the top 3 changes
     land visibly? If any regression introduced (new violation), flag it. If
     the critique list for pass `i+1` is substantially similar to pass `i`,
     we've converged — stop early.

  ## Stopping conditions

  - `i == N` (requested passes completed).
  - Two consecutive passes produce near-identical critique lists (convergence).
  - The user's `goal` is visibly met (state why).

  ## Output

  At the end, list in order:
  - Before screenshot path (pass 1 pre).
  - After screenshot path (last pass post).
  - Changes applied per pass (bulleted, one line each).
  - Final rubric score (e.g., "5/7 passing, 2 intentional trade-offs").

  ## Non-goals

  This skill does NOT generate the initial HTML. It refines what exists. If the
  target doesn't exist, ask the user to provide or ask `frontend-design` to
  generate the first draft, then iterate.

  $ARGUMENTS is parsed as "target [N] [goal]" — e.g.,
  `/tmp/site.html 5 "tighter hero, quieter cards"`.
  ```

  Pre-T7-05: trim to the minimum viable form (steps 1–7 + stopping conditions, skip Non-goals section). Measure: `wc -c skills/design-iterator/SKILL.md` should be ≤ 1200 B minus the frontmatter.

- **Modify** `docs/skills.md` — add a row:
  ```markdown
  | `design-iterator` | Chain screenshot → Read → critique → Edit → re-screenshot passes to refine a UI. Use with `frontend-design`. |
  ```

- **Update** `COMPLETION-LOG.md` — append `08.T7-04 ✅`.

### Files NOT to touch

- No engine source. This is pure skill markdown.
- Do NOT add a new Tool wrapper like `IterateDesign`. The whole point is to compose EXISTING tools (Read, Edit, browser_take_screenshot). New tools are added when composition is genuinely insufficient; it isn't here.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

# Sanity — skill parses.
bun install
bun run test engine/src/skills/parser.test.ts
bun run test engine/src/skills/registry.test.ts
bun run typecheck
bun run lint
bun run build

# Byte-count check.
wc -c skills/design-iterator/SKILL.md

# Live verification — iterate on a scrappy baseline.
mkdir -p /tmp/jc-design-iter

cat > /tmp/espresso-site.html <<'HTML'
<!doctype html>
<html><head><title>Espresso Co.</title></head>
<body style="margin:0;font-family:Arial;background:linear-gradient(135deg,purple,pink);color:white;padding:40px;text-align:center;">
  <h1 style="font-size:48px;">☕ Welcome to Espresso Co. ✨</h1>
  <p>🚀 The most amazing specialty coffee experience 🌟</p>
  <div style="background:white;color:black;padding:20px;border-radius:20px;margin:20px;">
    <h2>🔥 Our Features</h2>
    <p>✅ Single origin ✅ Small batch ✅ Freshly roasted</p>
  </div>
  <button style="background:gold;padding:20px;border-radius:20px;font-size:24px;">💰 Shop Now 💰</button>
</body></html>
HTML

# Run the iterator for 3 passes against the file.
./dist/cli.js run --permission-mode bypassPermissions --max-turns 40 \
  "iterate on /tmp/espresso-site.html 3 times using the design-iterator skill. \
   Goal: make it non-generic — remove emoji, constrain palette, fix typography hierarchy."

# Inspect the results.
ls -la /tmp/jc-design-iter/
grep -oP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' /tmp/espresso-site.html | wc -l
#   Expect 0 or very few emoji remaining.
grep -c "linear-gradient" /tmp/espresso-site.html || true
#   Expect 0 or 1 subtle one.
grep -oE '#[0-9a-fA-F]{3,6}' /tmp/espresso-site.html | sort -u | wc -l
#   Expect ≤ 5 distinct colors (body + 3 palette + maybe one transparent).

open /tmp/espresso-site.html 2>/dev/null || true
# Visual confirmation: file should read as a deliberate design, not AI gradient soup.
```

### Expected output

- Skill loads cleanly (`registry.get("design-iterator")` returns a skill; no parser warnings).
- Live run produces:
  - 3 × "before" PNGs + 3 × "after" PNGs in `/tmp/jc-design-iter/`.
  - Final `/tmp/espresso-site.html` with emoji count dropped to 0, gradient simplified or removed, font-family system stack, visible hierarchy (one H1 size, one H2 size, body text).
  - Agent's final message lists changes per pass + rubric score.
- `wc -c` on the skill body is within the cap for the current `SKILL_BODY_MAX_BYTES`.
- Before/after screenshots visibly differ — open them side-by-side in Preview.

### Tests to add

- `engine/src/skills/parser.test.ts` — regression case: parsing `skills/design-iterator/SKILL.md` succeeds.
- `engine/src/skills/registry.test.ts` — regression case: `design-iterator` loads.
- No unit test for the loop itself — the loop lives in the model's reasoning, tested by the live smoke.
- **Optional** `test/integration/design-iterator.test.ts` — env-gated (`JELLYCLAW_DESIGN_ITER_TEST=1`) that runs the live smoke above and asserts emoji/gradient counts on `/tmp/espresso-site.html` drop between pre and post. Treat as manual.

### Common pitfalls

- **Agent calls the loop but skips step 2 (Read the screenshot).** Without the vision Read, it's critiquing its own imagined HTML, not the actual render. The skill body must ALWAYS order "screenshot → Read → critique." If you see the agent iterating without a Read between screenshot and edit, the skill's wording is unclear — fix it in the markdown, don't add an enforcement tool.
- **Playwright MCP timeout on heavy pages.** 5 s default on `browser_take_screenshot`. If the target is heavy (external fonts, third-party scripts), bump via `timeout: 15000` in the tool call, or use the T4-02 direct-CDP path as a fallback.
- **File-path vs URL ambiguity.** The skill's `target` can be either. If it looks like a path and starts with `/` or has an extension, treat as file (`file://`). Otherwise URL. Document the heuristic.
- **Edit-before-Read violation.** `engine/src/tools/edit.ts` enforces that you must Read a file in the current session before Edit-ing it. The skill's step 5 must Read the HTML FIRST even if the agent already did so in an earlier pass — `readCache` is session-scoped, which is fine across passes in the same run.
- **`AskUserQuestion` in auto modes.** The step "if target is a URL, ask which file backs it" blocks in `--permission-mode bypassPermissions`. Either (a) accept the block — the skill is interactive by nature — or (b) document that non-interactive runs must pass the backing file path directly.
- **N > 6 is a footgun.** Each pass is ~6 tool calls (navigate, screenshot, read, critique, edit, re-screenshot). N=10 eats 60+ calls and the model starts thrashing. Cap at 6 in the skill body.
- **Convergence detection.** "Critique lists nearly identical" is fuzzy. The model's judgment here is OK — don't try to add a string-diff heuristic. Trust the model + the frontend-design rubric.
- **Do NOT generate images in this skill.** Image generation is T7-02's domain. The iterator edits HTML/CSS. If the user asks "refine this logo," redirect them to generate a new variant via the gemini/replicate MCP, not to try to edit a PNG.
- **Screenshot paths leak across sessions.** `/tmp/jc-design-iter/` is shared. The skill body suggests including a short session-id in the filename to avoid collisions — e.g., `pass-${sessionId.slice(0,6)}-${i}.png`. Lightweight; no engine change needed.
- **Skill body over the injection cap.** Pre-T7-05 the cap is 1536 B. If your full body is 1800 B, the skill still **loads** (under the 8 KB parse cap) but its **description line** injects and the **body** only reaches the model when it calls `Skill({name:"design-iterator"})`. That's actually FINE — the Skill tool pattern is designed for this. Just verify with `jellyclaw run --verbose` that the agent actually invokes the Skill tool on the first iteration.
- **Do not hardcode "3 times" in the skill.** The description lists it as a default; the body reads N from `$ARGUMENTS`. Static hardcodes remove user agency.
- **The `frontend-design` rubric isn't inlined into this skill body.** The iterator points at `frontend-design` by name — the model loads it via the Skill tool when needed. This keeps both skills small and composable.

## Closeout

1. Append to `COMPLETION-LOG.md`: `08.T7-04 ✅` with the skill body byte count, the per-pass emoji/gradient deltas from the espresso-site smoke, and the final rubric score reported by the agent.
2. Print `DONE: T7-04` on success, `FAIL: T7-04 <reason>` on fatal failure.
