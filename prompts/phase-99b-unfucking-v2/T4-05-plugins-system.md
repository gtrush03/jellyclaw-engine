---
id: T4-05-plugins-system
tier: 4
title: "Plugin system — load ~/.claude/plugins/*/ with skills, agents, slash commands, hooks (namespaced)"
scope:
  - "engine/src/plugins/loader.ts"
  - "engine/src/plugins/loader.test.ts"
  - "engine/src/plugins/manifest.ts"
  - "engine/src/plugins/manifest.test.ts"
  - "engine/src/plugins/namespace.ts"
  - "engine/src/plugins/namespace.test.ts"
  - "engine/src/skills/registry.ts"
  - "engine/src/agents/registry.ts"
  - "engine/src/hooks/registry.ts"
  - "engine/src/cli/plugins.ts"
  - "engine/src/cli/main.ts"
  - "docs/plugins.md"
depends_on_fix:
  - T2-03-skills-loader
  - T2-04-hooks-registry
tests:
  - name: plugin-skill-listed-with-namespace
    kind: shell
    description: "drop testplug/skills/foo/SKILL.md; jellyclaw skills prints 'testplug:foo' and the skill resolves to the plugin's path"
    command: "bun run test engine/src/plugins/loader -t plugin-skill-namespaced"
    expect_exit: 0
    timeout_sec: 30
  - name: plugin-agent-invoked-via-task
    kind: shell
    description: "a plugin-shipped agent declared in testplug/agents/bar/ is invokable via Task({agent:'testplug:bar'})"
    command: "bun run test engine/src/plugins/loader -t plugin-agent-via-task"
    expect_exit: 0
    timeout_sec: 45
  - name: plugin-hooks-fire
    kind: shell
    description: "a PreToolUse hook shipped by testplug fires for every tool invocation; assert the hook script is called once per Bash call"
    command: "bun run test engine/src/plugins/loader -t plugin-hooks-fire"
    expect_exit: 0
    timeout_sec: 45
  - name: plugin-slash-command-registered
    kind: shell
    description: "testplug/commands/hello.md is invokable as /testplug:hello in the TUI and inserts the command body"
    command: "bun run test engine/src/plugins/loader -t plugin-slash-command"
    expect_exit: 0
    timeout_sec: 30
  - name: invalid-manifest-rejected
    kind: shell
    description: "a plugin missing plugin.json or with bad JSON is skipped with a logged warning; other plugins still load"
    command: "bun run test engine/src/plugins/manifest -t invalid-manifest-skipped"
    expect_exit: 0
    timeout_sec: 30
  - name: cli-plugins-list-shows-all
    kind: shell
    description: "jellyclaw plugins list prints installed plugins with id, version, and component counts (skills, agents, hooks, commands)"
    command: "bun run test engine/src/cli/plugins -t cli-plugins-list"
    expect_exit: 0
    timeout_sec: 20
human_gate: true
max_turns: 90
max_cost_usd: 10
max_retries: 5
estimated_duration_min: 210
---

# T4-05 — Plugin system (namespaced ~/.claude/plugins/*/ loader)

## Context
Claude Code's plugin convention lives at `~/.claude/plugins/<plugin-id>/` with a top-level `plugin.json` manifest and sub-directories for skills, agents, slash commands, and hooks. Plugins are the **distribution mechanism** — the way an open-source replacement grows an ecosystem. T2-03 (skills loader) and T2-04 (hooks registry) shipped the single-directory loaders for `~/.claude/skills/` and `~/.claude/hooks/`. T4-05 generalises: a plugin is a folder that contributes to all four surfaces at once, namespaced under the plugin id.

Reference material:
- `engine/src/skills/registry.ts` (from T2-03) — we extend it to accept plugin-contributed skills.
- `engine/src/hooks/registry.ts` (from T2-04) — same extension pattern.
- `engine/src/tools/task.ts` (from T2-02) — the Task tool resolves agent id → system prompt + config; we extend it to recognise `plugin:agent` ids.
- The namespace convention we match: `<plugin_id>:<local_id>` (colon separator). `my-plugin:my-skill`, `my-plugin:my-agent`, `my-plugin:PreToolUse`, `/my-plugin:my-command`.
- Filesystem layout we expect:
  ```
  ~/.claude/plugins/my-plugin/
    plugin.json                    # manifest (required)
    skills/
      my-skill/
        SKILL.md                   # skill file (T2-03 format)
    agents/
      my-agent/
        AGENT.md                   # agent file (system prompt + tools whitelist)
    commands/
      my-command.md                # slash command body (Claude Code convention)
    hooks/
      PreToolUse.json              # hook descriptor (T2-04 format)
      PostToolUse.json
  ```

