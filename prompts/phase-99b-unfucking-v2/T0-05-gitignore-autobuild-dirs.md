---
id: T0-05-gitignore-autobuild-dirs
tier: 0
title: "gitignore .autobuild/, .orchestrator/, logs/"
scope:
  - ".gitignore"
depends_on_fix: []
tests:
  - name: gitignore-contains-autobuild
    kind: shell
    description: ".gitignore has an entry for .autobuild/"
    command: "grep -x '.autobuild/' .gitignore"
    expect_exit: 0
  - name: gitignore-contains-orchestrator
    kind: shell
    description: ".gitignore has an entry for .orchestrator/"
    command: "grep -x '.orchestrator/' .gitignore"
    expect_exit: 0
  - name: gitignore-contains-logs
    kind: shell
    description: ".gitignore has an entry for logs/"
    command: "grep -x 'logs/' .gitignore"
    expect_exit: 0
  - name: check-ignore-matches
    kind: shell
    description: "git check-ignore confirms the directories are matched"
    command: "git check-ignore -q .autobuild/foo && git check-ignore -q .orchestrator/bar && git check-ignore -q logs/baz"
    expect_exit: 0
human_gate: false
max_turns: 5
max_cost_usd: 1
max_retries: 3
estimated_duration_min: 2
---

# T0-05 — gitignore autobuild / orchestrator / logs dirs

## Context
The autobuild rig writes worker transcripts, tmux scrollback, and orchestrator state into `.autobuild/` and `.orchestrator/` at the repo root. A `logs/` directory is already referenced by `*.log` but not as a whole-directory rule. These must be ignored before the rig runs, otherwise `git status` floods with untracked binaries.

## Root cause (from audit)
- Current `.gitignore` ignores `*.log` (line 27) but not the `logs/` directory wholesale.
- `.autobuild/` and `.orchestrator/` are not mentioned at all; they will be committed by accident.

## Fix — exact change needed
1. Append the following block to the end of `.gitignore` (preserve the existing "Scratch" comment block at the file's tail — add the new block ABOVE it if necessary, or append after, either is fine as long as the entries are present on their own lines):
   ```
   # Autobuild rig
   .autobuild/
   .orchestrator/
   logs/
   ```
2. Do not reorder or delete existing entries.

## Acceptance criteria
- `.gitignore` contains the exact lines `.autobuild/`, `.orchestrator/`, and `logs/` (maps to the three `gitignore-contains-*` tests).
- `git check-ignore` confirms paths inside those directories are ignored (maps to `check-ignore-matches`).

## Out of scope
- Do not modify any other file.
- Do not remove existing patterns even if they seem redundant (`*.log` stays).
- Do not add `.env*` patterns (already present).

## Verification the worker should self-run before finishing
```bash
grep -x '.autobuild/' .gitignore
grep -x '.orchestrator/' .gitignore
grep -x 'logs/' .gitignore
git check-ignore -q .autobuild/anything && echo "autobuild ignored"
git check-ignore -q .orchestrator/anything && echo "orchestrator ignored"
git check-ignore -q logs/anything && echo "logs ignored"
```
