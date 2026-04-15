# Day 1 — first boot of jellyclaw

Step-by-step commands for the first time you open this repo. Assumes macOS + zsh.

## 0. Prereqs

```bash
# Required
bun --version     # >= 1.1, or node >= 20.6 if you prefer npm
git --version

# Recommended
node --version
```

If `bun` is missing: `curl -fsSL https://bun.sh/install | bash`.

## 1. Land in the repo

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
```

## 2. Install + build + test (one-shot via setup.sh)

```bash
./scripts/setup.sh
```

That does the work in steps 3–6 below. If you prefer to do it by hand, skip ahead.

## 3. Install deps

```bash
bun install
```

First run will complain about missing `patches/` content (postinstall calls `patch-package`).
That's expected — Phase 0 ships no patches. The `|| true` guard in the postinstall script swallows
the exit code.

## 4. Create `.env.local`

```bash
cp .env.example .env.local
$EDITOR .env.local       # fill in ANTHROPIC_API_KEY
```

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## 5. Build

```bash
bun run build
chmod +x dist/cli.js
```

You should see `dist/cli.js`, `dist/index.js`, plus `.d.ts` twin files.

## 6. Smoke test the CLI

```bash
./dist/cli.js run "hello world"
```

Expected output (NDJSON, one event per line):

```
{"type":"session.started", …}
{"type":"agent.message", …, "delta":"[phase-0 stub] received wish: hello world\n", …}
{"type":"usage.updated", …}
{"type":"session.completed", …}
```

Use `--pretty` for multi-line output with labels:

```bash
./dist/cli.js run "hello world" --pretty
```

## 7. Run tests

```bash
bun run test
```

Phase 0 ships a handful of smoke tests covering the AgentEvent schema and the `run()` event
ordering. Coverage thresholds are 0 in Phase 0 — they ratchet up in Phase 3.

## 8. Typecheck + lint

```bash
bun run typecheck
bun run lint
```

Both must be clean before every commit.

## 9. Try watch mode

```bash
bun run dev
```

In another shell:

```bash
./dist/cli.js run "still alive"
```

## 10. Read the phase plan

Open [`phases/README.md`](../phases/README.md) and work through the phases **in order**. Do not
leap ahead. The order is:

```
Phase 0   scaffolding (this)
Phase 1   pin OpenCode, wire SDK
Phase 2   providers + cache + CVE-22812 mitigation
Phase 3   MCP + permissions + hooks
Phase 4   macOS desktop bridge
Phase 5   Genie integration
Phase 6   pluggable providers
```

Each phase has a Definition of Done. Do not start Phase N+1 until N's DoD passes.

## 11. Commit cadence reminder

- Work on the **current branch** — do not auto-create feature branches.
- Conventional Commits format (see CLAUDE.md).
- No autonomous PRs. George cuts PRs manually.

---

You should now be able to:

- Build and re-build the project.
- Run the CLI end-to-end.
- Run the tests.
- Open `phases/PHASE-01-opencode-pinning.md` and begin Phase 1 work.

If any of those fail, read `docs/ARCHITECTURE.md` to orient, and then fix before proceeding.
