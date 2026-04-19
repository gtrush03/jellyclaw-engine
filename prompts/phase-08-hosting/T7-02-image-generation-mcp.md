# Phase 08 Hosting — Prompt T7-02: Image-generation MCP (Gemini / Replicate)

**When to run:** After T7-01 (vision Read). T5-01 (HTTP MCP transport) is required — this prompt ships an MCP template entry that depends on it.
**Estimated duration:** 1–2 hours
**New session?** Yes.
**Model:** Claude Opus 4.7 (1M context).

## Dependencies

- **T7-01 (hard).** Generated PNGs are worthless if the agent can't Read them back to verify. T7-01 makes Read vision-capable.
- **T5-01 (hard).** Browserbase + Exa both proved the HTTP MCP path; this prompt reuses it for `imagegen`. If the registry still rejects `transport: "http"`, STOP and emit `FAIL: T7-02 — T5-01 not landed`.

## Context

jellyclaw can read images (T7-01), browse screenshots, and edit HTML. It cannot **generate** design assets — a logo, a mockup tile, a hero-image placeholder, a brand-mark iteration. Every time George builds a landing page he either (a) pulls a stock photo or (b) ships with the "TODO: design later" placeholder. That's a real product gap for a tool positioned as a design-iteration engine (T7-03 + T7-04).

Rather than write a new MCP server inside jellyclaw, we bolt on an existing one. Three real options:

