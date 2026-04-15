# Phase 12 — Genie integration behind flag — Prompt 01: Dispatcher refactor (`GENIE_ENGINE` flag)

**When to run:** Phase 11 marked ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 5-6 hours
**New session?** Yes
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions:
- `<NN>` → `12`
- `<phase-name>` → `Genie integration behind flag`
- `<sub-prompt>` → `01-dispatcher-refactor`
<!-- END SESSION STARTUP -->

## Research task

1. Read `phases/PHASE-12-genie-integration.md` end to end — this prompt covers Steps 1-4 and 6.
2. Read `integration/GENIE-INTEGRATION.md` §1, §2.1 (binary resolution), §2.2 (config path), §2.3 (provider validation), §2.4 (tier model table — note the qwen bug, fixed in Prompt 03), §2.5 (spawn args), §2.7 (stderr ring buffer), §2.8 (failover retry), §2.9 (trace filename).
3. Read `/Users/gtrush/Downloads/genie-2.0/src/core/dispatcher.mjs` end to end. Note the exact line ranges you will edit:
   - `:20-38` — Claurst binary resolution → replace with `ENGINE_BIN` selector
   - `:39` — config path constant → add `JELLYCLAW_CONFIG_PATH` after this line
   - `:102` — `PREMIUM_PATTERNS` regex routing — leave; tier classification stays
   - `:118-123` — `TIER_MODELS` (contains the `qwen/qwen3.6-plus:free` bug, deferred to Prompt 03)
   - `:247-260` — provider validation block — rewrite for Anthropic-first
   - `:293-312` — spawn arg builder + `child = spawn(CLAURST_BIN, …)` — split into two builders behind the flag
   - `:349-398` — `handleEvent` parser — leave for Prompt 02
   - `:422-432` — stderr capture — replace with ring buffer
4. Skim `/Users/gtrush/Downloads/genie-2.0/src/core/server.mjs` to confirm it doesn't import Claurst-specific symbols (it shouldn't; it only calls `dispatchToClaude`).

## Implementation task

Refactor `genie-2.0/src/core/dispatcher.mjs` so `GENIE_ENGINE=jellyclaw` (default in W3, opt-in here) routes through a new `buildArgsJellyclaw()` and a new `JELLYCLAW_BIN` resolver, while `GENIE_ENGINE=claurst` keeps every prior behavior byte-identical for one-line rollback. Event parser stays Claurst-shape this prompt — Prompt 02 rewrites it.

### Files to create/modify

