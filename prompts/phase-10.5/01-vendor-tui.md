# Phase 10.5 — Vendored TUI — Prompt 01: Vendor OpenCode TUI into `@jellyclaw/engine`

**When to run:** After Phase 10 is fully ✅ in `COMPLETION-LOG.md` (10.01 CLI, 10.02 HTTP, 10.03 library API must all be green).
**Estimated duration:** ~90 minutes
**New session?** Yes — always start a fresh Claude Code session per prompt
**Model:** Claude Opus 4.6 (1M context)

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/STARTUP-TEMPLATE.md -->
<!-- Point the startup prompt at /Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-10.5-tui.md -->
<!-- STOP if Phase 10 is not ✅ in COMPLETION-LOG.md. The TUI cannot be wired until createEngine + the HTTP server + the CLI are shipped. -->
<!-- END paste -->

---

## Context (why this phase exists)

Jellyclaw's Phase 10 gave us three entry points — CLI, HTTP, library — but the CLI is headless
(line-oriented, no interactive surface). George wants a terminal UI that looks and feels like
Claude Code / OpenCode: scrollback, streaming text, tool-call rendering, session sidebar,
permission prompts, theme switching, slash-command palette.

Building that from scratch is a 3–6 week project. **OpenCode already ships it**, written in
TypeScript + Solid.js + OpenTUI, and it talks to its own HTTP server via a typed SDK. Our HTTP
server (Phase 10.02) is close enough in shape that we can **vendor the entire TUI subtree** and
bridge it to `@jellyclaw/engine` with a thin SDK-shaped adapter.

This prompt does exactly that vendoring + adapter work. No new UI is designed here. Rebranding
is minimal (user-visible strings only). Licensing is preserved (MIT, with attribution).

---

## Research task

Read the following, in order. Do not skim — the adapter surface depends on knowing precisely
which SDK methods the TUI calls.

1. **Read the template for this prompt's shape:**
   `/Users/gtrush/Downloads/jellyclaw-engine/prompts/phase-10/03-library-api.md`
   Match its section headers. This prompt mirrors that structure.

2. **Read Phase 10.5's phase doc (if it exists; create a stub if missing):**
   `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-10.5-tui.md`

3. **Read the upstream OpenCode TUI entry points:**
   - `/Users/gtrush/Downloads/Jelly-Claw/engine/opencode/packages/opencode/src/cli/cmd/tui/app.tsx`
   - `/Users/gtrush/Downloads/Jelly-Claw/engine/opencode/packages/opencode/src/cli/cmd/tui/attach.ts`
   - `/Users/gtrush/Downloads/Jelly-Claw/engine/opencode/packages/opencode/src/cli/cmd/tui/worker.ts`
   - `/Users/gtrush/Downloads/Jelly-Claw/engine/opencode/packages/opencode/src/cli/cmd/tui/event.ts`
   - `/Users/gtrush/Downloads/Jelly-Claw/engine/opencode/packages/opencode/src/cli/cmd/tui/thread.ts`

4. **Read every route:**
   - `routes/home.tsx`
   - `routes/session/index.tsx`
   - `routes/session/permission.tsx`
   - `routes/session/question.tsx`
   - `routes/session/sidebar.tsx`
   - `routes/session/footer.tsx`
   - `routes/session/dialog-timeline.tsx`
   - `routes/session/dialog-message.tsx`
   - `routes/session/dialog-subagent.tsx`
   - `routes/session/dialog-fork-from-timeline.tsx`
   - `routes/session/subagent-footer.tsx`

5. **Read every `context/*.tsx` provider** (15 files — `sdk`, `sync`, `local`, `kv`, `keybind`,
   `theme`, `route`, `project`, `prompt`, `exit`, `args`, `tui-config`, `event`, `helper`,
   `directory`, `plugin-keybinds`). Note which `@opencode-ai/sdk/v2` methods each one calls —
   grep for `sdk.` to enumerate.

