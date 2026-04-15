#!/usr/bin/env bash
# migrate-from-claurst.sh
#
# One-shot migration from Claurst (~/.claurst/) to jellyclaw (~/.jellyclaw/).
# Safe to re-run: backs up existing ~/.jellyclaw to a timestamped bak before
# making any changes.
#
# Steps:
#   1. Back up ~/.claurst/ to ~/.claurst.bak.<ts>/
#   2. Create ~/.jellyclaw/{skills,hooks,sessions,logs}
#   3. Symlink each skill from ~/.claurst/skills/* into ~/.jellyclaw/skills/
#   4. Convert .claurst/settings.json → .jellyclaw/settings.json (jq)
#   5. Convert .claurst/mcp.json (if present) → .jellyclaw/mcp.json
#   6. Write .env.jellyclaw for Genie to source
#   7. Install hook stubs
#   8. Print next-step instructions
#
# Requires: bash >=4, jq, ln, cp, mkdir. All standard on macOS + Homebrew jq.

set -euo pipefail

# ── config ────────────────────────────────────────────────────────────────────
CLAURST_DIR="${CLAURST_DIR:-$HOME/.claurst}"
JELLYCLAW_DIR="${JELLYCLAW_DIR:-$HOME/.jellyclaw}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
ENV_OUT="${ENV_OUT:-$REPO_ROOT/.env.jellyclaw}"

BLUE='\033[1;34m'
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
RESET='\033[0m'

log()   { printf "${BLUE}[migrate]${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}[migrate] ✓${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}[migrate] !${RESET} %s\n" "$*"; }
fail()  { printf "${RED}[migrate] ✗${RESET} %s\n" "$*" >&2; exit 1; }

# ── preflight ─────────────────────────────────────────────────────────────────
command -v jq >/dev/null 2>&1 || fail "jq is required. brew install jq"

log "Claurst dir:   $CLAURST_DIR"
log "jellyclaw dir: $JELLYCLAW_DIR"
log "Timestamp:     $TIMESTAMP"

if [ ! -d "$CLAURST_DIR" ]; then
  warn "No ~/.claurst/ directory found — creating a fresh jellyclaw install."
  FRESH_INSTALL=1
else
  FRESH_INSTALL=0
fi

# ── 1. Back up existing state ─────────────────────────────────────────────────
if [ "$FRESH_INSTALL" -eq 0 ]; then
  BAK="$HOME/.claurst.bak.$TIMESTAMP"
  log "Backing up $CLAURST_DIR → $BAK"
  cp -a "$CLAURST_DIR" "$BAK"
  ok "Backup written to $BAK"
fi

if [ -d "$JELLYCLAW_DIR" ]; then
  JBAK="$HOME/.jellyclaw.bak.$TIMESTAMP"
  log "Existing $JELLYCLAW_DIR found — moving to $JBAK"
  mv "$JELLYCLAW_DIR" "$JBAK"
  ok "Existing jellyclaw state preserved at $JBAK"
fi

# ── 2. Create ~/.jellyclaw/ skeleton ──────────────────────────────────────────
log "Creating $JELLYCLAW_DIR skeleton…"
mkdir -p "$JELLYCLAW_DIR"/{skills,hooks,sessions,logs,traces}
ok "Created skills/ hooks/ sessions/ logs/ traces/"

