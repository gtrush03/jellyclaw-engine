---
id: T3-02-container-entrypoint-supervisor
tier: 3
title: "Container entrypoint supervisor + /tui auth gate"
scope:
  - scripts/container-entrypoint.sh
  - Dockerfile
  - web-tui/ttyd-args.sh
  - engine/src/server/auth.ts
  - engine/src/server/routes/tui-handoff.ts
  - engine/src/server/routes/tui-handoff.test.ts
depends_on_fix:
  - T3-01-ttyd-dockerfile-caddyfile
tests:
  - name: entrypoint-executable
    kind: shell
    description: "entrypoint script is executable + shellcheck clean"
    command: |
      test -x scripts/container-entrypoint.sh
      bunx --bun shellcheck scripts/container-entrypoint.sh 2>/dev/null || npx -y shellcheck scripts/container-entrypoint.sh 2>/dev/null || docker run --rm -v $(pwd):/src koalaman/shellcheck /src/scripts/container-entrypoint.sh
    expect_exit: 0
    timeout_sec: 60
  - name: auth-gate-unit
    kind: shell
    description: "tui-handoff route tests pass (token issuance + verify)"
    command: "bun run test engine/src/server/routes/tui-handoff"
    expect_exit: 0
    timeout_sec: 60
  - name: dockerfile-cmd-updated
    kind: shell
    description: "Dockerfile CMD invokes the supervisor via tini"
    command: |
      set -e
      grep -qE 'ENTRYPOINT.*tini' Dockerfile
      grep -qE 'CMD.*container-entrypoint' Dockerfile
    expect_exit: 0
    timeout_sec: 5
human_gate: false
max_turns: 35
max_cost_usd: 10
max_retries: 3
estimated_duration_min: 25
---

# T3-02 — Entrypoint supervisor + auth gate

## Context
T3-01 landed the ttyd stage, Caddyfile, and placeholder runner. This prompt:
1. Replaces the placeholder CMD with `tini` + a 50-line supervisor that starts
   and watches jellyclaw-serve, ttyd, and Caddy — graceful shutdown on
   SIGTERM, non-zero exit if any of the three crash.
2. Adds `/v1/tui-token` — a short-lived OTP endpoint on jellyclaw-serve that
   the landing page's "Try it" CTA calls to get a one-time token; ttyd is
   then started with `--credential user:<token>` via an env var the supervisor
   reads at boot.

## Work

### 1. `scripts/container-entrypoint.sh`
```bash
#!/usr/bin/env bash
# Tiny supervisor — PID 1 is tini, which execs us. We fork jellyclaw-serve,
# ttyd, and caddy, then wait. If any dies, kill the others and exit with that
# child's exit code.
set -euo pipefail

log() { printf '[entrypoint] %s\n' "$*" >&2; }

: "${JELLYCLAW_TOKEN:?JELLYCLAW_TOKEN required (used by serve + tui handoff)}"
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY required}"

pids=()
trap 'kill ${pids[*]} 2>/dev/null; exit 143' TERM INT

# 1. jellyclaw-serve on 8080 (loopback only — Caddy proxies)
/usr/local/bin/jellyclaw serve \
  --host 127.0.0.1 --port 8080 \
  --auth-token "$JELLYCLAW_TOKEN" \
  --enable-tui-handoff \
  > /dev/stdout 2> /dev/stderr &
pids+=($!)
log "started jellyclaw-serve pid=$!"

# 2. ttyd on 7681 — reads credential from env written by handoff
/usr/local/bin/ttyd-args.sh > /dev/stdout 2> /dev/stderr &
pids+=($!)
log "started ttyd pid=$!"

# 3. Caddy on 80
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile \
  > /dev/stdout 2> /dev/stderr &
pids+=($!)
log "started caddy pid=$!"

# Wait for any child; whichever exits first triggers shutdown.
wait -n "${pids[@]}"
code=$?
log "child exited code=$code — shutting down siblings"
kill "${pids[@]}" 2>/dev/null || true
wait
exit "$code"
```
Shellcheck-clean.

### 2. Dockerfile CMD update
```dockerfile
# tini as PID 1 forwards signals
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/usr/local/bin/container-entrypoint.sh"]
```
Also:
```dockerfile
COPY scripts/container-entrypoint.sh /usr/local/bin/container-entrypoint.sh
RUN chmod +x /usr/local/bin/container-entrypoint.sh
```

### 3. `engine/src/server/routes/tui-handoff.ts`
New route `POST /v1/tui-token`:
- Auth: same bearer seam (`engine/src/server/auth.ts`).
- Body: `{ ttl_seconds?: number }` (default 120, max 600).
- Returns: `{ token: string, expires_at: ISO8601 }`.
- Token is HMAC-SHA256 of `${serverSessionId}:${random32}` keyed on
  `JELLYCLAW_TOKEN`, base64url encoded, 24 bytes output.
- Keeps an in-memory ring of issued tokens (last 100) + expiry. GC on lookup.
- Export `verifyTuiToken(token: string): boolean` for ttyd's auth.

### 4. ttyd integration
Add to `web-tui/ttyd-args.sh`:
```bash
# If JELLYCLAW_TUI_AUTH=optional, no auth (dev/local). Otherwise require
# Basic with user=tui, password=<token> from handoff.
if [[ "${JELLYCLAW_TUI_AUTH:-required}" == "required" ]]; then
  exec /usr/local/bin/ttyd ... --credential "tui:$(jellyclaw-internal-tui-bridge)"
fi
```
Where `jellyclaw-internal-tui-bridge` is a tiny helper that calls
`http://127.0.0.1:8080/v1/tui-token` with the server token and prints the
returned token. Add that helper as a subcommand or a 10-line node script
in `engine/bin/jellyclaw-tui-bridge`.

Alternatively — simpler for the first alpha — skip the OTP and use a static
`JELLYCLAW_TUI_PASSWORD` env var enforced by ttyd. If the OTP flow is too
much for this prompt, emit `FAIL: T3-02 OTP flow unreachable — fell back to
static password; split OTP to a follow-up prompt`.

### 5. Tests — `engine/src/server/routes/tui-handoff.test.ts`
- Token issuance requires auth header.
- Token verifies within TTL.
- Token rejected after TTL.
- Token rejected if different server token at boot (cross-session poisoning).

## Acceptance criteria
- All 3 tests pass.
- `shellcheck scripts/container-entrypoint.sh` clean.
- `docker build .` still succeeds.
- No HTTP port binds in engine code changed beyond the new route.

## Out of scope
- E2E Playwright — T3-03.
- WebSocket-level ttyd auth (the `--credential` Basic auth is enough for alpha).

## Verification the worker should self-run before finishing
```bash
shellcheck scripts/container-entrypoint.sh
bun run test engine/src/server/routes/tui-handoff
bun run typecheck && bun run lint
grep -q 'CMD.*container-entrypoint' Dockerfile
echo "DONE: T3-02-container-entrypoint-supervisor"
```
