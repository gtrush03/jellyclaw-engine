# Deployment

This dashboard is designed to run on your own machine. There is no cloud deploy target — and you probably shouldn't create one. That said, three real scenarios come up.

## 1. Local production bundle

For day-to-day use, `./start.sh` (dev mode) is fine. If you want the smaller footprint of a compiled bundle:

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/dashboard

# build the React SPA → dashboard/dist/
pnpm build

# build the server → dashboard/server/dist/
cd server && pnpm build && cd ..

# run server in prod mode — serves API + static UI on 5174
NODE_ENV=production node server/dist/index.js
```

In production mode the Hono server mounts `dashboard/dist/` as static assets and serves the SPA on the same port as the API (default `5174`). Vite is not running, so open `http://127.0.0.1:5174` — not 5173.

Pros: one process, smaller memory, faster cold start.
Cons: no HMR — you must rebuild after changes. Only worth doing if you leave the dashboard running all day.

## 2. Auto-start on login (macOS)

The `launchd/com.jellyclaw.dashboard.plist` file ships a LaunchAgent that runs `start.sh` automatically when you log in.

```bash
cp launchd/com.jellyclaw.dashboard.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.jellyclaw.dashboard.plist
```

Logs stream to `/tmp/jellyclaw-dashboard.log` and `/tmp/jellyclaw-dashboard.err.log`. To restart after a code change: `launchctl kickstart -k gui/$(id -u)/com.jellyclaw.dashboard`. To uninstall, see the commented header of the plist itself.

**Caveat:** launchd does not source your interactive shell, so if your Node install lives under `nvm` make sure `~/.bash_profile` or `~/.zprofile` sources nvm and that `PATH` in the plist's `EnvironmentVariables` block includes the right directories. The default plist assumes Homebrew Node at `/opt/homebrew/bin`.

## 3. Remote access via Tailscale / Cloudflare Tunnel

**Not recommended.** This dashboard has no auth. It was designed for `127.0.0.1` only. Exposing it anywhere else means anyone who can reach the host can read your prompts, your completion log, and — via the filesystem API — potentially write to the repo.

If you absolutely must:

1. Put the dashboard behind Tailscale or a Cloudflare Tunnel that already enforces identity (Tailscale SSH, Cloudflare Access with an email allowlist).
2. Change the bind in `server/src/index.ts` from `127.0.0.1` to `0.0.0.0` **only on the interface the tunnel exposes**, not the public LAN.
3. Tighten the CORS allowlist in Hono to include exactly the hostname the tunnel serves.
4. Add a simple shared-secret header check in a middleware — even weak auth is better than none once the socket leaves loopback.
5. Disable any filesystem-write routes if the server ever gains them.

## Security hardening checklist

- [ ] Server binds `127.0.0.1` only (verify with `lsof -iTCP -sTCP:LISTEN | grep 5174`).
- [ ] CORS allowlist contains exactly `http://127.0.0.1:5173` (and `http://localhost:5173` if you use that).
- [ ] No filesystem-write endpoints exposed without an explicit allowlist of paths under `jellyclaw-engine/`.
- [ ] `.env`, `*.key`, and other secrets excluded from the prompt reader's glob.
- [ ] `dashboard/.gitignore` excludes `.dashboard-server.pid` and `*.log`.
- [ ] If you enabled launchd, `/tmp/jellyclaw-dashboard.err.log` is reviewed periodically for stack traces that might leak paths.
- [ ] Before exposing beyond loopback: add auth, reduce surface area, and audit every route's `req.json()` parser for path traversal.