- `/Users/gtrush/Downloads/genie-2.0/src/core/dispatcher.mjs` — primary edit
- `/Users/gtrush/Downloads/genie-2.0/.env.example` — add `GENIE_ENGINE`, `JELLYCLAW_BIN`, `JELLYCLAW_CONFIG_PATH`, `ANTHROPIC_API_KEY` documentation
- `/Users/gtrush/Downloads/genie-2.0/CLAUDE.md` — append a "GENIE_ENGINE flag" section (do not delete the Claurst section)
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/genie-integration.md` — line-by-line audit of every dispatcher edit (the doc PHASE-12 Step 1 expects)

### Edits to `dispatcher.mjs`

1. **Replace lines 20-38** with the dual-binary block from `integration/GENIE-INTEGRATION.md` §2.1. Define `GENIE_ENGINE`, `JELLYCLAW_BIN`, keep `CLAURST_BIN` legacy block, set `ENGINE_BIN = GENIE_ENGINE === 'claurst' ? CLAURST_BIN : JELLYCLAW_BIN`. Update `CLAURST_IS_PATH_LOOKUP` → `ENGINE_IS_PATH_LOOKUP`.
2. **Insert after line 39:** `const JELLYCLAW_CONFIG_PATH = process.env.JELLYCLAW_CONFIG_PATH || resolve(process.env.HOME, '.jellyclaw');`
3. **Replace lines 247-260** (provider validation) with the Anthropic-first block from §2.3. Keep it fail-loud when neither key set. Compute `fallbackProvider`.
4. **Around line 293-312:** Extract two arg builders:
   ```js
   function buildArgsClaurst({ model, provider, systemPrompt, maxTurns, maxBudget }) {
     return [
       '-p', '--model', model, '--provider', provider,
       '--append-system-prompt', systemPrompt,
       '--permission-mode', 'bypass-permissions',
       '--max-turns', String(maxTurns),
       '--max-budget-usd', String(maxBudget),
       '--output-format', 'stream-json',
       '--verbose',
       '--add-dir', REPO_ROOT,
     ];
   }
   function buildArgsJellyclaw({ model, provider, systemPrompt, maxTurns, maxBudget, sessionId, fallbackProvider }) {
     const a = [
       'run', '--print',
       '--model', model, '--provider', provider,
       '--append-system-prompt', systemPrompt,
       '--permission-mode', 'bypass',
       '--max-turns', String(maxTurns),
       '--max-cost-usd', String(maxBudget),
       '--output-format', 'stream-json',
       '--stream-stderr', 'jsonl',
       '--add-dir', REPO_ROOT,
       '--config-dir', JELLYCLAW_CONFIG_PATH,
       '--verbose',
     ];
     if (sessionId) a.push('--session-id', sessionId);
     if (fallbackProvider) a.push('--fallback-provider', fallbackProvider);
     return a;
   }
   const args = GENIE_ENGINE === 'claurst'
     ? buildArgsClaurst({ model, provider, systemPrompt, maxTurns, maxBudget })
     : buildArgsJellyclaw({ model, provider, systemPrompt, maxTurns, maxBudget,
                            sessionId: process.env.GENIE_RESUME_SESSION_ID, fallbackProvider });
   const child = spawn(ENGINE_BIN, args, { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
   ```
5. **Replace lines 422-432** (stderr capture) with the ring-buffer block from §2.7. Keep the legacy `stderrBuf` 100KB cap so existing failure paths still print a tail.
6. **Provider failover retry (§2.8):** wrap the spawn-and-await block in `attemptRun(provider)`. On exit code 2 AND `fallbackProvider` AND `toolCount === 0`, recurse once. Hard cap: 1 failover.
7. **Trace filename (§2.9):** `const traceFile = resolve(TRACE_DIR, \`dispatch-${GENIE_ENGINE}-${Date.now()}.jsonl\`);`

### Shell commands

```bash
cd /Users/gtrush/Downloads/genie-2.0
node --check src/core/dispatcher.mjs
# Smoke claurst path (existing behavior unchanged):
GENIE_ENGINE=claurst node -e "import('./src/core/dispatcher.mjs').then(m=>console.log('ok'))"
# Smoke jellyclaw path (binary may not exist yet — Prompt 03 installs it):
GENIE_ENGINE=jellyclaw JELLYCLAW_BIN=/usr/local/bin/jellyclaw node -e "import('./src/core/dispatcher.mjs').then(m=>console.log('ok'))"
# Diff the change set:
git -C /Users/gtrush/Downloads/genie-2.0 diff src/core/dispatcher.mjs
```

### Expected output

- `node --check` clean.
- `GENIE_ENGINE=claurst` produces a spawn args array byte-equal to the pre-refactor list (assert via a tiny test in `genie-2.0/test/dispatcher-args.test.mjs`).
- `GENIE_ENGINE=jellyclaw` produces the kebab-case OpenCode args list per §2.5.
- Failover wrapper unit-tested with a mock `spawn` that returns exit 2.
- `docs/genie-integration.md` (in jellyclaw-engine) has line-numbered references to every edit.

### Tests to add

- `/Users/gtrush/Downloads/genie-2.0/test/dispatcher-args.test.mjs` — asserts both arg builders byte-for-byte.
- `/Users/gtrush/Downloads/genie-2.0/test/dispatcher-failover.test.mjs` — mock spawn → exit 2 → fallback path runs.
- `/Users/gtrush/Downloads/genie-2.0/test/dispatcher-stderr-ring.test.mjs` — feed 100 JSONL stderr lines, assert ring length === 50, last 10 returned correctly on failure.

### Verification

```bash
cd /Users/gtrush/Downloads/genie-2.0
node --test test/dispatcher-args.test.mjs test/dispatcher-failover.test.mjs test/dispatcher-stderr-ring.test.mjs
GENIE_ENGINE=claurst node src/core/server.mjs &  # confirm boot still works
sleep 3 && curl -s http://127.0.0.1:$GENIE_PORT/health
kill %1
```

### Common pitfalls

- **`spawn(ENGINE_BIN, args)` with `ENGINE_IS_PATH_LOOKUP=true` passes a bare name** — works on macOS, but if PATH is empty (e.g., LaunchAgent context) it fails. The legacy code's `which` pre-flight (lines 232-238) must be retained for both engines.
- **`--max-budget-usd` vs `--max-cost-usd`:** if you accidentally pass the Claurst flag to jellyclaw, jellyclaw exits 64 (usage error). The arg builders MUST be selected by `GENIE_ENGINE`, never mixed.
- **`--append-system-prompt` accepts a string in jellyclaw, not an `@/path/to/file`** — confirm before passing the full file contents (it's already a `readFileSync` in the existing code at line 281, so this is fine).
- **`--config-dir` is mandatory for jellyclaw** if you want skills/MCP discovered; without it jellyclaw silently runs with no MCP and no skills, which looks like a working run until the wish needs the browser.
- **Resume session flag:** `process.env.GENIE_RESUME_SESSION_ID` should be unset for fresh wishes; never read it from the wish object.
- **Don't delete the Claurst code path this prompt** — W4 (Prompt 03 of Phase 13 follow-on) is when it goes. This prompt is the additive, reversible refactor.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions:
- `<NN>` → `12`
- `<phase-name>` → `Genie integration behind flag`
- `<sub-prompt>` → `01-dispatcher-refactor`
- Do NOT mark Phase 12 complete. Append a session-log row.
<!-- END SESSION CLOSEOUT -->
