---
phase: 05
name: "Skills system"
duration: "1.5 days"
depends_on: [01]
blocks: [11, 12]
---

# Phase 05 — Skills system

## Dream outcome

Drop a markdown file with YAML frontmatter into `~/.jellyclaw/skills/`, `.jellyclaw/skills/`, or (for Genie compat) `.claude/skills/`, and it is discovered on the next turn without restart. Skills are injected at the **system prompt** level via progressive disclosure — only the trigger description is shown until invoked, keeping context lean. `$ARGUMENTS` substitution works. This closes a known OpenCode gap.

## Deliverables

- `engine/src/skills/discovery.ts` — filesystem walker + watcher
- `engine/src/skills/parser.ts` — YAML frontmatter + body parsing
- `engine/src/skills/substitution.ts` — `$ARGUMENTS` + `$1..$9` + `$CLAUDE_PROJECT_DIR`
- `engine/src/skills/registry.ts` — in-memory registry with invalidation
- `engine/src/skills/inject.ts` — system-prompt injection (1536 char cap per skill)
- Unit + integration tests
- `docs/skills.md`

## Step-by-step

### Step 1 — Skill file format
```markdown
---
name: commit
description: Create a git commit following repo conventions
trigger: "when the user says 'commit', '/commit', or asks to create a commit"
allowed_tools: [Bash, Read, Grep]
---

Run `git status`, `git diff`, draft a message, then `git commit`.
$ARGUMENTS applies as extra instructions.
```

### Step 2 — Discovery
`engine/src/skills/discovery.ts` walks paths in config order (user → project → legacy `.claude/skills/`). De-dup by `name` (first wins). Use `chokidar` for watch mode.

### Step 3 — Parser
Use `gray-matter`. Validate frontmatter with Zod:
```ts
export const SkillFrontmatter = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().max(200),
  trigger: z.string().optional(),
  allowed_tools: z.array(z.string()).optional()
});
```

### Step 4 — Substitution
- `$ARGUMENTS` → full arg string
- `$1..$9` → positional
- `$CLAUDE_PROJECT_DIR` → cwd (Genie compat)
- Unknown `$VAR` → leave as literal + warn once

### Step 5 — Progressive disclosure
At system-prompt build time, inject only: `skill: <name> — <description>` (≤1536 chars total for all skill descriptions). Full body is added to context only when a turn invokes the skill. Implement as a mid-turn injection via a `use_skill` tool OR by pre-fetching when the model's first message names a known skill.

### Step 6 — Registry + watcher
Registry maps `name → { frontmatter, body, path, mtime }`. Watcher invalidates on change. Emits `session.update` event with `{ skills_changed: [...] }`.

### Step 7 — Tests
- Discovery: 3 dirs with overlapping names → first wins.
- Parser: invalid frontmatter → error with path + line.
- Substitution: `$ARGUMENTS` substitutes correctly with empty args.
- Watcher: modify → registry updated within 1 s.
- Integration: run a turn that invokes a skill, assert body appears in transcript.

## Acceptance criteria

- [ ] Skills discovered from all 3 default paths
- [ ] `.claude/skills/` fallback works unchanged for existing Genie users
- [ ] `$ARGUMENTS` substitution verified
- [ ] 1536 char cap enforced (with truncation warning)
- [ ] Watcher updates registry <1 s after file change
- [ ] Integration test: skill-triggered turn succeeds

## Risks + mitigations

- **Naming conflicts across dirs** → first-match wins; log a warning listing shadowed paths.
- **Large skill bodies blow token budget** → enforce per-skill body cap (e.g., 8 KB); error at load time.
- **Windows path quirks** (for future cross-platform) → use `path.posix` for matching, `path` for IO.

## Dependencies to install

```
gray-matter@^4.0
chokidar@^4.0
```

## Files touched

- `engine/src/skills/{discovery,parser,substitution,registry,inject}.ts`
- `engine/src/skills/*.test.ts`
- `docs/skills.md`
- `skills/` (optional example skills in-repo)
