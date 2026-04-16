# 🪼 Getting started (60 seconds)

From a cold machine to a live TUI prompt in under six commands. Each step has
a "you should see X" check — if the check fails, skip to
[Troubleshooting](#troubleshooting) before moving on.

---

## Prereqs

- **Node ≥ 20.6** (`node -v`) or **Bun ≥ 1.1** (`bun -v`)
- An **Anthropic API key** — grab one at https://console.anthropic.com/
- git, curl, a shell that understands `export`

## Step 1 — Clone

```bash
git clone https://github.com/gtrush03/jellyclaw-engine.git
cd jellyclaw-engine
```

**You should see:** a checked-out repo with `engine/`, `docs/`, `phases/` at
the top level.

## Step 2 — Install

```bash
bun install
```

**You should see:** `bun install` finishes without errors and prints a
"Done" line. If `postinstall` fails on a patch, see
[Troubleshooting](#patch-failures).

## Step 3 — Build

```bash
bun run build
```

**You should see:** `engine/dist/cli/main.js` created. `ls engine/dist/cli/main.js`
should return a path, not an error.

## Step 4 — Set your API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

(Optional — if you skip this, the TUI will prompt you on first launch and
persist the key to `~/.jellyclaw/credentials.json` at `0600`.)

**You should see:** `echo $ANTHROPIC_API_KEY` prints the key you pasted.

## Step 5 — Launch the TUI

```bash
./engine/bin/jellyclaw tui
```

> The `jellyclaw` shim uses bun (TUI imports TSX dynamically). The
> `jellyclaw-serve` shim uses node. Both live at `engine/bin/`.

**You should see:** the splash screen:

```
🪼  jellyclaw           open-source agent runtime · 1M context
    ──────────────────────────────────────────────────────────
    claude-sonnet-4-5  ·  ~/jellyclaw-engine

    Type a prompt or / for commands.

    ›
```

A blinking cursor means jellyclaw is live.

## Step 6 — Say hello

Type `hello world` and press Enter. The assistant line streams in. When it
finishes, try:

- `/help` — list slash commands
- `/cost` — show the tokens you just burned (pennies)
- `/cwd` — print working directory
- `/end` — exit (or Ctrl-C)

**You're done.** You just ran a full agent loop locally, in TypeScript you
can read.

---

## What next?

- **Run a headless prompt** (no TUI) — `./engine/bin/jellyclaw run "hello"`.
- **Spin up the HTTP server** — `./engine/bin/jellyclaw-serve --port 8765`
  and POST to `/v1/runs`. Details in [`http-api.md`](http-api.md).
- **Configure MCP servers** — [`mcp.md`](mcp.md).
- **Understand the architecture** — [`ARCHITECTURE.md`](ARCHITECTURE.md).
- **Browse the spec** — [`../engine/SPEC.md`](../engine/SPEC.md).

## Troubleshooting

### Patch failures

`postinstall` runs `patch-package` against `patches/`. If a patch refuses to
apply cleanly, the vendored runtime version probably drifted. Run:

```bash
bun run verify:patches
```

If patches are dirty, check out a clean commit or regenerate them.

### `ANTHROPIC_API_KEY is not set`

The TUI will drop to a hidden-paste prompt on first launch and store the key
at `~/.jellyclaw/credentials.json`. To rotate later, run:

```bash
./engine/bin/jellyclaw key
```

### Port already in use (`jellyclaw serve`)

Pass a different port: `--port 8766`. The TUI picks a random loopback port
so this never happens for `jellyclaw tui`.

### `command not found: bun`

Install bun from https://bun.sh or substitute `npm install` / `npm run build`
— the `package.json` scripts are bun-flavored but node-compatible. The `tui`
subcommand itself runs under node.

### Nothing happens after `tui` launch

Check `~/.jellyclaw/logs/` for `engine.jsonl`. If the file has errors about
missing credentials, go back to step 4.

---

More help lives in the `docs/` directory — every module has its own reference
page. The most-linked are [`cli.md`](cli.md), [`http-api.md`](http-api.md),
[`tui.md`](tui.md), [`providers.md`](providers.md), and
[`permissions.md`](permissions.md).
