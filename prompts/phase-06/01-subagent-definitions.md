# Phase 06 — Subagent system — Prompt 01: Subagent definitions (discovery + parser + registry)

**When to run:** After Phase 05 is fully ✅ (both prompts) in `COMPLETION-LOG.md`.
**Estimated duration:** 2–3 hours
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- STOP if Phase 05 is not fully complete. -->
<!-- END paste -->

## Research task

1. Read `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-06-subagents.md` in full — especially Step 1 (file format) and Step 4 (dispatch field usage). The parser must produce the fields dispatch will consume in prompt 02.
2. Read `/Users/gtrush/Downloads/jellyclaw-engine/MASTER-PLAN.md` for how subagents relate to skills + permissions.
3. Read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SPEC.md` — particularly the section on the `Task` tool schema.
4. Re-read `/Users/gtrush/Downloads/jellyclaw-engine/engine/SECURITY.md` — note restrictions on which tools a subagent is allowed to inherit.
5. Read the Phase 05 prompt 01 implementation at `engine/src/skills/` — subagent discovery follows the same structure. Reuse patterns (path resolution, Zod error handling, first-wins) and do NOT duplicate utilities — extract to `engine/src/util/md-frontmatter.ts` if you find yourself copy-pasting.
6. Read the Claude Code subagent file format reference if you can find it in-repo (`Grep` for `subagent_type` under `docs/` and `integration/`). Align field names exactly with Claude Code where possible.

## Implementation task

Implement subagent file discovery, parsing, validation, and registry — **no dispatch yet**. Dispatch is prompt 02; hook patch verification is prompt 03.

### Files to create/modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/agents/types.ts` — `Agent`, `AgentFrontmatter` (Zod), `AgentSource`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/agents/discovery.ts` — walk `~/.jellyclaw/agents/`, `${cwd}/.jellyclaw/agents/`, `${cwd}/.claude/agents/`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/agents/parser.ts` — `gray-matter` + Zod validation.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/agents/registry.ts` — `Map<name, Agent>` with `list()`, `get()`, `loadAll()`, `reload()`, `subscribe()`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/agents/index.ts` — barrel.
- Tests: `discovery.test.ts`, `parser.test.ts`, `registry.test.ts`.
- Example agents: `/Users/gtrush/Downloads/jellyclaw-engine/agents/code-reviewer/AGENT.md`, `agents/doc-writer/AGENT.md`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/util/md-frontmatter.ts` — if refactor from skills module is warranted.

### Frontmatter schema (Zod — match Claude Code fields)

```ts
export const AgentFrontmatter = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(1).max(1024),
  mode: z.enum(["subagent", "primary"]).default("subagent"),
  model: z.string().optional(),                       // e.g. "claude-sonnet-4-5"; overrides default
  tools: z.array(z.string()).optional(),              // allowlist; undefined = inherit parent
  skills: z.array(z.string()).optional(),
  max_turns: z.number().int().positive().max(100).default(20),
  max_tokens: z.number().int().positive().default(100_000),
  // prompt is the markdown body, not frontmatter; expose as separate field on Agent.
});
```

- Unknown frontmatter fields → strict-mode reject with a warn + file path.
- Body must be non-empty; empty body is an error.
- Body cap: 16 KB (subagent system prompts are longer than skills).
- `tools` entries must match a known built-in or `mcp__*__*` pattern at dispatch time — at load time, only syntactic check: `/^(Bash|Read|Write|Edit|Grep|Glob|Task|WebFetch|WebSearch|mcp__[a-z0-9_-]+__[a-z0-9_-]+)$/`.

### Discovery semantics

- Support both directory (`<dir>/<name>/AGENT.md`) and flat (`<dir>/<name>.md`) layouts.
- Directory-style wins on conflict.
- First source (user > project > legacy) wins on duplicate `name`; warn with shadowed paths.
- Collect `SkillLoadError`-style typed errors and return them in a `{ loaded, errors }` tuple; never throw if one bad file exists.

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add p-limit@^6                # needed by prompt 02 but install now
bun run typecheck
bun run test engine/src/agents
bun run lint
```

### Expected output

- Registry loads example agents with no errors.
- Tests cover: valid agent, every validation failure path, dedup, discovery order.
- `bun run typecheck` + `bun run lint` clean.

### Tests to add

- `parser.test.ts`:
  - Valid frontmatter → Agent object with `prompt` = body string (trimmed).
  - Missing `name` → error.
  - Bad name regex (`FooBar`, `foo_bar`) → error.
  - `tools` contains illegal entry → error.
  - Empty body → error.
  - Body > 16 KB → error.
  - Unknown frontmatter key → error.
- `discovery.test.ts`:
  - Three temp dirs, overlapping names → first-wins with warn.
  - Directory + flat for same name → directory wins.
- `registry.test.ts`:
  - `loadAll` populates registry; `get` resolves; `list` returns sorted by name.
  - `reload` picks up a new file.
  - `subscribe` fires on `reload` diff.

### Verification

```bash
bun run test engine/src/agents   # expect: all green
bun run typecheck                 # expect: clean
bun run lint                      # expect: clean

# Smoke: load example agents
mkdir -p ~/.jellyclaw/agents/echo
cat > ~/.jellyclaw/agents/echo/AGENT.md <<'EOF'
---
name: echo
description: Echoes its prompt
tools: [Read]
max_turns: 3
---
You are an echo subagent. Repeat the user's prompt verbatim.
EOF
bun run tsx engine/scripts/agents-dump.ts    # write this script if absent; prints registry contents
```

### Common pitfalls

- Do NOT load subagent bodies into token-count approximations yet — body stays on disk until dispatch.
- `p-limit` is for prompt 02; don't import it here to keep this prompt's diff small.
- Claude Code uses the `subagent_type` field in the `Task` tool — that maps to the agent's `name`; ensure `name` matching is case-sensitive exact.
- Do not silently coerce `max_turns`/`max_tokens`; Zod should reject non-integers.
- `mode: "primary"` support is a future hook — validate it but don't do anything with it yet.
- Use `import type` for Zod inferred types.

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success: check off 06.01 in COMPLETION-LOG.md (Phase 06 status 🔄 In progress), commit docs, next prompt = prompts/phase-06/02-task-tool-implementation.md. -->
<!-- END paste -->
