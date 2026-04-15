# Phase 01 — OpenCode pinning and patching — Prompt 01: Research

**When to run:** After Phase 00 is marked ✅ in `COMPLETION-LOG.md`.
**Estimated duration:** 3-4 hours
**New session?** Yes (always start a fresh Claude Code session for each prompt)
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN SESSION STARTUP -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md` before doing anything else.

Substitutions for this session:
- `<NN>` → `01`
- `<phase-name>` → `OpenCode pinning and patching`
- `<sub-prompt>` → `01-research`
<!-- END SESSION STARTUP -->

## Task

Produce a complete, implementation-ready research note at `engine/opencode-research-notes.md` covering (1) the CVE-2026-22812 fix chain through v1.4.4, (2) issue #5894 (subagent hook bypass) including the exact upstream file paths that need patching, and (3) the OpenCode headless server contract (CLI flags, env vars, endpoints, event stream format). Downstream prompts will read ONLY your research notes, not upstream source — make them authoritative.

### Context

OpenCode is at [`sst/opencode`](https://github.com/sst/opencode). jellyclaw pins `opencode-ai@>=1.4.4 <2` per `engine/SPEC.md` §15. Two upstream bugs directly shape our patch plan:

- **CVE-2026-22812** — unauth RCE via the `/file` endpoint in `<v1.0.216`. Fix chain: v1.0.216 added auth, v1.1.10 disabled the server by default, v1.4.4 shipped final hardening (see `engine/CVE-MITIGATION.md`).
- **Issue #5894** — plugin hooks `tool.execute.before/after` do NOT fire for tool calls dispatched from subagents spawned via the `task` tool. Breaks permission + observability plugins. Patch must touch `packages/opencode/src/tool/task.ts` and `packages/opencode/src/session/processor.ts` per SPEC §5.1.

A shallow clone of upstream may already exist at `/Users/gtrush/Downloads/jellyclaw-engine/engine/opencode/`. If not, use WebFetch / the GitHub raw content URLs to retrieve the relevant files without cloning the whole repo.

### Steps

1. Determine upstream version to pin. Fetch `https://registry.npmjs.org/opencode-ai` and confirm that `1.4.4` is published and the latest `1.x.x`. Record the exact latest `1.x` patch version in your notes — that will be the pin target.
2. Retrieve the CVE-2026-22812 advisory (search GitHub advisories for `sst/opencode` CVE-22812) and summarize: attack vector, fixed-in version, residual threat (none if ≥1.4.4), and server-bind behavior changes (must be `127.0.0.1`).
3. Read issue [`sst/opencode#5894`](https://github.com/sst/opencode/issues/5894) and any linked PR. Extract: (a) reproduction steps, (b) the exact functions that fail to dispatch hooks, (c) upstream fix status (merged? stale? different approach?).
4. Locate these upstream files and copy the relevant function bodies into your research notes, with line numbers:
   - `packages/opencode/src/tool/task.ts` — the subagent dispatcher entry
   - `packages/opencode/src/session/processor.ts` — the child-session spawn path
   - `packages/opencode/src/plugin/index.ts` (or equivalent) — where `Plugin.trigger(...)` is defined
   - `packages/opencode/src/server/index.ts` — server bind + auth middleware, confirm 127.0.0.1 lock and `Authorization: Bearer` requirement
5. Document the headless-server contract: how to start it (`npx opencode serve --hostname 127.0.0.1 --port N`), env vars it reads (`OPENCODE_SERVER_PASSWORD`), the `/config`, `/session`, `/event` endpoints, and the SSE event envelope shape (include one sample line).
6. Document the three Phase 01 patches this project will ship, mapping each to a file under `patches/`:
   - `001-subagent-hook-fire.patch` — #5894 fix (wraps nested tool dispatcher with `Plugin.trigger("tool.execute.before", …)` and threads plugin registry into `spawnChild`).
   - `002-bind-localhost-only.patch` — belt-and-braces assertion that `/server` refuses binds other than `127.0.0.1`.
   - `003-secret-scrub-tool-results.patch` — redact env-var-shaped secrets from tool results before emitting to the event stream.
   Confirm existing stubs in `/Users/gtrush/Downloads/jellyclaw-engine/patches/` align with this naming.
7. Write `engine/opencode-research-notes.md`. Structure it exactly as: (§1 Version pin) (§2 CVE-22812 chain) (§3 Issue #5894 deep dive with diff sketch) (§4 Server contract) (§5 Patch plan mapped to our three patch files) (§6 Open risks).

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/opencode-research-notes.md` — the deliverable. Target length: 800-1500 lines. Include code blocks with upstream source excerpts + line numbers so Phase 01 Prompt 02 can author the patches without re-reading upstream.

### Verification

- File `engine/opencode-research-notes.md` exists and renders cleanly.
- Version pin recommendation is concrete (e.g. "pin `opencode-ai@1.4.8`"), not a range.
- Each of the three patch files has a dedicated subsection with (a) file to modify, (b) approximate line range, (c) before/after pseudo-diff, (d) expected test signal.
- The `/event` SSE shape section includes at least one real sample event from upstream (not fabricated).
- Zero claims made from memory about OpenCode internals without citing a specific upstream file path.

### Common pitfalls

- **Fabricating line numbers.** If you cannot retrieve the actual file, say so and mark the subsection `TODO: fetch`. Do not guess.
- **Conflating #5894 with other hook bugs.** #5894 is specifically the subagent bypass. If upstream has merged a different fix with a different shape, record that and adjust our patch plan accordingly.
- **Over-scoping.** This is research only. Do NOT install `opencode-ai` or author the patches — that is Prompt 02's job.
- **Stale registry data.** The `npm view opencode-ai versions` output may be cached; cross-check against https://github.com/sst/opencode/releases.

<!-- BEGIN SESSION CLOSEOUT -->
Read and follow the full contents of `/Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md`.

Substitutions for this session:
- `<NN>` → `01`
- `<phase-name>` → `OpenCode pinning and patching`
- `<sub-prompt>` → `01-research`
- Do NOT mark Phase 01 complete — only the implementation prompt closes the phase. Append a session-log row noting the research deliverable and commit SHA.
<!-- END SESSION CLOSEOUT -->
