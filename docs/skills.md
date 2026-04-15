# Skills

Skills are markdown files with YAML frontmatter that the engine injects into
the model's system prompt via progressive disclosure. A skill advertises
itself as a one-line `skill:<name> — <description>` entry; the full body is
only included when the model invokes the skill.

## File format

```markdown
---
name: commit
description: Create a git commit following repo conventions
trigger: "when the user says 'commit' or asks to create a commit"
allowed_tools: [Bash, Read, Grep]
---

Run `git status`, `git diff`, draft a message, then `git commit`.
$ARGUMENTS apply as extra instructions.
Working from $CLAUDE_PROJECT_DIR.
```

### Frontmatter schema

| Field           | Type                | Required | Notes                                                   |
|-----------------|---------------------|----------|---------------------------------------------------------|
| `name`          | string (kebab-case) | yes      | Matches `/^[a-z0-9-]+$/`                                |
| `description`   | string              | yes      | 1 – 1536 characters                                     |
| `trigger`       | string              | no       | Free-form hint describing when the skill should invoke  |
| `allowed_tools` | string[]            | no       | Tool names; enforced in later phases                    |

### Body

Markdown body, capped at **8 KB** measured in UTF-8 bytes. If you exceed the
cap the skill is rejected at load time.

## Search paths

Skills are discovered from three roots, in order. Duplicates are deduped by
`name`; the first root to define a name wins.

| Order | Path                          | Source    | Purpose                       |
|-------|-------------------------------|-----------|-------------------------------|
| 1     | `~/.jellyclaw/skills/`        | `user`    | Your personal library         |
| 2     | `<cwd>/.jellyclaw/skills/`    | `project` | Repo-scoped skills            |
| 3     | `<cwd>/.claude/skills/`       | `legacy`  | Genie/Claude Code compat      |

### File shapes

Both layouts are supported. When both exist for the same name **within a
single root**, the directory form wins.

```
~/.jellyclaw/skills/commit/SKILL.md          # directory form (recommended)
~/.jellyclaw/skills/commit.md                # flat form
```

## Substitution

Skill bodies support a small set of substitutions. Nothing else is
interpreted — no shell, no env, no `eval`.

| Placeholder            | Replaced with                                     |
|------------------------|---------------------------------------------------|
| `$ARGUMENTS`           | The full argument string the model passed         |
| `$1` .. `$9`           | Positional args (space-split from `$ARGUMENTS`)   |
| `$CLAUDE_PROJECT_DIR`  | Current working directory (kept for Genie compat) |
| `\$`                   | Literal `$` (escape)                              |

Unknown `$VAR` names that look variable-like (uppercase-leading) are kept
literal in the output and reported back to the caller so the engine can warn
once per load.

## Progressive disclosure

At system-prompt build time, the engine injects a compact block describing
the available skills:

```
# Available skills (invoke by name via the use_skill tool):
- skill:commit — Create a git commit following repo conventions
- skill:review — Review recent changes on the current branch
...
```

The block is capped at **1536 UTF-8 bytes** across ALL descriptions combined
(per-skill descriptions are also individually capped at 1536 chars, so the
total is always reachable). When the cap would be exceeded, skills are
dropped in priority order:

1. `user` sources are kept before `project`, which are kept before `legacy`.
2. Within a source, skills are alphabetised.
3. Greedy packing: a skill that does not fit is dropped, but later skills
   are still considered — a short description after a long one can still
   make it in.

Dropped skills appear in a single `logger.warn` call and are never injected.

## Watching

The engine watches the three search roots (via chokidar) with a 250 ms
debounce. When files change, the registry reloads and emits a
`SkillsChangedEvent`:

```ts
interface SkillsChangedEvent {
  added: string[];    // newly discovered skill names
  removed: string[];  // skills whose file was deleted or moved away
  modified: string[]; // same name, different path or mtime
}
```

Subscribe with `registry.subscribe(listener)`. Listener errors are caught
and logged — they never propagate to the caller of `reload()`.

## Quick API

```ts
import { SkillRegistry, SkillWatcher, buildSkillInjection, substitute } from "@jellyclaw/engine/skills";

const registry = new SkillRegistry();
await registry.loadAll();

const { block } = buildSkillInjection({ skills: registry.list() });
// ^ inject `block` into your system prompt

const { output, unknown } = substitute(skill.body, { args: userArgs, projectDir: process.cwd() });

const watcher = new SkillWatcher({ registry });
await watcher.start();
const unsub = registry.subscribe(({ added, removed, modified }) => { /* ... */ });
// on shutdown:
unsub();
await watcher.stop();
```

## Built-in examples

The repo ships a couple of starter skills under `skills/`:

- `skills/commit/SKILL.md` — draft a conventional-commits message
- `skills/review/SKILL.md` — review the current branch's diff

These are not auto-loaded from the repo; copy them into
`~/.jellyclaw/skills/` or `<repo>/.jellyclaw/skills/` to enable them.