1. **Gemini 2.5 Flash Image (a.k.a. Nano Banana) via `@google/generative-ai` stdio MCP** — George already has the Gemini engine at `/Users/gtrush/Downloads/NYC/gemini-engine/` and a `GEMINI_API_KEY` in his env. The `compound-engineering:gemini-imagegen` skill already uses this surface. Output: high-quality photoreal + text-in-image (Gemini's unusual strength).
2. **Replicate MCP** (`@replicate/mcp-server`, stdio) — FLUX.1 / SDXL / any open-source model. Needs `REPLICATE_API_TOKEN`. Slower (10–40 s per image) but unbeatable model variety.
3. **OpenAI Images (gpt-image-1) via a small MCP wrapper** — only if a maintained one exists. Lower priority; OpenAI's API vs Anthropic-preferred posture.

We ship **all three as disabled-by-default template entries**, each gated on its own env var via the `_requires_env` marker T5-02 added to the loader. User sets **one** key, flips `_disabled: false`, restarts — and the agent gains an image-generation tool surface (`mcp__gemini__generate_image`, `mcp__replicate__predict`, etc.). No new engine source code. This is **template + docs + verification**.

## Research task

1. Read `engine/templates/mcp.default.json` as it stands after T5-02 — confirm the `_disabled`, `_requires_env`, and header-interpolation conventions. Template entries MUST follow the exact shape T5-02 codified or the loader rejects them.
2. Read `engine/src/cli/mcp-config-loader.ts` — confirm the `_requires_env` gate is live. If it skips silently on missing env, that's our graceful no-op path.
3. WebFetch `https://github.com/modelcontextprotocol/servers` and list every image-generation MCP server present. Expect `gemini`-flavored ones under community repos; the official Anthropic list may have none. Cross-check npm: `npm search mcp image gemini` via `npm search` or by hitting `https://registry.npmjs.org/-/v1/search?text=mcp%20image` — pick a **maintained** package (updated within the last 60 days), reputable maintainer, ≥5 GitHub stars as a weak signal.
4. WebFetch `https://ai.google.dev/gemini-api/docs/image-generation` — confirm the model name (`gemini-2.5-flash-image-preview` as of April 2026, or its successor — the docs are authoritative), request shape, output format (base64 PNG in response parts), rate limits, and pricing ($0.039/image at time of writing).
5. WebFetch `https://github.com/replicate/mcp` (if it exists) or `https://replicate.com/docs/topics/mcp` — Replicate has a first-party MCP offering; confirm the stdio command + env-var name.
6. Read `/Users/gtrush/Downloads/NYC/gemini-engine/README.md` (if it exists) — George's own wrapper scripts. We do NOT depend on them at runtime, but they're the canonical reference for how George authenticates to Gemini today (same key, same endpoint).
7. Read `~/.claude/plugins/cache/claude-plugins-official/compound-engineering/skills/gemini-imagegen/SKILL.md` — the existing gemini-imagegen skill. Notes the canonical model name, example prompts, editing workflow (multi-turn refinement). Our MCP template should expose the SAME model surface.
8. Read `docs/mcp.md` — find the "Defaults" section T5-02 wrote. New stanzas here get documented in a new "Image generation" subsection.
9. Decide the **one** we recommend in docs: **Gemini 2.5 Flash Image** is the recommended default. Fast (~2 s/image), cheap, excellent text rendering (for logos), and George's key is already in env. Replicate is the power-user alternative; OpenAI is a placeholder if we find a solid maintained MCP — otherwise omit.

## Implementation task

Scope: add 2–3 disabled template entries for image-generation MCPs, each correctly gated on its own env var, each using an MCP server that already exists on npm (or via `npx @vendor/package`). Document the setup flow for each. Verify one end-to-end (the one for which we have a key).

### Files to create / modify

- **Modify** `engine/templates/mcp.default.json` — append two entries after the existing Exa/Browserbase stanzas:

  ```jsonc
  {
    "_comment": "DISABLED — Gemini 2.5 Flash Image (Nano Banana). Set GEMINI_API_KEY and flip _disabled:false. Generates PNGs from text prompts; agent can Read the file back to SEE what was generated (requires T7-01). Tool surface: mcp__gemini__generate_image.",
    "_disabled": true,
    "_requires_env": ["GEMINI_API_KEY"],
    "transport": "stdio",
    "name": "gemini",
    "command": "npx",
    "args": ["-y", "<AUDIT: exact package name from research step 3 — verify maintained + working>"],
    "env": { "GEMINI_API_KEY": "${GEMINI_API_KEY}" }
  },
  {
    "_comment": "DISABLED — Replicate (FLUX.1, SDXL, hundreds of models). Set REPLICATE_API_TOKEN and flip _disabled:false. Slower than Gemini but unbeatable model variety. Tool surface: mcp__replicate__predict.",
    "_disabled": true,
    "_requires_env": ["REPLICATE_API_TOKEN"],
    "transport": "stdio",
    "name": "replicate",
    "command": "npx",
    "args": ["-y", "<AUDIT: verify Replicate's official or top community MCP package>"],
    "env": { "REPLICATE_API_TOKEN": "${REPLICATE_API_TOKEN}" }
  }
  ```

  Leave the exact package names as `<AUDIT: ...>` placeholders until the research task confirms a maintained server. If research returns nothing reputable for Replicate, **ship only the Gemini entry** and note in `docs/imagegen-setup.md` that Replicate support is pending a stable MCP server.

- **Create** `docs/imagegen-setup.md` — user-facing runbook:

  ```markdown
  # Image generation with jellyclaw

  jellyclaw can generate PNGs (logos, mockups, hero images, brand marks) by
  attaching an image-generation MCP server. Two are configured by default, both
  disabled until you add an API key.

  ## Option 1 — Gemini 2.5 Flash Image (recommended)

  Fast (~2 s/image), cheap ($0.039/image, April 2026), great at rendering
  legible text in logos.

  1. Get a key at https://aistudio.google.com/app/apikey.
  2. Export it:
     ```bash
     echo 'export GEMINI_API_KEY=…' >> ~/.zshrc && source ~/.zshrc
     ```
  3. Enable the stanza in `~/.jellyclaw/mcp.json` (or edit the repo template):
     `"_disabled": true` → `"_disabled": false`.
  4. Restart jellyclaw. On next `jellyclaw run` you'll see:
     ```
     mcp: connected server=gemini tools=N
     ```
  5. Verify:
     ```bash
     jellyclaw run "generate a minimalist logo for a coffee brand called 'Umbra' \
       — dark background, gold accent, serif wordmark — save the PNG to /tmp/umbra.png"
     # Then:
     ls -lh /tmp/umbra.png
     jellyclaw run "read /tmp/umbra.png and describe it in one sentence"
     # Expect a visual description (vision enabled by T7-01).
     ```

  ## Option 2 — Replicate (power user)

  Use FLUX.1, SDXL, or any model on replicate.com.

  1. Get a token at https://replicate.com/account/api-tokens.
  2. Export `REPLICATE_API_TOKEN`, same shape as above.
  3. Flip `_disabled: false` on the `replicate` stanza.

  ## Cost notes

  - Gemini 2.5 Flash Image: $0.039/image at 1024×1024. 25 images ≈ $1.
  - Replicate FLUX.1 [schnell]: ~$0.003/image, ~5 s/image.
  - Replicate FLUX.1 [pro]: ~$0.04/image, ~15 s/image.

  ## Failure modes

  - Missing env var → the stanza silently no-ops (no error). Check `jellyclaw run --verbose`.
  - Quota exceeded → surfaced as `tool.error code="upstream_quota_exceeded"`.
  - Model moderation refusal → `tool.error code="content_policy"`. Rephrase.

  ## For design iteration

  See `design-iterator` skill (T7-04). It chains image generation → Read →
  visual critique → regenerate, which is what you want 80% of the time.
  ```

- **Modify** `docs/mcp.md` — add an "Image generation" subsection under Defaults linking to `imagegen-setup.md` and listing the two stanzas + their env-var gates.

- **Modify** `engine/src/cli/mcp-config-loader.test.ts` (if it exists — search with `ls engine/src/cli/mcp-config-loader*`): add a regression case that the template parses cleanly with both new stanzas present. Do NOT require the env vars in CI — the `_requires_env` gate should skip them, and the loader should still produce a valid config.

- **Update** `COMPLETION-LOG.md` — append `08.T7-02 ✅` with the final list of stanzas added (Gemini; optionally Replicate).

### Files NOT to create

- **No new engine source.** This prompt is configuration + docs. If you feel tempted to write `engine/src/mcp/imagegen-wrapper.ts`, stop. The MCP server is the third-party code; the wrapper is unneeded.
- **No custom Gemini MCP inside jellyclaw.** If research step 3 finds no maintained Gemini image MCP on npm, flag it in the prompt output and recommend George (a) write a thin wrapper in `/Users/gtrush/Downloads/NYC/gemini-engine/` that speaks stdio MCP, then (b) point the stanza at that wrapper's path. That's a separate prompt (T7-02b), not this one.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

# Sanity — template parses.
node -e "JSON.parse(require('node:fs').readFileSync('engine/templates/mcp.default.json','utf8'))" \
  && echo "template JSON ok"

bun install
bun run typecheck
bun run lint
bun run test engine/src/cli/mcp-config-loader.test.ts
bun run build

# Smoke without the key — the loader should silently skip the stanza.
unset GEMINI_API_KEY REPLICATE_API_TOKEN
./dist/cli.js run --max-turns 1 "list your MCP tools" 2>&1 | grep -E "mcp:|imagegen|gemini|replicate" || true
# Expect: NO mcp__gemini__ or mcp__replicate__ tools in the listing.
# Expect: log line like "mcp: skipping entry — required env var(s) unset server=gemini missing=[GEMINI_API_KEY]"

# Live smoke — with the key set.
if [ -n "$GEMINI_API_KEY" ]; then
  rm -f /tmp/umbra-test.png
  ./dist/cli.js run --permission-mode bypassPermissions --max-turns 6 \
    "Using your image-generation MCP, create a logo for a coffee brand \
     called 'Umbra' — minimalist, dark bg, gold serif wordmark. \
     Save the PNG to /tmp/umbra-test.png, then Read it back and confirm \
     the wordmark is legible."
  [ -f /tmp/umbra-test.png ] && echo "image written: $(ls -lh /tmp/umbra-test.png)" \
    || { echo "FAIL: image not written"; exit 1; }
  file /tmp/umbra-test.png | grep -q "PNG image data" || { echo "FAIL: not a valid PNG"; exit 1; }
else
  echo "SKIP: GEMINI_API_KEY unset — live smoke skipped (template parse test still must pass)"
fi
```

### Expected output

- Template JSON parses cleanly; `engine/src/cli/mcp-config-loader.test.ts` passes with new regression case.
- Without env vars, both stanzas silently skip — agent sees no `mcp__gemini__*` tools, no errors.
- With `GEMINI_API_KEY` set, agent:
  1. Spawns the Gemini MCP,
  2. Calls a `generate_image` (or equivalent) tool with the Umbra prompt,
  3. Writes a valid PNG to `/tmp/umbra-test.png`,
  4. Reads it back (using T7-01's vision Read) and describes the wordmark.
- `docs/imagegen-setup.md` walks a new user from zero to first generated image.

### Tests to add

- `engine/src/cli/mcp-config-loader.test.ts`:
  - Regression: the full shipped `mcp.default.json` parses without error with both new stanzas.
  - Regression: with `GEMINI_API_KEY` unset, the loader skips the gemini stanza silently (no warn, no error — just a debug log).
  - Regression: with `GEMINI_API_KEY=dummy` and `_disabled: false`, the loader includes the stanza in the output config (does NOT actually spawn the server — that's the registry's job).
- No new unit tests inside `engine/src/mcp/` — we're not writing new transport code.

### Common pitfalls

- **Do NOT commit a real API key to the template.** The template uses `${GEMINI_API_KEY}` placeholder syntax exclusively. A pre-commit hook + `git secrets` scan is out of scope here, but double-check `git diff` before any commit.
- **`_disabled: true` is the SHIPPED default.** Never enable by default. Flipping the default to `false` without gating would spam Gemini calls on every fresh install.
- **`_requires_env` must list the exact env var names.** A typo (`GEMNI_API_KEY`) silently keeps the stanza enabled but broken — the server spawns and immediately fails auth. The loader test should assert the typed name is what we ship.
- **`npx -y` on every run is slow.** After the first run npm caches the package, but the first `jellyclaw run` after install will stall 5–10 s spawning npx. Document this in `imagegen-setup.md` (note about pinning to a local clone for power users — `"command": "node", "args": ["/path/to/mcp-server/dist/cli.js"]`).
- **Gemini model names change.** `gemini-2.5-flash-image-preview` today; could be `gemini-3.0-flash-image` tomorrow. Do NOT hardcode the model in the template if the MCP server exposes a config option — let users pass it via env (`GEMINI_IMAGE_MODEL`).
- **Content-policy refusals are surfacing.** When Gemini refuses a prompt (e.g., real-person likenesses), the MCP returns a non-PNG error response. The agent should handle this gracefully — NOT write a 0-byte file and pretend success. Manual test: prompt "generate an image of [famous person]" and assert the agent surfaces the refusal cleanly.
- **Do NOT use an unmaintained MCP server.** If the top npm result has 3 stars and its last commit was 8 months ago, it will break. Either find a maintained one or ship only Gemini. Better to have one working option than two half-working ones.
- **Replicate's image outputs are URLs, not base64.** The Replicate MCP typically returns a URL; the agent needs to fetch it separately (Bash `curl`) to save the PNG. Document this in `imagegen-setup.md`. Gemini returns inline base64, which is simpler — another reason it's the recommended default.
- **Output size budget.** A single 1024×1024 PNG is ~1.2 MB. Above 10 MB the Read tool rejects it (T7-01's cap). Gemini output is well below that; Replicate FLUX at 2048×2048 HDR can hit it. Document the cap.
- **Agent needs to be told HOW to save.** The MCP tool returns image data; the agent must then Write it to disk (Bash: `echo "$base64" | base64 -d > out.png`) OR use the `Write` tool if the MCP already base64-decoded. The `design-iterator` skill (T7-04) bakes this workflow in — but the verification smoke here should also confirm the model figures out the save step.

## Closeout

1. Append to `COMPLETION-LOG.md`: `08.T7-02 ✅` with the count of new stanzas (1 or 2) and the result of the live Umbra-logo smoke (SAVED/SKIPPED).
2. Print `DONE: T7-02` on success, `FAIL: T7-02 <reason>` on fatal failure.
