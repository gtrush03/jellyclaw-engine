---
name: review
description: Review recent changes on the current branch for correctness, style, and missing tests before commit or PR
trigger: "when the user says 'review', '/review', or asks for a code review of current changes"
allowed_tools: [Bash, Read, Grep, Glob]
---

Produce a focused review of the staged and unstaged diff on the current
branch. Do NOT attempt to fix anything — just report.

Checklist:
1. `git diff` (staged + unstaged) and identify every changed file.
2. For each file, call out:
   - Obvious bugs or logic errors
   - Violations of repo conventions in `CLAUDE.md`
   - Missing or weak test coverage
   - TODOs/FIXMEs introduced
3. Finish with a bulleted summary: blockers, nits, suggested follow-ups.

$ARGUMENTS focus the review (e.g. "security only", "just the tests").
Root: $CLAUDE_PROJECT_DIR.
