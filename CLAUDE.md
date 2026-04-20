# CLAUDE.md — repo-internal orientation

> Read this first when Claude Code / any AI assistant is opened inside this repository.

## What this project is

**jellyclaw** is an open-source, embeddable replacement for Claude Code. It wraps
[OpenCode](https://github.com/sst/opencode) `>=1.4.4` behind a small typed event API so that
consumers (primarily the [Genie](https://github.com/gtrush03/genie-2.0) app and, eventually, the
jelly-claw video-calling macOS app) can dispatch agent work without shelling out to the
proprietary `claude` binary.

It is **pre-alpha**. Do not tell the user "this is production-ready" — it isn't.

## Where we are

**Updated Apr 19, 2026.** For the single source of truth, read
[`STATUS.md`](STATUS.md) and [`COMPLETION-LOG.md`](COMPLETION-LOG.md) —
those are regenerated from live autobuild state. The table below is a
snapshot at commit time; expect drift.

| Phase        | File                                                                             | Status                             |
| ------------ | -------------------------------------------------------------------------------- | ---------------------------------- |
| 00 – 07      | `ARCHIVE/phases/PHASE-0{0..7}-*.md`                                              | COMPLETE (see COMPLETION-LOG)      |
| 07.5         | `ARCHIVE/phases/PHASE-07.5-chrome-mcp.md`                                        | COMPLETE                           |
| 08           | `ARCHIVE/phases/PHASE-08-*.md`                                                   | COMPLETE (v1 tool surface)         |
| 08-hosting   | `phases/PHASE-08-hosting.md` + `prompts/phase-08-hosting/`                       | IN FLIGHT · T3-T6 done, T7 queued  |
| 09 – 10.5    | `ARCHIVE/phases/PHASE-{09,10,10.5}-*.md`                                         | COMPLETE                           |
| 11           | `phases/PHASE-11-*.md`                                                           | IN FLIGHT                          |
| 99           | `phases/PHASE-99-unfucking.md`                                                   | IN FLIGHT · 5/8 prompts landed     |

If you are asked to implement something, find the phase it belongs to before writing code. If the
request crosses phases, flag it — don't secretly pull Phase 4 work into Phase 1.

## Where the truth lives

- **Spec (authoritative):** [`engine/SPEC.md`](engine/SPEC.md)
- **Security / threat model:** [`engine/CVE-MITIGATION.md`](engine/CVE-MITIGATION.md)
- **Architecture (how pieces fit):** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- **Consumer integration:** [`integration/GENIE-INTEGRATION.md`](integration/GENIE-INTEGRATION.md)
- **Phase-by-phase plan:** [`phases/README.md`](phases/README.md) — **always read in order.**

When the user asks "what does X do," check the spec before answering from memory.

## Running things

```bash
bun install            # first-time setup
bun run build          # tsup → dist/
bun run dev            # watch
bun run test           # vitest
bun run lint           # biome check
bun run format         # biome format --write
bun run typecheck      # tsc --noEmit
```

The smoke test that should always pass:

```bash
./dist/cli.js run "hello world"
```

## Coding conventions

1. **Strict TypeScript.** Project is `strict: true` + `noUncheckedIndexedAccess` +
   `exactOptionalPropertyTypes`. No `any`. No `@ts-ignore` unless it has a linked issue number
   and a TODO.
2. **No `console.log`.** Use `pino` via `engine/src/logger.ts`. Biome enforces this.
3. **No `process.exit()` outside `engine/src/cli.ts`.** Engine code throws typed errors;
   the CLI is the only layer allowed to translate to exit codes.
4. **Imports are `import type { X }` whenever the symbol is type-only.** Biome enforces this.
5. **Zod for runtime validation** at every boundary: config file parsing, env var parsing,
   incoming HTTP, outgoing tool results. Types flow _from_ Zod, not the other way around.
6. **No `new Date()` in domain code.** Inject a clock. Tests need to be deterministic.
7. **Secrets redaction** is the logger's job. If you find yourself writing
   `logger.info({ apiKey })`, stop — add the field to the redact list in `logger.ts`.
8. **File naming:** kebab-case for files, PascalCase for types, camelCase for functions.
9. **One public export per module** where practical. Barrel re-exports live in
   `engine/src/index.ts`.

## Commit style

Conventional Commits:

```
feat(engine): add AgentEvent.tool_result variant
fix(providers): anthropic cache_control breakpoint placement
chore(deps): bump opencode-ai to 1.4.5
docs(phases): clarify Phase 2 DoD
test(events): cover stream error path
```

Scope is one of: `engine`, `providers`, `cli`, `mcp`, `config`, `deps`, `phases`, `docs`,
`test`, `ci`, `release`.

Body required for anything beyond a one-line mechanical change. Reference the phase (`Phase 1`)
and any upstream issue (`upstream: sst/opencode#1234`).

**No `Co-Authored-By: Claude` trailers.** George authors, not Claude. Omit the trailer
entirely — don't add it even when tooling would otherwise suggest it.

## What to do when unsure

1. Re-read the relevant phase doc.
2. Re-read [`engine/SPEC.md`](engine/SPEC.md).
3. If still unsure, **write a failing test** that captures the ambiguity and stop. Don't guess.

## George-specific notes

- Work **locally on the current branch**. Do not create branches unsolicited — George cuts
  branches himself when he wants them.
- **No autonomous PRs.** Commit when asked.
- Prefer showing diffs over rewriting whole files in chat.
- If a phase reveals the previous phase was wrong, **update the previous phase doc** instead
  of silently fixing the symptom.