6. **Read every `component/*` and `component/prompt/*` file:**
   - `component/border.tsx`, `logo.tsx`, `spinner.tsx`, `startup-loading.tsx`, `todo-item.tsx`,
     `error-component.tsx`, `plugin-route-missing.tsx`, `textarea-keybindings.ts`
   - All ~17 `component/dialog-*.tsx` files
   - `component/prompt/` subtree (history, frecency, stash)

7. **Read every `ui/*` file** (dialog, dialog-alert, dialog-confirm, dialog-select,
   dialog-prompt, dialog-help, dialog-export-options, link, spinner, toast).

8. **Read the upstream non-TUI files the TUI imports** (these travel with the vendoring):
   - `packages/opencode/src/config/tui.ts` — `TuiConfig` schema
   - `packages/opencode/src/command/index.ts` — command registry
   - `packages/opencode/src/bus.ts` — BusEvent definitions
   - `packages/opencode/src/project/instance.ts` — project instance accessor used by the TUI
   - `packages/opencode/src/session/schema.ts` — session/message/part Zod schemas
   - Any tool schema file imported: `ReadTool`, `WriteTool`, `BashTool`, `EditTool`,
     `ApplyPatchTool`, `WebFetchTool`, `TaskTool`, `QuestionTool`, `SkillTool`, `GrepTool`,
     `GlobTool`, `ListTool`, `TodoWriteTool`. Grep for each, find the source of truth.

9. **Read the bundled themes directory:**
   `/Users/gtrush/Downloads/Jelly-Claw/engine/opencode/packages/opencode/src/cli/cmd/tui/context/theme/`
   — 35 JSON files must be copied verbatim.

10. **Read the TUI's README** (if present at
    `/Users/gtrush/Downloads/Jelly-Claw/engine/opencode/packages/opencode/src/cli/cmd/tui/README.md`
    or in the package root) for any runtime quirks the authors noted.

11. **Read the jellyfish spinner spec:**
    `/Users/gtrush/Downloads/jellyclaw-engine/jellyfish-spinner-spec.txt`
    This spec will later replace OpenCode's default spinner; for Phase 10.5 we only wire it as
    an alternative — do **not** rip out the existing spinner yet.

12. **Re-read the engine event model:**
    `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/events.ts` (or `events/` dir).
    Jellyclaw emits **dotted**: `session.started`, `agent.message`, `tool.called`,
    `usage.updated`, `session.completed`.
    OpenCode emits **snake_case**: `system_init`, `text_delta`, `tool_use_start`, `result`.
    The adapter must translate.

13. **Re-read Phase 10.02's HTTP server:**
    `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/server/app.ts`
    — this is what the adapter will talk to. Confirm the routes, the auth header shape
    (`Authorization: Basic opencode:$PASSWORD` in OpenCode; in jellyclaw it's bearer — see
    Phase 10.02 spec), and the SSE long-poll endpoint shape.

---

## Implementation task

Vendor the OpenCode TUI subtree into `engine/src/tui/` unchanged (dir structure preserved),
copy its direct engine-side imports, write a **single SDK-adapter module** that presents a
subset of `@opencode-ai/sdk/v2` on top of `@jellyclaw/engine`'s HTTP client, translate the
dotted event scheme to snake_case at the adapter boundary, add the runtime deps, minimally
rebrand visible strings, preserve MIT licensing. Mark Phase 10.5 🟡 (spike complete — full
polish lands in a later phase).

### Files to create (new)

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/LICENSE.vendored` — full text of
  OpenCode's MIT license + `Vendored from github.com/sst/opencode @ <commit-sha>`. Get the sha
  with `git -C /Users/gtrush/Downloads/Jelly-Claw/engine/opencode rev-parse HEAD`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/sdk-adapter.ts` — the SDK shim.
  See "SDK adapter contract" below.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/sdk-adapter.test.ts` — event
  translation tests (see "Tests" section).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/index.ts` — export `launchTui({ url, password })`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/smoke.ts` — the bare-shell boot
  script used for verification (renders the app with no active session, exits after one frame).
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/event-map.ts` — dotted ↔ snake_case
  translation table, plus the inverse for outbound messages.
