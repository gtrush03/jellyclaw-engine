# FAQ — jellyclaw-engine dashboard

Common failure modes, in order of how often you'll hit them.

---

### Q: Dashboard shows "0 prompts" in the center pane.

The prompts directory didn't populate, or the backend can't read it.

```bash
ls /Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-*/*.md | wc -l
```

- **Empty / error:** the prompt-generation step never ran. Re-run the agent prompt
  generation from the repo root (see `CLAUDE.md` → phase work).
- **Non-empty, but UI still says 0:** check the browser DevTools Network tab for the
  `/api/prompts` request. If it returned `{ prompts: [], count: 0 }`, the backend
  parser found no files — check the backend logs for `[prompt-parser] failed to
  parse` lines. If it returned a shape the frontend didn't understand, that's the
  envelope-vs-array drift in INTEGRATION-CHECKLIST.md §1.1.

---

### Q: SSE keeps disconnecting — LIVE badge flickers gray.

Open the backend logs (the `[server]` stream from `./start.sh`). If you see
`chokidar` errors, the OS file-watch limit is too low:

```bash
# macOS
sysctl kern.maxfiles kern.maxfilesperproc
# raise if needed:
sudo sysctl -w kern.maxfilesperproc=524288
```

If the log is clean, the issue is the client: `@microsoft/fetch-event-source` will
exponentially back off on transient errors. Check for a proxy between the client and
server (corporate VPN? some VPNs strip the blank line separator in SSE frames and
break framing). Test with curl:

```bash
curl -N http://127.0.0.1:5174/api/events
```

If curl stays open and receives heartbeats every 30 s, the server is fine — the
problem is in the browser-side proxy or extension.

---

### Q: Copy button copies nothing.

Browser clipboard permissions. Three things to check:

1. **User gesture.** `navigator.clipboard.writeText()` requires a user-initiated
   event chain. Our copy button is click-triggered, so this is fine in Chrome /
   Firefox / Edge. Safari has historically been pickier — open DevTools Console and
   look for `NotAllowedError: Write permission denied.`
2. **Permissions.** `chrome://settings/content/clipboard` (Chrome) or
   Safari → Preferences → Websites → Clipboard. Allow `127.0.0.1`.
3. **HTTPS.** The clipboard API requires a secure context. `127.0.0.1` counts as
   secure (per the spec), but some browser configurations disagree. If that's the
   case, use `localhost` instead — also secure context — by editing
   `dashboard/vite.config.ts` `server.host`.

---

### Q: Progress bar doesn't update after I edit COMPLETION-LOG.md.

First: confirm the edit actually landed on disk.

```bash
stat -f "%Sm" /Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md
```

If the mtime matches your edit, chokidar *should* have fired. Check `[server]` logs
for a line like:

```
[watch] completion-log-changed — /Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md
```

- **No log line:** your editor is using atomic saves (write to temp file, rename
  over target) and chokidar is missing the rename. The backend is already configured
  with `awaitWriteFinish: { stabilityThreshold: 200 }` which handles most cases; if
  your editor is unusual (JetBrains IDEs with "Safe Write" on) try disabling that.
- **Log line present, UI still static:** the SSE event name doesn't match what the
  frontend listens for. This is a known drift — see INTEGRATION-CHECKLIST.md §1.2.
  Backend emits `completion-log-changed`; frontend currently listens for
  `log-changed`.

---

### Q: The app looks unstyled (serif fonts, no gold, boxes everywhere).

Tailwind v4 didn't load. Three checks:

1. `dashboard/vite.config.ts` imports `@tailwindcss/vite` and includes
   `tailwindcss()` in `plugins`. Verify both.
2. `src/main.tsx` imports `./theme.css` (or equivalent). If that import is missing,
   no styles apply.
3. `@tailwindcss/vite` is installed: `ls dashboard/node_modules/@tailwindcss/vite`
   should exist. If not: `cd dashboard && npm install`.

---

### Q: `./start.sh` hangs at "installing frontend deps".

First-run `npm install` can take 60–90 s. If it's been longer than 2 minutes:

- `Ctrl-C`, then check for a stale lockfile: `cd dashboard && rm package-lock.json && ./start.sh`.
- Behind a corporate proxy? `npm config get proxy`. Configure if needed.
- Out of disk: `df -h`.

---

### Q: Port 5173 (or 5174) is already in use but I didn't start anything.

Previous `start.sh` crashed before `cleanup()` ran:

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/dashboard
./stop.sh
# if that doesn't work:
lsof -ti:5173,5174 | xargs kill -9
rm -f .dashboard-server.pid
```

---

### Q: How do I run the dashboard on a different port?

Not directly supported — many paths are hardcoded. Edit `start.sh`'s
`FRONTEND_PORT` and `BACKEND_PORT`, and `vite.config.ts`'s `server.port` and
`proxy['/api'].target`. They must stay consistent. Restart.

---

### Q: The backend reads from a hardcoded absolute path. How do I move the repo?

Edit `dashboard/server/src/lib/paths.ts` — change `REPO_ROOT` to the new absolute
path. Restart. A future enhancement would read this from an env var or auto-detect
via `process.cwd()` + git root discovery.
