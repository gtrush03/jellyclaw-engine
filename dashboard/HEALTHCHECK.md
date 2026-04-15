# HEALTHCHECK — is my dashboard working?

A fast runbook. Top to bottom, stop when something fails.

## 1. Quick pings

```bash
# backend responds
curl -sS -o /dev/null -w "backend: %{http_code}\n" http://127.0.0.1:5174/api/prompts-health
# expect: backend: 200

# frontend responds
curl -sS -o /dev/null -w "frontend: %{http_code}\n" http://127.0.0.1:5173/
# expect: frontend: 200

# status snapshot
curl -s http://127.0.0.1:5174/api/status | head -c 200
# expect: JSON starting with {"lastUpdated":...

# SSE stream opens and stays open
timeout 5 curl -N http://127.0.0.1:5174/api/events | head -c 200
# expect: event: heartbeat\ndata: {"event":"heartbeat","at":"..."}
```

All four return expected output → dashboard is healthy; stop here.

## 2. Diagnose from the logs

Server logs go to stdout under `./start.sh` with the `[server]` prefix. If `start.sh`
has scrolled away, restart it and watch the startup line. You're looking for:

```
[server] Listening on 0.0.0.0:5174   (or similar)
```

If you see `EADDRINUSE`, another process owns the port.

## 3. Port conflict resolution

```bash
lsof -i :5173,5174
# if anything is there you didn't expect, kill:
lsof -ti:5173,5174 | xargs kill -9
```

Then re-run `./start.sh`.

## 4. Version check

```bash
node --version   # must be >= 20.6.0 (see server/package.json engines)
npm --version
```

If Node is older: `nvm install 20 && nvm use 20`.

## 5. Fresh install

When anything is "weird" and you can't explain it:

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/dashboard
./stop.sh
rm -rf node_modules server/node_modules
./start.sh
```

Takes 30–90 s to reinstall both `node_modules` trees. `start.sh` detects missing
`node_modules` and runs `npm install` / `pnpm install` automatically.

## 6. Component-level checks

```bash
# Parser finds all 67 prompt files
ls /Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-*/*.md | wc -l
# expect: 67 (READMEs and DEPENDENCY-GRAPH are excluded by the parser)

# Backend reports correct count
curl -s http://127.0.0.1:5174/api/prompts | jq '.count'
# expect: 60+ (equals above minus any fixtures + excluded files)

# All 21 phases detected (0–19 + 10.5)
curl -s http://127.0.0.1:5174/api/phases | jq '.count'
# expect: 21

# SSE watcher reacts to log edits (run in two terminals)
# term 1:
curl -N http://127.0.0.1:5174/api/events
# term 2:
touch /Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md
# term 1 should print within 300 ms:
#   event: completion-log-changed
#   data: {"event":"completion-log-changed","path":"...","at":"..."}
```

## 7. macOS file-watch limits

If chokidar logs warnings about watchers or crashes under load:

```bash
sysctl kern.maxfiles   # default 245760 — usually fine
sysctl kern.maxfilesperproc   # default 122880 — usually fine
```

If a process is actually hitting the cap, raise it:

```bash
sudo sysctl -w kern.maxfilesperproc=524288
```

## 8. Nothing else works

Capture logs:

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/dashboard
./start.sh 2>&1 | tee /tmp/dashboard-start.log
```

Reproduce the failure, Ctrl-C, send `/tmp/dashboard-start.log` along with:

```bash
node --version
npm --version
uname -a
lsof -i:5173,5174
```
