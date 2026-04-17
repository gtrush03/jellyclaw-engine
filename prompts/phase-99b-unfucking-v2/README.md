# phase-99b-unfucking-v2 — T0 Boot-Hygiene Fix Pack

This directory holds a **Fix Pack**: a set of small, independently-executable prompts designed to be run by autonomous Claude Code workers inside tmux sessions, then verified by an automated tester that drives the `jellyclaw` CLI.

## Scope

Each prompt in this pack targets a single boot-hygiene defect that prevents the jellyclaw engine from starting cleanly. Nothing in this pack adds features; every prompt repairs a broken baseline.

## Tier ordering

Prompts are tier-prefixed. The autobuild rig schedules them oldest-tier-first:

- **T0** — Boot hygiene. The engine cannot start / bins silently no-op / repo leaks state. Run these before anything else. Prompts in this directory are all T0.
- **T1** — Correctness defaults (agent-loop limits, provider retries). Not in this pack.
- **T2+** — Feature work.

A prompt's `depends_on_fix:` field is an array of other prompt ids that must complete first. The rig topologically sorts within a tier.

## Prompt index

| id | title |
| --- | --- |
| T0-01-fix-serve-shim | Fix jellyclaw-serve shim entry-path check |
| T0-02-serve-reads-credentials | serve reads ANTHROPIC_API_KEY from ~/.jellyclaw/credentials.json |
| T0-03-fix-hardcoded-model-id | Replace hardcoded claude-opus-4-6 with real model + resolver |
| T0-04-thread-cli-flags | Thread --max-turns / --max-cost-usd / permission / tool flags into runAgentLoop |
| T0-05-gitignore-autobuild-dirs | gitignore .autobuild/, .orchestrator/, logs/ |

## Frontmatter spec

Every prompt starts with YAML frontmatter. Required keys:

```yaml
id: T0-NN-kebab-case           # unique, tier-prefixed
tier: 0                         # integer; matches id prefix
title: "Human-readable title"
scope:                          # glob patterns; worker must only touch these
  - "engine/src/cli/main.ts"
depends_on_fix: []              # prompt ids that must complete first
tests:
  - name: machine-readable-name
    kind: jellyclaw-run         # or: smoke-suite | http-roundtrip | shell
    description: "what this test proves"
    # kind-specific fields below
    command: "..."
    wait_for_stderr: "..."      # jellyclaw-run only
    wait_for_stdout: "..."      # jellyclaw-run only (alt to stderr)
    expect_exit: 0              # shell only
    timeout_sec: 10
    teardown: "free-text"
human_gate: false               # true ⇒ pause for George's review
max_turns: 25
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 10
```

### Test `kind` semantics

- `shell` — run `command`, assert exit code equals `expect_exit`.
- `jellyclaw-run` — spawn `command` as a background process, stream stderr/stdout, pass when `wait_for_stderr` or `wait_for_stdout` substring is seen within `timeout_sec`, then tear down.
- `http-roundtrip` — (reserved) issue an HTTP request and match response.
- `smoke-suite` — (reserved) run the repo's smoke tests via `bun run test:smoke`.

## Body structure

Each prompt body has six fixed sections: **Context**, **Root cause (from audit)**, **Fix — exact change needed**, **Acceptance criteria**, **Out of scope**, **Verification the worker should self-run before finishing**. Surgical scope, exact file:line citations, no "while you're there" additions.

## Conventions inherited from CLAUDE.md

Strict TypeScript, no `any`, pino logger (never `console.log`), zod at boundaries, `import type` for type-only symbols, kebab-case files / PascalCase types / camelCase functions. See repo root `CLAUDE.md`.