- `/Users/gtrush/Downloads/jellyclaw-engine/docs/tui.md` — short "how the vendored TUI works"
  doc: dir map, adapter diagram, how to run, where the rebrand points are.

### Files to modify

- `/Users/gtrush/Downloads/jellyclaw-engine/engine/package.json` — add runtime deps (see
  "Dependencies" below), add `"tui"` to the `"files"` array if it's not covered by `dist`.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/tsconfig.json` — ensure JSX settings
  preserved so Solid compiles:
  ```json
  {
    "compilerOptions": {
      "jsx": "preserve",
      "jsxImportSource": "solid-js"
    }
  }
  ```
  If the root `tsconfig.json` has a different JSX setting (the rest of the repo is plain
  TypeScript with no JSX), scope this to `engine/src/tui/tsconfig.json` that extends the root
  and overrides `jsx` only for the TUI subtree.
- `/Users/gtrush/Downloads/jellyclaw-engine/engine/src/cli/main.ts` (or wherever the Phase 10.01
  CLI entry lives) — add a `jellyclaw tui` subcommand that calls `launchTui()` pointed at the
  embedded server. `jellyclaw attach <url>` stays as an additional command for attaching to a
  remote jellyclaw server.
- `/Users/gtrush/Downloads/jellyclaw-engine/COMPLETION-LOG.md` — mark Phase 10.5 Prompt 01 ✅,
  phase status 🟡.
- `/Users/gtrush/Downloads/jellyclaw-engine/STATUS.md` — note "TUI vendored, bridged to
  engine HTTP; polish deferred to Phase 10.5 follow-ups."
- `/Users/gtrush/Downloads/jellyclaw-engine/phases/PHASE-10.5-tui.md` — fill the "Prompt 01
  done" checkbox.

### Exact copy commands (paste-ready)

```bash
set -euo pipefail

SRC="/Users/gtrush/Downloads/Jelly-Claw/engine/opencode/packages/opencode/src/cli/cmd/tui"
DST="/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui"

# 1) Vendor the TUI subtree wholesale (preserving dir structure).
mkdir -p "$DST"
cp -R "$SRC/." "$DST/"

# 2) Capture the upstream commit sha for attribution.
git -C /Users/gtrush/Downloads/Jelly-Claw/engine/opencode rev-parse HEAD > "$DST/UPSTREAM-SHA.txt"

# 3) Copy the direct engine-side imports the TUI depends on.
OPENCODE_SRC="/Users/gtrush/Downloads/Jelly-Claw/engine/opencode/packages/opencode/src"
VENDOR="/Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui/_vendored-engine-imports"
mkdir -p "$VENDOR/config" "$VENDOR/command" "$VENDOR/project" "$VENDOR/session" "$VENDOR/tool"
cp "$OPENCODE_SRC/config/tui.ts"          "$VENDOR/config/tui.ts"
cp "$OPENCODE_SRC/command/index.ts"       "$VENDOR/command/index.ts"
cp "$OPENCODE_SRC/bus.ts"                 "$VENDOR/bus.ts"
cp "$OPENCODE_SRC/project/instance.ts"    "$VENDOR/project/instance.ts"
cp "$OPENCODE_SRC/session/schema.ts"      "$VENDOR/session/schema.ts"
# Tool schemas — grep the TUI for each, copy the file where it's defined.
# Examples; adjust paths after grepping upstream:
#   cp "$OPENCODE_SRC/tool/read.ts"   "$VENDOR/tool/read.ts"
#   cp "$OPENCODE_SRC/tool/write.ts"  "$VENDOR/tool/write.ts"
# ...etc for all 13 tools listed in "Hard couplings".

# 4) Drop in the MIT license copy.
cp "/Users/gtrush/Downloads/Jelly-Claw/engine/opencode/LICENSE" \
   "$DST/LICENSE.vendored" 2>/dev/null || \
   echo "Write LICENSE.vendored manually with MIT text + attribution."
```