## Root cause (from audit)
jellyclaw today loads skills from `~/.claude/skills/` and hooks from `~/.claude/hooks/` but does not walk `~/.claude/plugins/`. This is the single largest ecosystem gap between jellyclaw and Claude Code. Users can't install `my-plugin` from npm/brew and have it "just work"; they have to hand-copy each skill/agent/hook into the right legacy directory, losing the plugin-id grouping entirely.

## Fix — exact change needed

### 1. `engine/src/plugins/manifest.ts` — plugin.json schema
- Zod schema:
  ```ts
  const PluginManifest = z.object({
    id:          z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), // kebab, lowercase, 1..64 chars
    version:     z.string().regex(/^\d+\.\d+\.\d+/),
    description: z.string().max(512).optional(),
    homepage:    z.string().url().optional(),
    author:      z.string().optional(),
    engines:     z.object({ jellyclaw: z.string().optional() }).optional(),
    permissions: z.object({
      tools:  z.array(z.string()).optional(),  // if set, the plugin's agents default to this allowlist
      fs_write: z.array(z.string()).optional() // future-reserved
    }).optional()
  });
  ```
- Manifest loading: read `<plugin_dir>/plugin.json`, Zod-parse. Malformed → `logger.warn({ path }, "plugin.manifest.invalid")` and skip the plugin entirely (do not register its skills / agents / hooks / commands — all-or-nothing).
- Collision detection: if two plugins share an `id`, the one loaded first wins and the second logs a collision warning and is skipped.

### 2. `engine/src/plugins/namespace.ts` — id helpers
- `namespaced(pluginId, localId)` → `"<pluginId>:<localId>"`.
- `parseNamespaced(id)` → `{ pluginId, localId }` or `null` if no colon.
- Validation: `localId` must match the loader's domain rules (skill names: kebab-case; agent names: kebab-case; command names: kebab-case; hook names: must be one of the known hook event types).

