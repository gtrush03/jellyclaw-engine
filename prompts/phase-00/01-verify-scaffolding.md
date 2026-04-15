# Phase 00 — Repo scaffolding — Prompt 01: Verify scaffolding

**When to run:** Immediately. This is the first prompt of the project. It assumes a previous agent run has already created the scaffold files on disk.
**Estimated duration:** 0.5 hour
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `00`
- `<phase-name>` → `Repo scaffolding`
- `<sub-prompt>` → `01-verify-scaffolding`
<!-- END SESSION STARTUP -->

## Task

Verify that the Phase 00 scaffold already exists on disk, fix any drift from the spec in `phases/PHASE-00-scaffolding.md`, run the toolchain green, and mark Phase 00 complete in `COMPLETION-LOG.md`. This is a **confirmation prompt, not a creation prompt** — a previous agent run laid down the files. Your job is to prove they work end-to-end.

### Context

The repo lives at `/Users/gtrush/Downloads/jellyclaw-engine/`. It uses **bun** as the package manager per `CLAUDE.md` (not pnpm — CLAUDE.md says `bun install`, but the phase doc says pnpm; CLAUDE.md wins because it's authoritative per `engine/SPEC.md`). Confirm which is in use by inspecting the actual repo before running commands. If you find a `bun.lockb`, use bun. If you find a `pnpm-lock.yaml`, use pnpm. If neither, bun per CLAUDE.md.

The scaffold is expected to already contain: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `tsup.config.ts`, `.gitignore`, `.env.example`, `LICENSE`, `README.md`, `CLAUDE.md`, `engine/`, `desktop/`, `integration/`, `patches/`, `phases/`, `skills/`, `agents/`, `scripts/`, `docs/`, `test/`.

### Steps

1. `cd /Users/gtrush/Downloads/jellyclaw-engine && ls -la` — confirm scaffolding. Compare against the "Deliverables" and "Files touched" sections of `phases/PHASE-00-scaffolding.md`. List anything missing.
2. Detect package manager: `ls bun.lockb pnpm-lock.yaml package-lock.json 2>/dev/null`. Use whichever exists. If none, run `bun install`.
3. Install: `bun install` (or `pnpm install --frozen-lockfile` if pnpm-based).
4. Typecheck: `bun run typecheck` (or `pnpm typecheck`). Expected: exit 0.
5. Lint: `bun run lint`. Expected: exit 0, or a small list of auto-fixable warnings — if so, run `bun run format` and re-lint.
6. Test: `bun run test`. Expected: exit 0 with "no tests found" tolerated (Vitest should still exit 0 with `--passWithNoTests` or zero-collected behavior).
7. Smoke-build: `bun run build` if defined in `package.json`. Expected: no errors; `dist/` produced.
8. Git state: `git status` and `git log --oneline -5`. If the repo is not a git repo, run `git init -b main`, add all, and create the initial commit `chore: initial scaffold`. If already committed, leave alone.
9. Create git tag `v0.0.0-scaffold` if it does not already exist: `git tag | grep -q v0.0.0-scaffold || git tag v0.0.0-scaffold`.
10. Patch any discovered drift. If the phase doc demands a file that is missing, create it verbatim from the phase doc. Do NOT invent scope beyond Phase 00.
11. Update `COMPLETION-LOG.md` per the closeout template: set Phase 00 to ✅ Complete, fill in session metadata, append a session-log row.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — mark Phase 00 complete.
- Any missing scaffold file explicitly listed in `phases/PHASE-00-scaffolding.md` — create verbatim.

### Verification

After running the steps, all of the following MUST hold:

- `bun install` (or pnpm install) exits 0 on a fresh clone simulation (`rm -rf node_modules && bun install`).
- `bun run typecheck` exits 0.
- `bun run lint` exits 0.
- `bun run test` exits 0.
- `bun run build` exits 0 (if a build script exists).
- `git tag | grep v0.0.0-scaffold` returns a hit.
- `LICENSE`, `README.md`, `CLAUDE.md`, `.env.example`, `biome.json`, `tsconfig.json`, `vitest.config.ts` all exist at the repo root.
- `COMPLETION-LOG.md` shows Phase 00 as ✅ with today's date and commit SHA.

### Common pitfalls

- **Package manager confusion.** The phase doc says pnpm; CLAUDE.md says bun. Inspect the actual lockfile and respect it. Do NOT re-install under a second PM — that corrupts the tree.
- **`patch-package` postinstall errors on first run.** No patches exist yet for Phase 00. If `patch-package` runs at postinstall and exits non-zero, the fix is to make it tolerate an empty patches dir (flag `--patch-dir patches --error-on-fail=false` if present) or to defer postinstall until Phase 01. Phase 00 must still install green; prefer removing `patch-package` from `postinstall` until Phase 01 — this is a documented Phase 00 risk.
- **Biome flagging files inside `patches/`.** Ensure `biome.json`'s `files.ignore` contains `patches` and `**/target`.
- **Committing `.env`.** Never. `.env.example` only.
- **Creating files not in the phase doc.** Phase 00 is tight. Do not scope-creep into engine code — that belongs to later phases.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `00`
- `<phase-name>` → `Repo scaffolding`
- `<sub-prompt>` → `01-verify-scaffolding`
- Mark Phase 00 as ✅ Complete in `COMPLETION-LOG.md`.
<!-- END SESSION CLOSEOUT -->
