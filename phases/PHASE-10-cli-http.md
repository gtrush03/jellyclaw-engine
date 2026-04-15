---
phase: 10
name: "CLI + HTTP server + library entry points"
duration: "2 days"
depends_on: [02, 03, 08, 09]
blocks: [11, 12, 15]
---

# Phase 10 — Entry points

## Dream outcome

Three ways to use jellyclaw, all backed by the same core:
1. **CLI:** `jellyclaw run "build me a todo app" --output-format stream-json`
2. **HTTP:** `jellyclaw serve --port 8765` with Bearer-auth SSE streaming
3. **Library:** `import { createEngine } from "@jellyclaw/engine"` for embedding

All three share one `Engine` class; entry points are thin.

## Deliverables

- `engine/bin/jellyclaw` — CLI (Commander)
- `engine/src/cli/*.ts` — subcommands: `run`, `serve`, `sessions`, `skills`, `agents`, `mcp`, `config`, `doctor`
- `engine/src/server/http.ts` — Hono app with `/run`, `/events/:sessionId`, `/config`, `/health`
- `engine/src/index.ts` — library API: `createEngine`, `run`
- `docs/cli.md`, `docs/http-api.md`
- Tests (CLI smoke + HTTP auth + library)

## CLI flag set

```
jellyclaw run <prompt>
  --output-format stream-json|text|json
  --resume <id>
  --continue
  --permission-mode default|acceptEdits|bypassPermissions|plan
  --model <id>
  --provider primary|secondary
  --max-turns <n>
  --wish-id <id>
  --cwd <path>
  --verbose

jellyclaw serve
  --port <n>              # default 8765
  --host 127.0.0.1        # never 0.0.0.0 by default
  --auth-token <token>    # else reads JELLYCLAW_TOKEN env

jellyclaw doctor    # diagnose install: opencode version, providers reachable, mcp connects
jellyclaw config show
jellyclaw sessions {list|search|show|rm}
jellyclaw skills list
jellyclaw agents list
jellyclaw mcp list
```

## HTTP API

- `POST /run` — body `{ prompt, options }`, returns `{ sessionId }`
- `GET /events/:sessionId` — SSE stream of jellyclaw events
- `GET /config` — effective config (redacted)
- `GET /health` — `{ ok: true, version, uptime }`
- `POST /cancel/:sessionId`

Auth: `Authorization: Bearer <token>`. CORS default: `http://localhost:*` only. Binds `127.0.0.1` by default — explicit flag `--host 0.0.0.0` required for external binding (prints loud warning).

## Library API

```ts
import { createEngine } from "@jellyclaw/engine";
const engine = await createEngine({ config: loadConfig() });
for await (const ev of engine.run({ prompt: "hello" })) {
  console.log(ev);
}
```

## Step-by-step

### Step 1 — Engine class
`engine/src/engine.ts` orchestrates: load config → start OpenCode → build router → register tools/skills/agents/mcp → expose `run()` + `runStream()`.

### Step 2 — CLI
Use `commander@^12`. Each subcommand in its own file. `run` wires stdin (for piped prompts) and stdout (stream-json by default when `!isTTY`).

### Step 3 — HTTP server
Hono app. Middleware: auth, CORS, request logger. `/events/:sessionId` uses Hono's SSE helper; reconnection via `Last-Event-Id` header.

### Step 4 — `bin/jellyclaw`
```js
#!/usr/bin/env node
import("../dist/cli/main.js").catch((e) => { console.error(e); process.exit(1); });
```
`chmod +x`. In `package.json`: `"bin": { "jellyclaw": "bin/jellyclaw" }`.

### Step 5 — `doctor` subcommand
Checks:
- Node `>=20.18`
- `opencode-ai` version matches pin
- `ANTHROPIC_API_KEY` set, reachable
- `OPENROUTER_API_KEY` (optional)
- `~/.jellyclaw/` exists, writable
- Each MCP server connects
Output pretty table, exit 0 iff all pass.

### Step 6 — Tests
- CLI: spawn `jellyclaw run "test"`, assert stream-json lines valid
- HTTP: missing token → 401; valid token → 200 + SSE events
- Library: `for await` iterates events; error propagates

## Acceptance criteria

- [ ] `jellyclaw --help` lists all subcommands
- [ ] `jellyclaw run "hello"` returns a result
- [ ] `jellyclaw serve` refuses requests without token
- [ ] Binds 127.0.0.1 by default, warns on 0.0.0.0
- [ ] Library API works from a separate workspace package
- [ ] `doctor` catches broken install states
- [ ] CORS locked down

## Risks + mitigations

- **Accidental 0.0.0.0 exposure** → flag required + warn + refuse if no `--auth-token` set in 0.0.0.0 mode.
- **CLI flag drift from Claude Code** → document divergences in `docs/cli.md`.
- **SSE reconnection correctness** → Last-Event-Id replay from session store.

## Dependencies to install

```
commander@^12
hono@^4
@hono/node-server@^1
```

## Files touched

- `engine/bin/jellyclaw`
- `engine/src/cli/*.ts`
- `engine/src/server/http.ts`
- `engine/src/engine.ts`, `engine/src/index.ts`
- `engine/src/**/*.test.ts`
- `docs/{cli,http-api}.md`