# ── 3. Symlink skills ─────────────────────────────────────────────────────────
if [ "$FRESH_INSTALL" -eq 0 ] && [ -d "$CLAURST_DIR/skills" ]; then
  log "Symlinking skills from $CLAURST_DIR/skills/"
  skill_count=0
  # shellcheck disable=SC2045
  for skill_path in "$CLAURST_DIR"/skills/*; do
    [ -e "$skill_path" ] || continue
    name="$(basename "$skill_path")"
    ln -sfn "$skill_path" "$JELLYCLAW_DIR/skills/$name"
    skill_count=$((skill_count + 1))
  done
  ok "Symlinked $skill_count skill(s) from Claurst"
else
  warn "No Claurst skills to migrate."
fi

# Also symlink the bundled repo skills, if any.
if [ -d "$REPO_ROOT/skills" ]; then
  for skill_path in "$REPO_ROOT"/skills/*; do
    [ -e "$skill_path" ] || continue
    name="$(basename "$skill_path")"
    # Don't clobber a user skill of the same name.
    if [ ! -e "$JELLYCLAW_DIR/skills/$name" ]; then
      ln -sfn "$skill_path" "$JELLYCLAW_DIR/skills/$name"
    fi
  done
  ok "Ensured bundled repo skills present"
fi

# Keep ~/.claurst/skills resolvable for in-flight prompts that reference it.
if [ ! -e "$CLAURST_DIR/skills" ] && [ -d "$JELLYCLAW_DIR/skills" ]; then
  mkdir -p "$CLAURST_DIR"
  ln -sfn "$JELLYCLAW_DIR/skills" "$CLAURST_DIR/skills"
  ok "Created $CLAURST_DIR/skills → $JELLYCLAW_DIR/skills back-symlink"
fi

# ── 4. Convert settings.json ──────────────────────────────────────────────────
SRC_SETTINGS="$CLAURST_DIR/settings.json"
DST_SETTINGS="$JELLYCLAW_DIR/settings.json"

if [ -f "$SRC_SETTINGS" ]; then
  log "Converting $SRC_SETTINGS → $DST_SETTINGS"
  jq '
    {
      "$schema": "https://opencode.ai/schema/1.4.4",
      model: {
        default: "claude-sonnet-4-6",
        provider_priority: ["anthropic", "openrouter"]
      },
      permissions: {
        mode: (.config.permission_mode // "bypass"
               | if . == "bypass-permissions" then "bypass" else . end),
        allow_tools: (.config.allowed_tools // [
          "Bash","Read","Write","Edit","Glob","Grep",
          "WebFetch","WebSearch","Task","TodoWrite","NotebookEdit",
          "mcp__playwright"
        ])
      },
      mcp: {
        servers: (
          (.config.mcp_servers // [])
          | map({ (.name): { type: (.type // "stdio"),
                             command: .command,
                             args: .args,
                             env: (.env // {}) } })
          | add // {}
          # If Playwright is missing, add the pinned version.
          | if has("playwright") then .
            else . + { playwright: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@playwright/mcp@0.0.41",
                     "--cdp-endpoint", "http://127.0.0.1:9222"],
              env: {}
            } } end
          # Pin Playwright MCP to 0.0.41 even if source had @latest.
          | .playwright.args |= map(if test("^@playwright/mcp") then "@playwright/mcp@0.0.41" else . end)
        )
      },
      hooks: {
        PreToolUse:  [],
        PostToolUse: [],
        SubagentStart: [],
        SubagentStop:  []
      }
    }
  ' "$SRC_SETTINGS" > "$DST_SETTINGS"
  ok "Wrote $DST_SETTINGS"
else
  log "No Claurst settings.json found — writing default jellyclaw settings."
  cat > "$DST_SETTINGS" <<'JSON'
{
  "$schema": "https://opencode.ai/schema/1.4.4",
  "model": {
    "default": "claude-sonnet-4-6",
    "provider_priority": ["anthropic", "openrouter"]
  },
  "permissions": {
    "mode": "bypass",
    "allow_tools": [
      "Bash","Read","Write","Edit","Glob","Grep",
      "WebFetch","WebSearch","Task","TodoWrite","NotebookEdit",
      "mcp__playwright"
    ]
  },
  "mcp": {
    "servers": {
      "playwright": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@playwright/mcp@0.0.41", "--cdp-endpoint", "http://127.0.0.1:9222"],
        "env": {}
      }
    }
  },
  "hooks": {
    "PreToolUse": [],
    "PostToolUse": [],
    "SubagentStart": [],
    "SubagentStop": []
  }
}
JSON
  ok "Wrote default $DST_SETTINGS"
fi

# ── 5. Convert mcp.json (if present) ──────────────────────────────────────────
SRC_MCP="$CLAURST_DIR/mcp.json"
DST_MCP="$JELLYCLAW_DIR/mcp.json"
if [ -f "$SRC_MCP" ]; then
  log "Converting $SRC_MCP → $DST_MCP"
  jq '
    {
      mcpServers: (
        (.mcpServers // .servers // {})
        | to_entries
        | map({ key: .key, value: {
              type: (.value.type // "stdio"),
              command: .value.command,
              args: (.value.args // []),
              env: (.value.env // {})
          }})
        | from_entries
      )
    }
  ' "$SRC_MCP" > "$DST_MCP"
  ok "Wrote $DST_MCP"
else
  log "No standalone mcp.json found (common — Claurst embedded MCP in settings)"
fi

# ── 6. .env.jellyclaw — Genie-consumable env stub ────────────────────────────
log "Writing $ENV_OUT (Genie sources this if present)"
cat > "$ENV_OUT" <<ENV
# .env.jellyclaw — generated by migrate-from-claurst.sh @ $TIMESTAMP
# Source this file from Genie's .env:
#   set -a; source $ENV_OUT; set +a

# Engine selection
GENIE_ENGINE=jellyclaw

# Binary (adjust if installed elsewhere)
JELLYCLAW_BIN=${JELLYCLAW_BIN:-$(command -v jellyclaw 2>/dev/null || echo "/usr/local/bin/jellyclaw")}
JELLYCLAW_CONFIG_PATH=$JELLYCLAW_DIR

# Provider priority: Anthropic direct first, OpenRouter fallback
# ANTHROPIC_API_KEY=sk-ant-...   # set in your secret manager
# OPENROUTER_API_KEY=sk-or-v1-... # set in your secret manager

# Optional overrides
# GENIE_PROVIDER=anthropic        # force provider, skip fallback
# GENIE_RESUME_SESSION_ID=        # set only when resuming
ENV
ok "Wrote $ENV_OUT"

# ── 7. Hook stubs ─────────────────────────────────────────────────────────────
log "Installing Telegram hook stubs in $JELLYCLAW_DIR/hooks/"
cat > "$JELLYCLAW_DIR/hooks/telegram-pre-bash.sh" <<'HOOK'
#!/usr/bin/env bash
# PreToolUse hook for Bash — fires before every Bash invocation.
# Receives tool name + input JSON on stdin (OpenCode 1.4.4 hook protocol).
# Stays quiet by default; dispatcher.mjs already reports tool starts.
read -r payload
# Example: notify on vercel deploys only.
if echo "$payload" | grep -q 'vercel deploy'; then
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] && \
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      --data-urlencode text="🚀 Deploying to Vercel…" >/dev/null 2>&1 || true
fi
exit 0
HOOK
chmod +x "$JELLYCLAW_DIR/hooks/telegram-pre-bash.sh"

cat > "$JELLYCLAW_DIR/hooks/telegram-post-bash.sh" <<'HOOK'
#!/usr/bin/env bash
# PostToolUse hook for Bash — fires after every Bash invocation.
read -r payload
# Extract any vercel.app URL from the tool result and report it.
url=$(echo "$payload" | grep -oE 'https://[a-z0-9-]+\.vercel\.app' | head -1)
if [ -n "$url" ]; then
  [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] && \
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d chat_id="${TELEGRAM_CHAT_ID}" \
      --data-urlencode text="✅ Deployed → $url" >/dev/null 2>&1 || true
fi
exit 0
HOOK
chmod +x "$JELLYCLAW_DIR/hooks/telegram-post-bash.sh"
ok "Hook stubs installed (executable)"

# ── 8. Next-step instructions ─────────────────────────────────────────────────
cat <<NEXT

${GREEN}Migration complete.${RESET}

Next steps:

  1. Ensure your Anthropic and OpenRouter keys are exported:
     export ANTHROPIC_API_KEY=sk-ant-...
     export OPENROUTER_API_KEY=sk-or-v1-...

  2. Source the generated env into Genie's startup:
     Append to /Users/gtrush/Downloads/genie-2.0/.env:
         # jellyclaw overlay
         $(printf 'source %s' "$ENV_OUT")
     (or copy/paste the contents of $ENV_OUT directly)

  3. Smoke test the engine standalone:
       jellyclaw run -p "say hi" --config-dir $JELLYCLAW_DIR

  4. Restart the Genie server:
       launchctl kickstart -k gui/\$(id -u)/com.genie.server

  5. (Optional) Enable the long-lived jellyclaw daemon for ~60ms dispatch:
       launchctl load -w ~/Library/LaunchAgents/com.genie.jellyclaw-serve.plist

Rollback: set GENIE_ENGINE=claurst in Genie's .env and restart.

Backups (safe to delete after a week of stable operation):
NEXT
[ "$FRESH_INSTALL" -eq 0 ] && echo "  ~/.claurst.bak.$TIMESTAMP"
[ -d "$JBAK" ] && echo "  $JBAK" || true

exit 0