After copying, **rewrite all `@opencode-ai/sdk/v2` imports** inside the vendored subtree to
point at the local adapter:

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
grep -rl "@opencode-ai/sdk/v2" engine/src/tui | xargs sed -i '' \
  's|@opencode-ai/sdk/v2|../../tui/sdk-adapter|g'
# (Adjust the relative path per-file as needed — safer to do this with the Edit tool
# file-by-file than with a global sed. The sed above is a starting point.)
```

Similarly rewrite imports that point at `../../../config/tui`, `../../../bus`,
`../../../project/instance`, `../../../session/schema`, and the tool schemas — they now live
under `engine/src/tui/_vendored-engine-imports/`. Prefer using the Edit tool per file for
correctness.

### Exact `bun add` command (paste-ready)

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine
bun add @opentui/core@0.1.99 @opentui/solid@0.1.99 solid-js @solid-primitives/event-bus opentui-spinner strip-ansi diff
bun add -d @types/diff
```

Pin `@opentui/core` and `@opentui/solid` to `0.1.99` — that is the version upstream OpenCode
is on. Unpinned ranges on pre-1.0 OpenTUI have broken the TUI on every minor bump.

**DO NOT** add React. The repo currently has React 19 elsewhere (dashboard, desktop). Solid
and React can coexist in a monorepo — they're separate runtimes — but both must not appear in
the same bundle. The TUI bundle is Solid-only; the dashboard/desktop bundles are React-only.
Confirm by checking `engine/src/tui` has zero `react` imports after vendoring (grep it).

### SDK adapter contract

