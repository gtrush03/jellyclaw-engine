---
name: commit
description: Create a git commit following repo conventions (conventional commits, present-tense subject, body under 72 cols)
trigger: "when the user says 'commit', '/commit', or asks to create a git commit"
allowed_tools: [Bash, Read, Grep]
---

Check working-tree state, stage the intended files, and produce a commit
following this repo's Conventional Commits style.

Steps:
1. Run `git status` and `git diff --staged` (and unstaged if nothing is staged).
2. Run `git log -10 --oneline` to match prior commit style.
3. Draft a one-line subject: `type(scope): summary` where `type` is one of
   feat/fix/chore/docs/test/ci/refactor.
4. If the change is non-trivial, add a body explaining the WHY.
5. Run `git commit` with the drafted message.

$ARGUMENTS apply as extra instructions (e.g. scope hints or a subject prefix).
Working from $CLAUDE_PROJECT_DIR.
