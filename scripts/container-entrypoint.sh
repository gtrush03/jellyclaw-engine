#!/usr/bin/env bash
# container-entrypoint.sh — tiny supervisor for the jellyclaw runtime image.
#
# PID 1 is tini (set via ENTRYPOINT). tini execs this script, which forks
# the three long-running processes (jellyclaw-serve, ttyd, Caddy) and waits.
# When any child exits, the siblings are killed and the script exits with
# the first child's status — Fly.io then restarts the VM.
#
# Environment contract (required):
#   JELLYCLAW_TOKEN     — bearer token for jellyclaw-serve (also signs OTPs)
#   ANTHROPIC_API_KEY   — forwarded to the engine's provider layer
#
# Environment contract (optional):
#   JELLYCLAW_TUI_AUTH  — "required" (default) enables ttyd --credential gate,
#                         "optional" disables it (dev-only).

set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

: "${JELLYCLAW_TOKEN:?JELLYCLAW_TOKEN required (used by serve + tui handoff)}"
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY required}"

pids=()

# Invoked via `trap` — shellcheck cannot see indirect callers, hence SC2329 disable.
# shellcheck disable=SC2329
shutdown() {
  log "received signal — stopping ${#pids[@]} children"
  if [[ ${#pids[@]} -gt 0 ]]; then
    kill "${pids[@]}" 2>/dev/null || true
  fi
  wait || true
  exit 143
}
trap shutdown TERM INT

# 1. jellyclaw-serve on 127.0.0.1:8080 (loopback only — Caddy proxies)
node /app/engine/dist/cli/main.js serve \
  --host 127.0.0.1 --port 8080 \
  --auth-token "$JELLYCLAW_TOKEN" \
  --i-know-what-im-doing &
pids+=("$!")
log "started jellyclaw-serve pid=$!"

# 2. ttyd wrapper on 127.0.0.1:7681 — invokes `jellyclaw tui`.
/usr/local/bin/ttyd-args.sh &
pids+=("$!")
log "started ttyd pid=$!"

# 3. Caddy on :80 · before starting, hash the TUI password for cookie-auth
#    Safari on iOS does not send HTTP Basic Auth on WebSocket upgrades
#    (WebKit bug since 2012); we rely on Caddy cookie-or-basic auth so the
#    cookie rides the WS handshake.
if [[ -n "${JELLYCLAW_TUI_PASSWORD:-}" ]]; then
  JC_TUI_PASS_HASH=$(caddy hash-password --plaintext "${JELLYCLAW_TUI_PASSWORD}")
  export JC_TUI_PASS_HASH
  # Also base64-encode the basic auth credentials so we can inject the
  # Authorization header for ttyd (which still checks --credential).
  JC_TUI_BASIC_B64=$(printf 'tui:%s' "${JELLYCLAW_TUI_PASSWORD}" | base64)
  export JC_TUI_BASIC_B64
  log "tui password hashed for Caddy basicauth"
fi

caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
pids+=("$!")
log "started caddy pid=$!"

# Wait for any child; whichever exits first triggers shutdown of the others.
set +e
wait -n "${pids[@]}"
code=$?
set -e

log "child exited code=${code} — shutting down siblings"
kill "${pids[@]}" 2>/dev/null || true
wait || true
exit "${code}"