### 3. `engine/src/plugins/loader.ts` — top-level walker
- Default root: `~/.claude/plugins/`. Override: `JELLYCLAW_PLUGINS_DIR` env var, or `--plugins-dir <path>` CLI flag (comma-separated for multiple dirs — later plugins override earlier ones; log a warning on override).
- For each subdirectory:
  1. Load + validate manifest. Skip on failure.
  2. Walk `skills/*/SKILL.md` → for each, call `skills.registry.register({ source: "plugin", pluginId, localId, path, metadata })`. The registry stores the namespaced id (`pluginId:localId`) as the canonical key.
  3. Walk `agents/*/AGENT.md` → parse `name`, `system_prompt`, `tools` (whitelist subset, matching T4-03's `allowedTools` format); register in `engine/src/agents/registry.ts` under the namespaced id.
  4. Walk `commands/*.md` → the file body is the expansion; front-matter (via `gray-matter`, already a dep at `package.json:45`) supplies `description`, `argument_hint`. Register in the slash-command registry (create one at `engine/src/commands/registry.ts` if T2-03 didn't).
  5. Walk `hooks/*.json` → parse per T2-04 hook-descriptor format; register on the hook event in `engine/src/hooks/registry.ts` with `source: { pluginId }` and the namespaced hook id `<pluginId>:<hookName>`. Hooks may run **shell commands** — use the same sandboxing T2-04 established (no new hook runtime here).
- Idempotent reload: `loader.reloadAll()` drops all plugin-sourced registrations and re-walks. Exposed for tests and for `jellyclaw plugins reload` CLI.

### 4. Registry extensions (minimal edits)
- `engine/src/skills/registry.ts` — extend the record shape to include `source: { kind: "user" | "plugin", pluginId?: string }`. `listSkills()` returns namespaced ids; `resolveSkill(id)` accepts both `my-skill` (user) and `my-plugin:my-skill` (plugin).
- `engine/src/agents/registry.ts` — mirror the shape; `resolveAgent(id)` accepts namespaced ids. The Task tool looks up by this registry and applies the `allowedTools` whitelist per T4-03.
- `engine/src/hooks/registry.ts` — add `source` field; hook execution unchanged.

### 5. `engine/src/cli/plugins.ts` + wiring in `engine/src/cli/main.ts`
- New `jellyclaw plugins` subcommand with three verbs:
  - `list` — prints installed plugins as a table: `id | version | skills | agents | hooks | commands | source_dir`. Matches JSON output with `--json`.
  - `reload` — calls `loader.reloadAll()`; prints diff (added / removed / unchanged counts).
  - `doctor` — per plugin: verifies manifest, lists invalid files, checks hook-command shebangs exist, dry-runs permissions.
- Wire as a Commander subcommand in `engine/src/cli/main.ts` following the existing pattern around `:372`.

### 6. `docs/plugins.md`
- Quick-start: `mkdir -p ~/.claude/plugins/my-plugin && cat > ~/.claude/plugins/my-plugin/plugin.json`.
- Full manifest schema with field-by-field explanation.
- Component conventions (skills/agents/commands/hooks) with file tree examples.
- Namespacing rules + collision semantics.
- Migration: how an existing `~/.claude/skills/my-skill/` becomes `~/.claude/plugins/me/skills/my-skill/`.
- Distribution note: plugins are pure directories — ship via git clone, tarball, or npm `postinstall` that copies into `~/.claude/plugins/`. `jellyclaw plugins` does NOT install anything; it only loads what's already on disk.

### 7. Tests
- `plugin-skill-namespaced`: fixture plugin at `test/fixtures/plugins/testplug/` with one skill; load; assert `listSkills()` includes `testplug:foo`; `resolveSkill("testplug:foo")` returns the plugin's path.
- `plugin-agent-via-task`: fixture plugin with an agent `bar`; invoke `Task({ agent: "testplug:bar", prompt: "noop" })`; assert the spawned subagent received the plugin's system_prompt and tools whitelist.
- `plugin-hooks-fire`: fixture plugin with a PreToolUse hook that writes a sentinel file per invocation; run a Bash tool call 3 times; assert the sentinel file has 3 entries.
- `plugin-slash-command`: fixture plugin with `commands/hello.md`; register; expand `/testplug:hello` and assert the body matches.
- `invalid-manifest-skipped`: three fixture plugins (one valid, one missing `plugin.json`, one with bad JSON); load; assert only the valid one registered, the other two logged warnings, and the valid one's skill is reachable.
- `cli-plugins-list`: install two fixture plugins; run `jellyclaw plugins list --json`; assert shape.

## Acceptance criteria
- Plugin skills are listed with `pluginId:localId` (maps to `plugin-skill-listed-with-namespace`).
- Plugin agents are invokable via Task (maps to `plugin-agent-invoked-via-task`).
- Plugin hooks fire on the same event pipeline as user hooks (maps to `plugin-hooks-fire`).
- Plugin slash commands are registered and expandable (maps to `plugin-slash-command-registered`).
- Invalid plugins are skipped with warnings, others still load (maps to `invalid-manifest-rejected`).
- `jellyclaw plugins list` works (maps to `cli-plugins-list-shows-all`).
- `bun run typecheck` + `bun run lint` + full test suite pass.

## Out of scope
- Do NOT implement plugin installation / package manager logic. No `jellyclaw plugins install <url>`. Distribution is filesystem-only in T4.
- Do NOT implement marketplace, signing, or trust attestations — these are future tiers. A warning log on plugin load about the trust implications is acceptable; blocking execution on signature check is not.
- Do NOT implement MCP servers as plugin components at this tier; MCP has its own config surface (T2-05).
- Do NOT mutate CLAUDE.md or SOUL.md from within this prompt — the worker will be in review-only mode if it tries (see `AUTOBUILD-PHASES.md:336-347`).

## Verification the worker should self-run before finishing
```bash
bun run typecheck
bun run lint
bun run test engine/src/plugins
bun run test engine/src/cli/plugins
# End-to-end sanity: drop a fixture plugin and list it
JELLYCLAW_PLUGINS_DIR=./test/fixtures/plugins node engine/bin/jellyclaw plugins list
```
