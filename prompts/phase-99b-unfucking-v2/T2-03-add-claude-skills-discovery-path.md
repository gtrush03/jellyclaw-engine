---
id: T2-03-add-claude-skills-discovery-path
tier: 2
title: "Add ~/.claude/skills to skill discovery roots"
scope:
  - "engine/src/skills/discovery.ts"
  - "engine/src/skills/discovery.test.ts"
depends_on_fix: []
tests:
  - name: discovers-user-claude-skills
    kind: shell
    description: "a skill dropped into ~/.claude/skills/<name>/SKILL.md is discovered under source=legacy-user"
    command: "bun run test engine/src/skills/discovery -t user-claude-root"
    expect_exit: 0
    timeout_sec: 30
  - name: discovery-ordering-stable
    kind: shell
    description: "precedence stays user > project > legacy-user > legacy-project; no collision regression"
    command: "bun run test engine/src/skills/discovery -t ordering"
    expect_exit: 0
    timeout_sec: 30
human_gate: false
max_turns: 25
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 20
---

# T2-03 — Add `~/.claude/skills` to the skill discovery roots

## Context
Claude Code stores user-scoped skills at `~/.claude/skills/<name>/SKILL.md`. George (and most Claude Code users) have already populated this directory. jellyclaw's `discoverSkills()` walks `~/.jellyclaw/skills`, `./.jellyclaw/skills`, and `./.claude/skills` — but NOT `~/.claude/skills`. Every user-scoped Claude skill is invisible to the engine.

## Root cause (from audit)
- `engine/src/skills/discovery.ts:24-33` — `defaultRoots()` returns exactly three entries:
  ```
  { home/.jellyclaw/skills, source: "user" }
  { cwd/.jellyclaw/skills, source: "project" }
  { cwd/.claude/skills,    source: "legacy" }
  ```
  The user-scoped Claude Code path `join(home, ".claude", "skills")` is not in the list.
- `engine/src/skills/types.ts` — `SkillSource` is currently `"user" | "project" | "legacy"`. No distinct bucket exists for a user-scoped legacy source.

## Fix — exact change needed
1. **`engine/src/skills/types.ts`** — extend the `SkillSource` union with `"legacy-user"` (keep existing `"legacy"` for cwd-local `./.claude/skills`, renamed in docstring to "project-legacy" without changing the enum value so other code stays untouched). Also update `SOURCE_PRIORITY` in `engine/src/skills/inject.ts:33-37` to include `"legacy-user": 2` and bump the existing `legacy: 3`.
2. **`engine/src/skills/discovery.ts:24-33`** — replace the three-entry `defaultRoots` with four entries in exactly this order:
   ```
   { home/.jellyclaw/skills, source: "user" }
   { cwd /.jellyclaw/skills, source: "project" }
   { home/.claude/skills,    source: "legacy-user" }
   { cwd /.claude/skills,    source: "legacy" }
   ```
   Use `join(home, ".claude", "skills")` for the new entry. Keep all file-walk logic unchanged — it is source-agnostic.
3. **Tests** (`engine/src/skills/discovery.test.ts`):
   - New case `user-claude-root` — set `home` to a tmp dir, drop `${home}/.claude/skills/mytest/SKILL.md` with a valid frontmatter body, assert `discoverSkills({home, cwd: tmpCwd})` returns an entry `{ name:"mytest", source:"legacy-user", path: "<home>/.claude/skills/mytest/SKILL.md" }`.
   - Update existing `ordering` test to expect the new four-root priority. A same-named skill present in `~/.jellyclaw/skills`, `~/.claude/skills`, and `./.claude/skills` must resolve via priority to the `user` copy; removing the user copy exposes the `legacy-user` copy before the `legacy` (cwd) copy.

## Acceptance criteria
- `discovers-user-claude-skills` — new root is walked (maps to test 1).
- `discovery-ordering-stable` — priority user > project > legacy-user > legacy holds; no regressions (maps to test 2).
- `bun run lint` stays clean (no new `console.log`, no `any`).

## Out of scope
- Do NOT parse the skill frontmatter here — that is `registry.ts`'s job.
- Do NOT remove any existing root. The cwd `./.claude/skills` path (`source: "legacy"`) stays.
- Do NOT change the injection byte cap behaviour in `inject.ts` — only the `SOURCE_PRIORITY` map.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run test engine/src/skills
bun run lint
```