`engine/src/tui/sdk-adapter.ts` exposes the **subset** of the OpenCode SDK that the vendored
TUI actually calls. Enumerate that subset by grepping the TUI sources:

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine/engine/src/tui
grep -rhoE 'sdk\.[a-zA-Z0-9_.]+\(' . | sort -u
```

Every method returned must appear in the adapter. Typical surface (verify via grep — do not
trust this list blindly):

- `sdk.global.event({ signal })` — async iterable of server-sent events.
- `sdk.session.list()`, `sdk.session.get({ id })`, `sdk.session.create(...)`,
  `sdk.session.delete({ id })`, `sdk.session.rename(...)`.
- `sdk.session.message.list({ sessionId })`, `sdk.session.message.send(...)`.
- `sdk.session.permission.respond({ sessionId, permissionId, response })`.
- `sdk.session.abort({ sessionId })`.
- `sdk.agent.list()`, `sdk.skill.list()`, `sdk.command.list()`.
- `sdk.provider.list()`, `sdk.model.list()`.
- `sdk.file.read({ path })`, `sdk.file.status()`.
- `sdk.project.current()`, `sdk.project.list()`.
- `sdk.config.get()`.
- `sdk.tui.control.next({ signal })` — the worker control channel.

For each method: (a) call the equivalent jellyclaw HTTP endpoint (Phase 10.02), (b) translate
the response into the shape the TUI expects (reuse `_vendored-engine-imports/session/schema.ts`
Zod types wherever possible — the TUI consumes Zod-inferred types), (c) throw SDK-shaped
errors on HTTP failure so the TUI's existing error paths work.

**Auth:** OpenCode TUI sends `Authorization: Basic opencode:$OPENCODE_SERVER_PASSWORD`.
Jellyclaw's Phase 10.02 server uses bearer. The adapter translates at the HTTP client layer —
it reads `JELLYCLAW_SERVER_TOKEN` from env (or the constructor arg) and sends
`Authorization: Bearer <token>`. The TUI never sees the auth detail.

**Event long-poll:** OpenCode uses `sdk.global.event({ signal })` returning an async iterable.
Implement on top of jellyclaw's SSE endpoint with a `ReadableStream` → async-iterable bridge.
Cancellation is driven by the `AbortSignal` passed in.

### Event translation table

Implement in `engine/src/tui/event-map.ts`. Jellyclaw → OpenCode:

| Jellyclaw (dotted)   | OpenCode (snake_case) | Notes                                                        |
| -------------------- | --------------------- | ------------------------------------------------------------ |
| `session.started`    | `system_init`         | Map `sessionId` → `session.id`; fill model/provider fields.  |
| `session.completed`  | `result`              | Map `usage` → `result.usage`; include `stop_reason`.         |
| `agent.message`      | `text_delta`          | Delta-ify if the engine emits whole chunks.                  |
| `agent.message.end`  | `message_stop`        | Synthesize if engine doesn't emit explicitly.                |
| `tool.called`        | `tool_use_start`      | Map args shape.                                              |
| `tool.result`        | `tool_use_result`     |                                                              |
| `usage.updated`      | `usage`               | OpenCode uses `usage` events for running totals.             |
| `permission.asked`   | `permission_ask`      |                                                              |
| `permission.decided` | `permission_result`   |                                                              |

If jellyclaw emits an event with no OpenCode counterpart, **drop it with a debug log** — do
not synthesize. If the TUI needs an event jellyclaw doesn't emit, add a TODO in `event-map.ts`
referencing Phase 10.5 follow-up prompt 02.

Inverse direction (TUI → engine) is much smaller: `messages.send`, `abort`, `permission.respond`.
Translate at the adapter method layer.

### Rebrand (minimal, user-visible only)

Replace `opencode` → `jellyclaw` in these places only:

1. `engine/src/tui/component/logo.tsx` — swap ASCII art / wordmark.
2. The welcome banner in `routes/home.tsx`.
3. Slash-command prefix if any user-visible string says "opencode" (grep `"opencode"` in the
   vendored tree — case-sensitive).
4. Toast messages that mention opencode by name.
5. The env var the adapter reads for the server URL: `JELLYCLAW_SERVER_URL` (not
   `OPENCODE_SERVER_URL`).
6. The config file path that TuiConfig reads from — change from `~/.opencode/tui.json` to
   `~/.jellyclaw/tui.json`. Keep backward-compat reading from the old path for one phase if
   trivial; otherwise document the migration.

**Do NOT rebrand:** variable names, internal type names, function names, file names. That's
out of scope for Phase 10.5 and would double the diff for zero user value.

### Command wiring in the CLI

Add to `engine/src/cli/main.ts`:

```ts
// pseudocode — adapt to whatever CLI framework Phase 10.01 picked
program
  .command("tui")
  .description("Launch the jellyclaw terminal UI")
  .option("--port <port>", "server port (default: random)")
  .action(async (opts) => {
    const engine = await createEngine({ /* config */ });
    const { url, token } = await engine.serverInfo();
    await launchTui({ url, token });
    await engine.dispose();
  });

program
  .command("attach <url>")
  .description("Attach TUI to an existing jellyclaw server")
  .requiredOption("--token <token>", "bearer token")
  .action(async (url, opts) => {
    await launchTui({ url, token: opts.token });
  });
```

---

## Dependencies

| Package                         | Version   | Why                                    |
| ------------------------------- | --------- | -------------------------------------- |
| `@opentui/core`                 | `0.1.99`  | Terminal renderer (canvas-like layer). |
| `@opentui/solid`                | `0.1.99`  | Solid.js bindings for OpenTUI.         |
| `solid-js`                      | latest 1.x | Reactive runtime.                      |
| `@solid-primitives/event-bus`   | latest    | Solid event bus used in contexts.      |
| `opentui-spinner`               | latest    | Spinner primitives.                    |
| `strip-ansi`                    | latest    | Used in text measurement paths.        |
| `diff`                          | latest    | Tool-result diff renderer.             |
| `@types/diff` (dev)             | latest    | Typings for `diff`.                    |

Already present (do not re-add): `@opencode-ai/sdk` (still used elsewhere — TUI uses the
adapter, not the real SDK, but type imports from the SDK package are fine).

---

## Verification

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

# 1) Typecheck passes with the vendored JSX.
bun --cwd engine tsc --noEmit

# 2) Bare-shell boot — renders one OpenTUI frame with no session, exits cleanly.
bun run engine/src/tui/smoke.ts | head -20
# Expected: no stack traces; OpenTUI writes a single frame's worth of escape sequences; exit 0.

# 3) Adapter event translation tests.
bun run test engine/src/tui/sdk-adapter.test.ts

# 4) Launch against a real engine.
bun run engine/src/cli/main.ts tui
# Expected: interactive TUI appears; sidebar shows "no sessions yet"; typing into the
# prompt and pressing enter creates a session and streams a response.
# Quit with Ctrl+C — no orphaned processes (check `ps aux | grep -i jellyclaw`).

# 5) No stray React imports in the TUI subtree.
grep -r "from [\"']react[\"']" engine/src/tui && echo "FAIL: React leaked into TUI" || echo "OK: TUI is Solid-only"

# 6) MIT attribution present.
test -f engine/src/tui/LICENSE.vendored && echo "OK" || echo "FAIL: missing LICENSE.vendored"
```

