# Plugins

## Overview

Plugins are the distribution mechanism for jellyclaw extensions. A plugin is a directory that bundles skills, agents, slash commands, and hooks under a single namespace.

## Quick Start

```bash
# Create a plugin directory
mkdir -p ~/.claude/plugins/my-plugin

# Create the manifest
cat > ~/.claude/plugins/my-plugin/plugin.json << 'EOF'
{
  "id": "my-plugin",
  "version": "1.0.0",
  "description": "My first jellyclaw plugin"
}
EOF

# Verify installation
jellyclaw plugins list
```

## Directory Structure

```
~/.claude/plugins/my-plugin/
  plugin.json                    # Manifest (required)
  skills/
    my-skill/
      SKILL.md                   # Skill file
  agents/
    my-agent/
      AGENT.md                   # Agent file
  commands/
    my-command.md                # Slash command
  hooks/
    PreToolUse.json              # Hook descriptor
```

## Manifest Schema

The `plugin.json` file is required and must contain:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique identifier (kebab-case, 1-64 chars, must start with letter) |
| `version` | string | Yes | Semantic version (e.g., "1.0.0") |
| `description` | string | No | Short description (max 512 chars) |
| `homepage` | string | No | URL to plugin homepage |
| `author` | string | No | Author name |
| `engines.jellyclaw` | string | No | Required jellyclaw version |
| `permissions.tools` | array | No | Default tool allowlist for agents |
| `permissions.fs_write` | array | No | Future: filesystem write permissions |

### Example Manifest

```json
{
  "id": "my-plugin",
  "version": "1.2.3",
  "description": "A plugin that does amazing things",
  "homepage": "https://github.com/user/my-plugin",
  "author": "Your Name",
  "engines": {
    "jellyclaw": ">=0.1.0"
  },
  "permissions": {
    "tools": ["Bash", "Read", "Write"]
  }
}
```

## Components

### Skills

Place skills in `skills/<name>/SKILL.md`:

```markdown
---
name: my-skill
description: A useful skill
---

Instructions for the skill...
```

The skill is registered as `my-plugin:my-skill`.

### Agents

Place agents in `agents/<name>/AGENT.md`:

```markdown
---
name: my-agent
description: A specialized agent
mode: subagent
tools:
  - Bash
  - Read
max_turns: 10
---

You are my-agent. Your system prompt goes here.
```

The agent is invokable via `Task({ agent: "my-plugin:my-agent", ... })`.

### Slash Commands

Place commands in `commands/<name>.md`:

```markdown
---
description: Greets the user
argument_hint: "[name]"
---

Hello! This is the expanded body of the command.
```

The command is invokable as `/my-plugin:my-command` in the TUI.

### Hooks

Place hooks in `hooks/<EventName>.json`:

```json
{
  "event": "PreToolUse",
  "command": "./scripts/check.sh",
  "args": [],
  "timeout_ms": 5000,
  "blocking": true
}
```

Supported events: `SessionStart`, `InstructionsLoaded`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `PreCompact`, `Stop`, `Notification`.

## Namespacing

All plugin components are namespaced with the plugin ID:

- Skills: `<plugin-id>:<skill-name>` (e.g., `my-plugin:my-skill`)
- Agents: `<plugin-id>:<agent-name>` (e.g., `my-plugin:my-agent`)
- Commands: `/<plugin-id>:<command-name>` (e.g., `/my-plugin:hello`)
- Hooks: `<plugin-id>:<event-name>` (e.g., `my-plugin:PreToolUse`)

## Collision Handling

- **Plugin ID collision**: First loaded plugin wins. Later plugins with the same ID are skipped with a warning.
- **Component collision**: If two plugins somehow register the same namespaced ID, the first one wins.

## Migration from User Skills

To move an existing `~/.claude/skills/my-skill/` to a plugin:

```bash
# Create plugin structure
mkdir -p ~/.claude/plugins/me/skills

# Move skill
mv ~/.claude/skills/my-skill ~/.claude/plugins/me/skills/

# Create manifest
cat > ~/.claude/plugins/me/plugin.json << 'EOF'
{
  "id": "me",
  "version": "1.0.0"
}
EOF
```

Your skill is now namespaced as `me:my-skill`.

## CLI Commands

```bash
# List installed plugins
jellyclaw plugins list
jellyclaw plugins list --json

# Reload plugins (after changes)
jellyclaw plugins reload

# Diagnose issues
jellyclaw plugins doctor

# Use custom plugins directory
jellyclaw plugins list --plugins-dir /path/to/plugins
```

## Environment Variables

- `JELLYCLAW_PLUGINS_DIR`: Override the plugins directory (comma-separated for multiple)

## Distribution

Plugins are filesystem-only. There is no package manager. Distribute via:

- Git clone: `git clone https://github.com/user/plugin ~/.claude/plugins/plugin`
- Tarball: `tar -xzf plugin.tar.gz -C ~/.claude/plugins/`
- npm postinstall: Copy to `~/.claude/plugins/` in your package's postinstall script

The `jellyclaw plugins` command does NOT install plugins; it only manages what's already on disk.

## Security Notes

- Plugins can run arbitrary code via hooks and agents.
- Only install plugins from trusted sources.
- Review hook commands before enabling.
- There is no signing or trust attestation at this time.
