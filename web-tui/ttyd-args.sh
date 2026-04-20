#!/usr/bin/env bash
# ttyd wrapper — configures flags for `jellyclaw tui`.
#
# Auth model:
#   JELLYCLAW_TUI_AUTH=required (default) → ttyd enforces HTTP Basic with
#     user "tui" and password drawn from JELLYCLAW_TUI_PASSWORD. The landing
#     page's "Try it" CTA hits POST /v1/tui-token to mint a short-lived OTP
#     and forwards it to the browser. (Full OTP handoff wiring — including
#     the `jellyclaw-internal-tui-bridge` helper — lands in a follow-up.)
#   JELLYCLAW_TUI_AUTH=optional → no credential flag. Local/dev only.
#
# Either way, ttyd binds to 127.0.0.1 and Caddy is the only public ingress.

set -euo pipefail

common_args=(
  --port 7681
  --interface 127.0.0.1
  --base-path /tui
  --writable
  --check-origin
  --max-clients 10
  --terminal-type xterm-256color
)

mode="${JELLYCLAW_TUI_AUTH:-required}"

if [[ "${mode}" == "required" ]]; then
  : "${JELLYCLAW_TUI_PASSWORD:?JELLYCLAW_TUI_PASSWORD required when JELLYCLAW_TUI_AUTH=required}"
  exec /usr/local/bin/ttyd \
    "${common_args[@]}" \
    --credential "tui:${JELLYCLAW_TUI_PASSWORD}" \
    /usr/local/bin/jellyclaw tui
fi

# optional / dev mode — no credential gate.
exec /usr/local/bin/ttyd \
  "${common_args[@]}" \
  /usr/local/bin/jellyclaw tui
