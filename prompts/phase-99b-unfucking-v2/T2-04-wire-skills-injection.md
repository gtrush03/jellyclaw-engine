---
id: T2-04-wire-skills-injection
tier: 2
title: "Register the Skill tool + inject discovered skills into the system prompt"
scope:
  - "engine/src/cli/run.ts"
  - "engine/src/tools/skill.ts"
  - "engine/src/tools/skill.test.ts"
  - "engine/src/tools/index.ts"
  - "engine/src/skills/inject.ts"
depends_on_fix:
  - T2-03-add-claude-skills-discovery-path
tests:
  - name: system-prompt-contains-skill-line
    kind: shell
    description: "system prompt injected into runAgentLoop contains skill:<name> — <description> lines"
    command: "bun run test engine/src/cli/run -t skills-injected-into-system-prompt"
    expect_exit: 0
    timeout_sec: 60
  - name: skill-tool-returns-body
    kind: shell
    description: "model-invoked Skill tool returns the full SKILL.md body verbatim"
    command: "bun run test engine/src/tools/skill"
    expect_exit: 0
    timeout_sec: 60
  - name: no-skills-no-header
    kind: shell
    description: "with zero discovered skills the injection block is empty and no Skill tool is registered"
    command: "bun run test engine/src/cli/run -t skills-empty-no-injection"
    expect_exit: 0
    timeout_sec: 60
human_gate: false
max_turns: 40
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 45
---

# T2-04 — Wire skill discovery + injection + the `Skill` tool

## Context
`buildSkillInjection()` correctly composes a byte-capped list of `skill:<name> — <description>` lines for the system prompt — but NO caller invokes it. Even worse, the header it generates says "invoke by name via the `use_skill` tool" and that tool doesn't exist. The discovered skills are dead weight.

## Root cause (from audit)
- `engine/src/skills/inject.ts:31` — `const HEADER = "# Available skills (invoke by name via the use_skill tool):\n";` — advertises a tool that is not in `engine/src/tools/index.ts`.
- `engine/src/skills/inject.ts:50` — `buildSkillInjection()` is exported but there are zero production callers. (`grep -r "buildSkillInjection"` returns only the module itself and its tests.)
- `engine/src/cli/run.ts:142-153` — `runAgentLoop({..., systemPrompt: soul})` receives only the soul string. No skill block is concatenated.
- Claude Code's real skill surface is a tool named `Skill`, not `use_skill`.

## Fix — exact change needed
1. **Rename the advertised tool name.** In `engine/src/skills/inject.ts:31` replace `use_skill` with `Skill` so the header reads: `# Available skills (invoke by name via the Skill tool):\n`.
2. **New file `engine/src/tools/skill.ts`** — register a builtin tool named `Skill` with:
   - Zod input schema: `{ name: z.string().regex(/^[a-z0-9-]+$/) }`.
   - Handler: resolve the name through the skill registry (inject the registry via `ToolContext` or a module-local DI seam consistent with existing tool patterns — see `engine/src/tools/read.ts` for the pattern). Read the `SKILL.md` body (NOT frontmatter, just the body under the `---` fence) and return it as `{ content: string }`.
   - Unknown name → `tool_error` with `code: "unknown_skill"` and the available names listed.
   - Permission: read-only (extend `READ_ONLY_TOOLS` in `engine/src/permissions/types.ts` to include `"Skill"`).
3. **Register the tool** in `engine/src/tools/index.ts` alongside the existing builtins. Gate registration on `skills.length > 0` so zero-skill runs don't advertise the tool (avoids confusing the model).
4. **`engine/src/cli/run.ts:realRunFn`** — before calling `runAgentLoop(...)`:
   - `const skills = await loadSkillRegistry()` — thin wrapper around `discoverSkills()` + `parseSkill()` already implemented in `engine/src/skills/registry.ts` if present, otherwise the parse inline.
   - `const { block, included } = buildSkillInjection({ skills: skills.all(), logger })`.
   - Compose `systemPrompt = [soul, block].filter(Boolean).join("\n\n")` (only include block when non-empty).
   - When `skills.all().length > 0`, register/activate the `Skill` tool with the registry in its closure.
5. **Tests**:
   - `engine/src/cli/run.test.ts` — inject `skills: [{name:"unit-test", frontmatter:{description:"x"}, source:"user", body:"hello"}]` through a DI seam; assert the `runAgentLoop` invocation's `systemPrompt` contains `skill:unit-test — x`.
   - `engine/src/tools/skill.test.ts` — invoking `Skill({name:"unit-test"})` returns `"hello"`. Unknown name returns a `tool_error`. Input fails zod for uppercase.
   - Empty-skills test — with zero discovered skills, the `Skill` tool is NOT in `listTools()` output.

## Acceptance criteria
- `system-prompt-contains-skill-line` — system prompt assembled by the CLI handler includes the skill line (maps to test 1).
- `skill-tool-returns-body` — handler returns the body string, rejects uppercase, rejects unknown name (maps to test 2).
- `no-skills-no-header` — zero-skill path emits no header and no tool registration (maps to test 3).

## Out of scope
- Do NOT implement auto-updating on filesystem change — discovery is one-shot at CLI invocation.
- Do NOT change the injection byte cap default (1536) — cap-tuning is T3 territory.
- Do NOT add the `Skill` tool to MCP; it is builtin.

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run test engine/src/skills engine/src/tools/skill engine/src/cli/run
grep -R "buildSkillInjection" engine/src/cli && echo "wired" || echo "STILL UNWIRED"
```