### `smoke.ts` expected shape

```ts
// engine/src/tui/smoke.ts
import { render } from "@opentui/solid";
import { createSignal, onMount } from "solid-js";

function Shell() {
  const [done, setDone] = createSignal(false);
  onMount(() => {
    // Render one frame, then exit.
    queueMicrotask(() => {
      setDone(true);
      setTimeout(() => process.exit(0), 50);
    });
  });
  return <box border><text>jellyclaw tui — smoke</text></box>;
}

render(() => <Shell />);
```

---

## Tests to add

- `engine/src/tui/sdk-adapter.test.ts`:
  - **Event translation — forward direction.** Feed a mock jellyclaw SSE stream with each
    dotted event; assert the adapter yields the matching snake_case event with the correct
    field mapping.
  - **Event translation — inverse direction.** Call `adapter.session.message.send(...)`;
    assert the underlying HTTP call body shape matches what the Phase 10.02 server expects.
  - **Unknown event dropped.** Feed an event whose dotted name has no mapping; assert the
    iterable skips it and logs a debug line.
  - **Abort signal cancellation.** Start the iterable, abort the signal, assert the iterable
    terminates within one tick.
  - **Auth header.** Every HTTP request the adapter makes includes
    `Authorization: Bearer <token>` using the token passed to the adapter constructor.
- `engine/src/tui/smoke.test.ts`:
  - Spawn `bun run engine/src/tui/smoke.ts`; assert exit code 0 and stdout contains at least
    one ANSI escape sequence (proves OpenTUI painted).

Snapshot tests of the Solid render tree are out of scope for this prompt — OpenTUI's render
target is a terminal, not a DOM; assertions against ANSI output are brittle and low-value.
The smoke test + the live launch in step 4 of Verification is the real proof.

---

## Common pitfalls

- **Vendoring too much.** Copy only the `tui/` subtree **plus** its direct engine-side
  imports (config/tui.ts, command/index.ts, bus.ts, project/instance.ts, session/schema.ts,
  the tool schemas). Do NOT copy upstream's entire `src/`. If a file you didn't copy is
  imported, add it to `_vendored-engine-imports/` rather than reaching across into the live
  jellyclaw engine source — keeping a clean boundary makes future re-vendoring tractable.

- **Forgetting the themes.** 35 JSON files in `context/theme/`. Easy to miss because they
  aren't TypeScript. Verify with `ls engine/src/tui/context/theme/*.json | wc -l` → 35.

