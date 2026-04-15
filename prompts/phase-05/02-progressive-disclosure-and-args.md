# Phase 05 — Skills system — Prompt 02: Progressive disclosure, $ARGUMENTS, and watcher

**When to run:** After Phase 05 prompt 01 is ✅ in `COMPLETION-LOG.md` (skills discovery + loader + registry exist and tests pass).
**Estimated duration:** 3–4 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- Covers: read README, MASTER-PLAN, COMPLETION-LOG, STATUS, PHASE-05-skills.md; verify env. STOP if Phase 05 prompt 01 not complete. -->
<!-- END paste -->

## Research task

1. Re-read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-05-skills.md`, Steps 4–6 (substitution, progressive disclosure, watcher).
2. Re-read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` — find the system-prompt assembly section; understand where skill descriptions are injected.
3. Read the Phase 05 prompt 01 deliverables you just built: `engine/src/skills/{types,discovery,parser,registry,index}.ts`.
4. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/events/` (or wherever `session.update` events are emitted) to wire the `skills_changed` event.
5. Read how Claude Code's skills use `$ARGUMENTS`. Key semantics to replicate exactly:
   - `$ARGUMENTS` → entire arg string passed by the model when invoking the skill.
   - `$1`..`$9` → positional args (space-split, first 9).
   - `$CLAUDE_PROJECT_DIR` → current working directory (Genie compat; keep the `CLAUDE_` prefix even though we are jellyclaw — consumers expect this name).
   - Unknown `$VAR` → leave literal in output, log a `warn` once per skill load.
6. `chokidar@^4` docs: understand that v4 dropped glob support — use plain paths + `ignored` matcher instead.

## Implementation task

Add three capabilities to the skills subsystem from prompt 01:
1. Progressive-disclosure **aggregate cap** + system-prompt injection helper.
2. `$ARGUMENTS` / `$1..$9` / `$CLAUDE_PROJECT_DIR` substitution.
3. Filesystem watcher that invalidates the registry and emits `session.update { skills_changed }`.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/substitution.ts` — pure function: `substitute(body, { args, projectDir }): { output, unknown: string[] }`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/inject.ts` — build the trigger-description block to inject into the system prompt. Enforce a **total** cap of 1536 chars across ALL skill descriptions combined. When exceeded: sort by source priority (user > project > legacy), then alphabetical; include highest-priority until cap; emit one warn log with the dropped skills.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/watcher.ts` — chokidar watcher with debounce (250 ms) that calls `registry.reload()`; emits `skills.changed` event with `{ added: string[], removed: string[], modified: string[] }`.
- Modify `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/registry.ts` — add `reload()`, `subscribe(listener)`.
- Modify `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/index.ts` — re-export new surface.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/substitution.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/inject.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/watcher.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/skills.md` — user-facing doc; explain file format, search paths, substitution, caps.
- Add example skills at `/Users/gtrush/Downloads/jellyclaw-engine/skills/commit/SKILL.md` and `/Users/gtrush/Downloads/jellyclaw-engine/skills/review/SKILL.md`.

### Substitution rules (match exactly)

```ts
// pseudo
const out = body
  .replace(/\$ARGUMENTS/g, args ?? "")
  .replace(/\$([1-9])/g, (_, i) => positionalArgs[i-1] ?? "")
  .replace(/\$CLAUDE_PROJECT_DIR/g, projectDir);
// then collect remaining $VAR occurrences (regex /\$[A-Z_][A-Z0-9_]*/g) into `unknown`
```

- Escape sequence: `\$` → literal `$` (optional, but add a test).
- Do NOT interpret shell variables, env vars, or JS templates. This is not `eval`.

### Injection format (exact)

For each kept skill, output one line in the injected block:

```
- skill:<name> — <description>
```

Preface with a single line `# Available skills (invoke by name via the use_skill tool):`. Total block ≤ 1536 chars.

### Watcher behavior

- Watch every directory actually resolved by discovery (user + project + legacy, ignoring any that don't exist; but subscribe to parent so creating the dir later is picked up).
- Debounce 250 ms; re-run full discovery on any fire; diff against previous registry snapshot; emit `{added, removed, modified}`.
- On error (EACCES, ENOENT on unlink race), log warn and continue — never crash.
- Expose `stop()` for graceful shutdown in tests.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun run typecheck
bun run test engine/src/skills
bun run lint
```

### Expected output

- All skill tests pass, including watcher debounce/reload.
- System-prompt preview harness (write a quick `engine/scripts/inject-preview.ts`) prints the injected block for the example skills.

### Tests to add

- `substitution.test.ts`:
  - `$ARGUMENTS` substitutes with empty args → empty string (not the literal `$ARGUMENTS`).
  - Positional: `$1 $2` with args `"alpha beta"` → `"alpha beta"`.
  - `$CLAUDE_PROJECT_DIR` substitutes to the injected cwd.
  - Unknown `$FOO` → kept literal; `unknown` array contains `"FOO"`.
- `inject.test.ts`:
  - Under cap → all skills present in order.
  - Over cap → drops lowest-priority, includes a warn log, never exceeds 1536 chars.
  - Priority: user source beats project beats legacy.
- `watcher.test.ts`:
  - Write a new skill file → within 1000 ms the listener fires with `{added: [name]}`.
  - Modify body → `{modified: [name]}`.
  - Delete → `{removed: [name]}`.
  - Stop watcher; no further events fire.

Use `node:fs/promises` and `os.tmpdir()` for watcher tests; `setTimeout`-based polling is fine, but cap total wait at 2 s per assertion so CI doesn't hang.

### Verification

```bash
bun run test engine/src/skills    # expect: all green
bun run typecheck                 # expect: clean
bun run lint                      # expect: clean

# Smoke: watcher + injection
mkdir -p ~/.jellyclaw/skills/demo
cat > ~/.jellyclaw/skills/demo/SKILL.md <<'EOF'
---
name: demo
description: Demo skill to verify injection
---
Body with $ARGUMENTS interpolation.
EOF
bun run tsx engine/scripts/inject-preview.ts    # expect: prints block containing "skill:demo — Demo skill..."
```

### Common pitfalls

- `chokidar@4` fires `add` for files found during initial scan — suppress those when you already loaded them via discovery.
- Debounce must be per-registry, not per-file; otherwise rapid multi-file saves produce a storm of events.
- 1536 cap is **bytes of the rendered block**, not character count; UTF-8 em-dash is 3 bytes.
- Listeners can throw — wrap in try/catch, log, don't unsubscribe.
- On macOS, `fs.watch` underneath chokidar can miss rapid rename cycles; rely on chokidar's `awaitWriteFinish: { stabilityThreshold: 100 }`.
- Do not build the injection string inside a hot path without memoizing — cache keyed by registry version.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: mark Phase 05 fully ✅ in COMPLETION-LOG.md (both sub-prompts done), update STATUS.md to "Phase 06 next", commit `docs: phase 05 complete`, suggest `prompts/phase-06/01-subagent-definitions.md`. -->
<!-- END paste -->
