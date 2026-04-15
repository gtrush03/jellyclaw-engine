# Phase 12 — Genie integration behind flag — Prompt 03: Skills + settings migration + qwen bug fix

**When to run:** After Prompt 02 of Phase 12 lands.
**Estimated duration:** 3-4 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `12`
- `<phase-name>` → `Genie integration behind flag`
- `<sub-prompt>` → `03-skills-and-settings-migration`
<!-- END SESSION STARTUP -->

## Research task

1. Read `integration/GENIE-INTEGRATION.md` §5 (skills migration), §6 (settings migration with full schema), §7 (system-prompt → hooks transition strategy).
2. Read `phases/PHASE-12-genie-integration.md` Step 7 (skills/agents unification) and Step 8 (MCP config port).
3. Audit current `~/.claurst/`:
   ```bash
   ls -la ~/.claurst/skills/ 2>/dev/null
   cat ~/.claurst/settings.json 2>/dev/null
   ```
4. Re-read `/Users/gtrush/Downloads/genie-2.0/src/core/dispatcher.mjs:118-123` — `TIER_MODELS` contains the bogus slug `qwen/qwen3.6-plus:free`. Fix per §2.4.

## Implementation task

Author and run `scripts/migrate-from-claurst.sh` (in jellyclaw-engine), which:
1. Creates `~/.jellyclaw/`, copies `settings.json` (transformed to OpenCode schema), copies `mcp.json`-equivalent fragment, symlinks `~/.jellyclaw/skills` → `~/.claurst/skills` (or copies — flag-controlled), seeds `~/.jellyclaw/hooks/` with empty placeholder scripts.
2. Validates the new settings file against the OpenCode schema (`@opencode/schema@1.4.4` validator).
3. Pins `@playwright/mcp@0.0.41` (matches Claurst's pin; never use a later version — MCP CDP handshake regressed past 0.0.41).
4. Patches `dispatcher.mjs:118-123` to remove the qwen bug — replace `TIER_MODELS` with the dual-provider table from `integration/GENIE-INTEGRATION.md` §2.4 (anthropic AND openrouter sub-tables, selected by `provider`).

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/scripts/migrate-from-claurst.sh` — idempotent, dry-run-able with `--dry-run`
- `/Users/gtrush/Downloads/jellyclaw-engine/scripts/validate-jellyclaw-settings.mjs` — Zod / opencode-schema validation
- `/Users/gtrush/Downloads/jellyclaw-engine/scripts/test-skills.sh` — list skills, exec one, confirm output
- `/Users/gtrush/Downloads/jellyclaw-engine/.jellyclaw-config.template/settings.json` — canonical template per §6
- `/Users/gtrush/Downloads/jellyclaw-engine/.jellyclaw-config.template/mcp.json` — Playwright MCP config
- `/Users/gtrush/Downloads/jellyclaw-engine/.jellyclaw-config.template/hooks/{telegram-pre-bash,telegram-post-bash}.sh` — placeholder bash, exit 0
- `/Users/gtrush/Downloads/genie-2.0/src/core/dispatcher.mjs` — `TIER_MODELS` table replaced
- `/Users/gtrush/Downloads/genie-2.0/.env` — add `JELLYCLAW_BIN`, `JELLYCLAW_CONFIG_PATH=/Users/gtrush/.jellyclaw`, ensure `ANTHROPIC_API_KEY` is set
- `~/.jellyclaw/` (created at runtime by the script — do NOT commit)

### Migration script outline

```bash
#!/usr/bin/env bash
# scripts/migrate-from-claurst.sh
set -euo pipefail
DRY_RUN=${DRY_RUN:-0}
SRC="${HOME}/.claurst"
DST="${HOME}/.jellyclaw"

run() { [[ "$DRY_RUN" == "1" ]] && echo "DRY: $*" || eval "$*"; }

[[ -d "$SRC" ]] || { echo "No ~/.claurst — clean install"; SRC=""; }
run "mkdir -p $DST/{skills,hooks,sessions,traces}"

# Skills: symlink for zero-edit prompt compatibility (§5)
if [[ -n "$SRC" && -d "$SRC/skills" && ! -e "$DST/skills" ]]; then
  run "ln -s $SRC/skills $DST/skills"
fi
# Reverse symlink so $HOME/.claurst/skills resolves under jellyclaw too
if [[ -L "$SRC/skills" ]]; then
  echo "Already a symlink, skip"
elif [[ -d "$SRC/skills" && ! -L "$DST/skills" ]]; then
  : # we picked the forward direction above
fi

# Settings: transform Claurst → OpenCode shape
TEMPLATE="$(dirname "$0")/../.jellyclaw-config.template/settings.json"
if [[ ! -f "$DST/settings.json" ]]; then
  run "cp $TEMPLATE $DST/settings.json"
fi

# MCP config
TEMPLATE_MCP="$(dirname "$0")/../.jellyclaw-config.template/mcp.json"
[[ -f "$DST/mcp.json" ]] || run "cp $TEMPLATE_MCP $DST/mcp.json"

# Hook placeholders
for h in telegram-pre-bash telegram-post-bash; do
  HOOK="$DST/hooks/${h}.sh"
  [[ -f "$HOOK" ]] || run "cp $(dirname "$0")/../.jellyclaw-config.template/hooks/${h}.sh $HOOK && chmod +x $HOOK"
done

# Validate
node "$(dirname "$0")/validate-jellyclaw-settings.mjs" "$DST/settings.json"

echo "✅ Migration complete. ~/.jellyclaw is ready."
```

### `TIER_MODELS` patch (`dispatcher.mjs:118-123` region)

Replace the broken single-table block with the dual-provider table from §2.4:

```js
const TIER_MODELS = {
  anthropic: {
    simple:  'claude-haiku-4-5',
    website: 'claude-sonnet-4-6',
    browser: 'claude-sonnet-4-6',
    premium: 'claude-opus-4-6',
  },
  openrouter: {
    simple:  'qwen/qwen-2.5-72b-instruct:free',   // valid free slug (the old qwen3.6 was bogus)
    website: 'qwen/qwen3-coder',
    browser: 'anthropic/claude-sonnet-4.6',
    premium: 'anthropic/claude-opus-4.6',
  },
};
const modelTable = TIER_MODELS[provider] || TIER_MODELS.anthropic;
const model = process.env.GENIE_CLAUDE_MODEL ? process.env.GENIE_CLAUDE_MODEL
  : (modelTable[complexity] || modelTable.browser);
```

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
chmod +x scripts/migrate-from-claurst.sh
DRY_RUN=1 ./scripts/migrate-from-claurst.sh    # preview
./scripts/migrate-from-claurst.sh              # execute
ls -la ~/.jellyclaw/
node scripts/validate-jellyclaw-settings.mjs ~/.jellyclaw/settings.json
# Skill discovery smoke
jellyclaw run --print --config-dir ~/.jellyclaw -p "list available skills" \
  --output-format stream-json | head -50
# Patch the qwen bug (or run an `Edit` against dispatcher.mjs):
grep -n "qwen3.6-plus:free" /Users/gtrush/Downloads/genie-2.0/src/core/dispatcher.mjs
# After edit, confirm gone:
! grep -q "qwen3.6-plus" /Users/gtrush/Downloads/genie-2.0/src/core/dispatcher.mjs
```

### Expected output

- `~/.jellyclaw/settings.json` validates green against OpenCode 1.4.4 schema.
- `~/.jellyclaw/skills` exists (symlink to `~/.claurst/skills` when the latter is present).
- `jellyclaw run -p "list available skills"` lists the 5 Uber Eats skills + any others Genie has installed.
- `dispatcher.mjs` no longer references `qwen3.6-plus:free`; `grep` returns nothing.
- Genie smoke wish (manual): `GENIE_ENGINE=jellyclaw GENIE_PROVIDER=openrouter` runs a `simple` tier wish on the new free Qwen 2.5-72B without erroring on a bogus slug.

### Tests to add

- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/migration-script.test.mjs` — runs the script in `DRY_RUN=1` against a `mktemp -d` HOME, asserts the planned actions.
- `/Users/gtrush/Downloads/jellyclaw-engine/test/unit/settings-schema.test.mjs` — validates the template against the OpenCode 1.4.4 schema.
- `/Users/gtrush/Downloads/genie-2.0/test/tier-models.test.mjs` — asserts no slug ends in `:free` unless it's whitelisted (`qwen/qwen-2.5-72b-instruct:free`); asserts no slug contains `qwen3.6` (regression).

### Verification

```bash
node --test /Users/gtrush/Downloads/genie-2.0/test/tier-models.test.mjs
bun run test:unit --project=unit -- migration-script settings-schema
ls -l ~/.jellyclaw/skills    # confirms symlink target
```

### Common pitfalls

- **Symlink direction matters.** §5 chooses `~/.jellyclaw/skills → ~/.claurst/skills` so the genie-system.md prompt strings (`~/.claurst/skills/...`) keep resolving for the `Read` tool. If you reverse it, paths in the prompt break silently and Genie just doesn't find skills.
- **Playwright MCP version drift:** later `@playwright/mcp` versions changed CDP handshake. **Pin `0.0.41`**. Don't `npm install` without `--save-exact`.
- **OpenCode schema URL:** `https://opencode.ai/schema/1.4.4` — if the validator can't fetch it, vendor a local copy under `engine/schema/opencode-1.4.4.json`.
- **Hook scripts must be executable.** `chmod +x` is in the script — verify it actually ran by checking `stat -f %p` on the hook files (mode should include `755`).
- **`JELLYCLAW_CONFIG_PATH` MUST be absolute** — relative paths break under LaunchAgent contexts where cwd is `/`.
- **Don't migrate `~/.claurst/sessions/`** — those are Claurst's session files; jellyclaw has its own format. Resume across engines is not supported.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `12`
- `<phase-name>` → `Genie integration behind flag`
- `<sub-prompt>` → `03-skills-and-settings-migration`
- Do NOT mark Phase 12 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