- **SDK type drift.** If the TUI calls `sdk.foo.bar()` and the adapter doesn't implement
  `foo.bar`, it crashes **at runtime** (TypeScript won't catch method access on `any`). Grep
  exhaustively. When in doubt, stub with `throw new Error("adapter: foo.bar not implemented")`
  so the runtime crash is legible and traceable.

- **Solid.js JSX pragma.** Solid requires `jsx: "preserve"` + `jsxImportSource: "solid-js"`.
  The root `tsconfig.json` likely has a different JSX setting (plain TS elsewhere). Create
  `engine/src/tui/tsconfig.json` that extends root and overrides JSX for the TUI subtree
  only. Bun picks it up via nearest-ancestor resolution.

- **React 19 version conflict.** The repo has React 19 in dashboard/desktop. React and Solid
  don't share a runtime, so they coexist at the package level, BUT both ending up in the same
  bundle is bad. Keep `engine/src/tui` imported only via the CLI entry path and confirm
  `grep -r "from [\"']react[\"']" engine/src/tui` returns nothing.

- **Missing MIT attribution.** OpenCode is MIT. Vendoring without attribution is a license
  violation. `LICENSE.vendored` must contain the full MIT text + "Vendored from
  github.com/sst/opencode @ <sha>". Link it from `docs/tui.md`.

- **OpenTUI version pin.** `@opentui/core` and `@opentui/solid` are pre-1.0. Pin to `0.1.99`
  exactly — upstream is on that version, and minor bumps on pre-1.0 have broken their TUI
  before.

- **SSE event shape.** Jellyclaw's server (Phase 10.02) emits events with dotted names;
  OpenCode's TUI parses `event.type === "text_delta"`. If the adapter translates the event
  name but forgets to translate nested field paths (`event.part.text` vs `event.delta`), the
  TUI renders blanks. Write adapter tests that assert the **full translated object shape**,
  not just the type field.

- **Worker thread.** `tui/worker.ts` is a Bun worker — runs in a separate thread. It imports
  the adapter. Bun workers need either the compiled output or `--preload`-style tsconfig
  resolution. Confirm `bun run worker.ts` in isolation succeeds before wiring it back in.

- **`attach.ts` still references `opencode attach <url>`.** Repoint to
  `jellyclaw attach <url>` in the CLI surface but keep the internal implementation untouched
  — it already accepts an arbitrary URL + auth.

- **Auth mismatch.** OpenCode TUI uses Basic auth with username `opencode`. Jellyclaw
  Phase 10.02 uses Bearer. The adapter MUST be the only layer aware of the mismatch. Don't
  leak `OPENCODE_SERVER_PASSWORD` into the TUI anywhere.

- **Session ID divergence.** OpenCode session IDs look like `ses_...`. Jellyclaw's (Phase
  09.01 SQLite store) may use a different prefix. The adapter doesn't need to translate these
  — the TUI treats them as opaque strings — but **log them** in the adapter trace so debugging
  is possible.

- **`bun add` clobbering `bun.lock`.** Before running `bun add`, confirm the working tree is
  clean (or the user has staged their intended changes). `bun add` will rewrite `bun.lock`.

- **Completion log updated before verification passes.** Do NOT flip Phase 10.5 Prompt 01 ✅
  until all six verification commands green. The typecheck + smoke + adapter tests + live
  launch together are the load-bearing proof.

- **Committing this work.** DO NOT commit. Per George's standing instruction: work locally
  on the current branch; George cuts the branch himself when satisfied. Stop at "ready for
  review."

---

<!-- BEGIN: paste from /Users/gtrush/Downloads/jellyclaw-engine/prompts/session-starters/COMPLETION-UPDATE-TEMPLATE.md -->
<!-- On success:
       - Phase 10.5 Prompt 01 ✅ in COMPLETION-LOG.md
       - Phase 10.5 status 🟡 (spike landed; polish prompts to follow)
       - STATUS.md updated: "TUI vendored + bridged; live against engine HTTP; rebrand minimal."
       - Add session-log row with duration + model + files-touched count
       - Next prompt: prompts/phase-10.5/02-<name>.md (likely: polish, jellyfish spinner swap,
         theming pass, and/or permission UX)
       - DO NOT COMMIT — George branches manually.
-->
<!-- END paste -->

**Note:** This is the FIRST prompt in Phase 10.5 — do NOT flip the phase fully ✅. Mark Prompt
01 ✅, phase status 🟡. Follow-up prompts (theme pass, jellyfish spinner, permission UX, event
coverage) promote the phase to ✅ later.
