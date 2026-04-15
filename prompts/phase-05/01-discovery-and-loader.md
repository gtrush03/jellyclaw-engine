# Phase 05 — Skills system — Prompt 01: Discovery and loader

**When to run:** After Phase 04 (tool parity) is marked ✅ in `COMPLETION-LOG.md`. This is the first prompt of Phase 05.
**Estimated duration:** 2–3 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- The startup template covers: read README, MASTER-PLAN, COMPLETION-LOG, STATUS, phases/PHASE-05-skills.md; verify cwd / bun / node / .env / dist; confirm current phase matches expectations; STOP if mismatched. -->
<!-- END paste -->

## Research task

**Before writing any code**, read and internalize these files in this order. Do not skip.

1. `/Users/gtrush/Downloads/jellyclaw-engine/MASTER-PLAN.md` — full picture.
2. `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` — authoritative contract. Pay attention to how skills feed the system prompt.
3. `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — note anything about file-read boundaries (`~/.jellyclaw` vs `.jellyclaw` vs `.claude`).
4. `/Users/gtrush/Downloads/jellyclaw-engine/engine/PROVIDER-STRATEGY.md` — background only.
5. `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-05-skills.md` — the phase doc. Read every step.
6. `/Users/gtrush/Downloads/jellyclaw-engine/CLAUDE.md` — repo conventions: strict TS, Zod, pino, `import type`, kebab-case files.
7. Existing config loader: run `ls engine/src/config/` then read any discovery/path-resolution helpers that already exist — reuse them for path expansion (`~`).

Then look at how Claude Code / Genie use `.claude/skills/`:
- Run `Grep` for the string `.claude/skills` in `/Users/gtrush/Downloads/jellyclaw-engine/` to see any existing references.
- Note: the legacy `.claude/skills/` path MUST be supported for Genie backward-compat.

Document findings in scratch notes but **do not** write code until the research step is fully done.

## Implementation task

Implement skill file **discovery** and **loading** (parsing + validation + in-memory registry). Do NOT implement progressive disclosure, `$ARGUMENTS` substitution, or filesystem watching yet — those are prompt 02.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/types.ts` — `Skill`, `SkillFrontmatter` (Zod), `SkillSource` (`"user"|"project"|"legacy"`).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/discovery.ts` — walk three search paths in order, return a list of skill file paths with source tag.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/parser.ts` — parse `SKILL.md` (or `*.md`) using `gray-matter`, validate frontmatter with Zod, enforce per-skill body cap of 8 KB (error on violation with file path).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/registry.ts` — in-memory `Map<name, Skill>`; first-match wins across `user → project → legacy`; log a warning for shadowed paths.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/index.ts` — barrel re-export.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/discovery.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/parser.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/skills/registry.test.ts`
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/package.json` — add deps.

### Semantics to match

- **Search order:** `~/.jellyclaw/skills/` → `${cwd}/.jellyclaw/skills/` → `${cwd}/.claude/skills/` (legacy).
- **File shapes supported:** both `<dir>/<name>/SKILL.md` (directory-per-skill) AND `<dir>/<name>.md` (flat). Directory-per-skill wins if both exist for the same name.
- **Frontmatter schema (Zod):**
  ```ts
  z.object({
    name: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string().min(1).max(1536), // full cap, enforced here
    trigger: z.string().optional(),
    allowed_tools: z.array(z.string()).optional(),
  })
  ```
  Note: the 1536-char cap is per-skill description. The *aggregate* cap is enforced in prompt 02.
- **Dedup:** first source to register a given `name` wins. Subsequent definitions are dropped with a single warn log listing the shadowed path.
- **Errors:** invalid frontmatter, missing `name`, body >8 KB, or duplicate `name` WITHIN a single source directory → throw a typed `SkillLoadError` with `{ path, reason }` and continue loading the rest (do NOT abort the whole engine).

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add gray-matter@^4.0 chokidar@^4.0   # chokidar is for prompt 02 but pin now
bun run typecheck
bun run test engine/src/skills
bun run lint
```

### Expected output

- All three test files pass.
- `bun run typecheck` clean.
- `bun run lint` clean.
- Registry exposes a `list(): Skill[]`, `get(name): Skill | undefined`, and `loadAll(opts): Promise<void>`.

### Tests to add

- `discovery.test.ts` — fixture with 3 temp dirs containing overlapping skills; assert order + dedup + shadow warning.
- `parser.test.ts` — valid frontmatter parses; invalid (bad name regex, missing description, description > 1536) throws `SkillLoadError`; body > 8 KB throws.
- `registry.test.ts` — load from fixtures, assert first-wins; `get("unknown")` returns `undefined`.

Use `os.tmpdir()` + `fs.mkdtempSync` for fixtures; clean up in `afterEach`.

### Verification

```bash
bun run test engine/src/skills    # expect: all tests pass, 0 failures
bun run typecheck                 # expect: no output (success)
bun run lint                      # expect: no errors
```

Create one real example skill to smoke-test the loader:

```bash
mkdir -p ~/.jellyclaw/skills/hello
cat > ~/.jellyclaw/skills/hello/SKILL.md <<'EOF'
---
name: hello
description: Sample skill used to smoke-test the loader
---
Say hello.
EOF
bun run dev -- --skills-dump    # if no CLI flag yet, write a one-off script engine/scripts/skills-dump.ts
```

You should see `hello` listed with source `user`.

### Common pitfalls

- `gray-matter` silently tolerates malformed YAML — always revalidate with Zod after.
- `~` in paths: use `os.homedir()`, never trust raw `~` in path strings.
- On macOS/Linux, `fs.readdir` returns arbitrary order — sort for deterministic tests.
- Body size cap: measure in **bytes** (`Buffer.byteLength(body, 'utf8')`), not characters.
- Do NOT `console.log`. Use pino from `engine/src/logger.ts`.
- `import type` for Zod inferred types; runtime imports for schemas themselves.
- Tests must NOT touch the real `~/.jellyclaw/skills/` — always inject a base path override.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- Covers: update COMPLETION-LOG.md (mark sub-prompt 05.01 checked, Phase 05 status 🔄), update STATUS.md, commit `docs: phase 05 discovery-and-loader progress`, tell user what landed + next prompt (`prompts/phase-05/02-progressive-disclosure-and-args.md`). -->
<!-- END paste -->
