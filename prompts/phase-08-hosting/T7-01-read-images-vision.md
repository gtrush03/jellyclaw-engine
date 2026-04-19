# Phase 08 Hosting — Prompt T7-01: Vision-capable Read (agent SEES images)

**When to run:** First in the T7 design-tier batch. No T5/T6 prerequisites beyond a green build.
**Estimated duration:** 2–3 hours
**New session?** Yes.
**Model:** Claude Opus 4.7 (1M context).

## Dependencies

- None strict. Stands alone. T7-02 (image-gen MCP) and T7-04 (design-iterator) both assume T7-01 is landed — the iterator LOOP is "generate PNG → Read it → see it → refine," and without an image-capable tool_result channel the loop is blind.
- T5-05 (animation-freeze screenshot) is a nice pairing — it produces the PNGs the agent will now actually see.

## Context

`engine/src/tools/read.ts` already returns `{ kind: "image", source: { type: "base64", media_type, data } }` for `.png/.jpg/.jpeg/.gif/.webp` (see lines 204-213). The `ReadOutput` union already carries the image variant (lines 57-68). **The file reader is fine.** The hole is downstream: in `engine/src/agents/loop.ts`, `stringifyResult()` (lines ~1000-1026) JSON-stringifies every tool result into a `{ type: "tool_result", content: string }` block (lines ~763-770). That means when the agent Reads a screenshot, the model receives a 1.3 MB base64 string glued into a text block — burning context and giving the model zero visual signal. Claude supports image content blocks inside a `tool_result` per Anthropic's API (`{ type: "tool_result", content: [{ type: "image", source: { type: "base64", media_type, data } }] }`). This prompt plumbs that through.

Scope: detect image ReadOutputs in the tool-result builder, emit a `tool_result` whose `content` is an array with one `image` block, cap at 10 MB (Anthropic's documented image limit), fall back to a text note above the cap. Everything else — non-image reads, every other tool — stays on the stringify path unchanged.

## Research task

1. Read `engine/src/agents/loop.ts:144-152` — `ContentBlockParam` currently types `tool_result.content` as a `string`. This must widen to accept `string | ReadonlyArray<TextContent | ImageContent>` per Anthropic's schema. Check `node_modules/@anthropic-ai/sdk/resources/messages.d.ts` for the exact `ToolResultBlockParam` union — mirror it.
2. Read `engine/src/agents/loop.ts:763-770` — where stringified tool results land in the outgoing block. This is the branch point. When the underlying output is `kind: "image"`, skip `stringifyResult` and emit an image content-array instead.
3. Read `engine/src/tools/read.ts:57-68` + 204-213 — confirm the `ReadOutput` image variant shape (`source.type === "base64"`, `source.media_type`, `source.data`). The tool_result builder consumes this verbatim.
4. Read `engine/src/tools/read.ts:232-245` — the handler dispatch. No changes expected; this is what produces the `kind: "image"` payload.
5. Read `engine/src/tools/types.ts` `ReadOutput` export — confirm it's re-exported through `engine/src/tools/index.ts` so loop.ts can narrow on `kind`.
6. Check Anthropic's image size limits: `https://docs.claude.com/en/docs/build-with-claude/vision` — **max 10 MB per image, max 20 MB total per request, max ~8000×8000 px**. We enforce the 10 MB per-image cap at Read time (returning a text fallback when over). The request-total and pixel caps are the model's problem to reject.
7. Read `engine/src/agents/loop.ts:700-742` — the event-emission path around `tool.result`. The event carries the raw `output` (the `ReadOutput`) — good for observers. Only the **model-facing** `ContentBlockParam` needs the image structure.
8. Grep for other callers that rely on `ContentBlockParam.content` being a string: `grep -nR "tool_result" engine/src` — likely just the stub in `loop.ts` + errorResult. Widening the type is backward-compatible if you accept `string | Content[]` at the type edge.

## Implementation task

Widen `ContentBlockParam` to allow array content on `tool_result`, detect `kind: "image"` in the ReadOutput path, enforce the 10 MB base64 cap inside `read.ts` (so ALL call sites — Read tool_result AND the `tool.result` event observer path — see the same policy), and add vitest coverage. Net code: ~60 LOC across two files + tests.

### Files to create / modify

- **Modify** `engine/src/tools/read.ts`:
  - Add a `MAX_IMAGE_BYTES = 10 * 1024 * 1024` constant near the other caps (line ~30).
  - In `readImage()` (lines 204-213): if `bytes.byteLength > MAX_IMAGE_BYTES`, return a **text fallback** ReadOutput of shape `{ kind: "text", content: "image too large (${bytes}B > ${cap}B); suggest cropping, resizing, or using the Bash tool with \`sips\`/\`convert\` to downscale before reading", total_lines: 1 }`. Do NOT throw — a text note round-trips cleanly and keeps the handler contract simple.
  - Do not alter the `ReadOutput` union — the `kind: "image"` branch already exists.

- **Modify** `engine/src/agents/loop.ts`:
  - Widen `ContentBlockParam` (lines 144-152):
    ```ts
    type ToolResultContent =
      | { type: "text"; text: string }
      | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

    type ContentBlockParam =
      | { type: "text"; text: string }
      | ToolUseBlock
      | {
          type: "tool_result";
          tool_use_id: string;
          content: string | ReadonlyArray<ToolResultContent>;
          is_error?: boolean;
        };
    ```
  - In the builtin-tool success branch (lines 763-770): before calling `stringifyResult(output)`, narrow on `output`. If `isImageReadOutput(output)`, build:
    ```ts
    result: {
      type: "tool_result",
      tool_use_id: tool_id,
      content: [{ type: "image", source: output.source }],
    }
    ```
    and **skip `stringifyResult` entirely for the model-facing block** (the event-layer `output` on `tool.result` still carries the raw ReadOutput for observers).
  - Add a local guard `function isImageReadOutput(v: unknown): v is { kind: "image"; source: { type: "base64"; media_type: string; data: string } }` — shape-check, not instanceof (ReadOutput is a union).
  - Do NOT emit image content for `tool.error` or non-Read tools. Only Read's `kind: "image"` path triggers the image branch. Everything else stays on the stringify path.

- **Modify** `engine/src/tools/read.test.ts` (or create if absent — check `ls engine/src/tools/*.test.ts` first):
  - `reads a PNG and returns kind:"image" with base64 data` — fixture at `test/fixtures/images/tiny.png` (create a ~200-byte PNG via `printf '\x89PNG...' > tiny.png` or copy one in).
  - `reads a JPG and returns media_type:"image/jpeg"`.
  - `>10 MB image falls back to kind:"text" with the resize hint` — synthesize a buffer in the test, don't ship a real 10 MB fixture.
  - `unsupported image extension (.bmp) falls through to text read` — confirms no regression.

- **Modify** `engine/src/agents/loop.test.ts` (or the nearest existing loop test):
  - `Read of a PNG produces a tool_result with image content array` — mock the Read tool to return the image variant; assert the emitted `ContentBlockParam` shape matches Anthropic's `ToolResultBlockParam`.
  - `Read of a text file still produces a string tool_result` — regression guard.

- **Create** `test/fixtures/images/tiny.png` — a 1×1 transparent PNG or any small real PNG. ~70 bytes is fine. Check it in.

- **Update** `docs/tools.md` — Read section: add a line "Image reads (`.png/.jpg/.jpeg/.gif/.webp`) return a base64 image block that the model can SEE. Files over 10 MB return a text hint instead — resize with `sips -Z 2048 in.png out.png` (macOS) or `convert in.png -resize 2048x out.png` (ImageMagick) first."

- **Update** `COMPLETION-LOG.md` — append `08.T7-01 ✅` with the two new test files and the image-cap number.

### Files NOT to touch

- `engine/src/tools/webfetch.ts` — images fetched from the web are separate scope. If we want WebFetch to pipe images too, it's a follow-up prompt.
- The MCP image path — MCP tools can already return `{ type: "image", data, mimeType }` per the MCP spec. That's a different code path (`engine/src/mcp/client-*.ts` → `loop.ts` MCP result mapper).

### Shell commands

```bash
cd /Users/gtrush/Downloads/jellyclaw-engine

bun install
bun run typecheck
bun run lint
bun run test engine/src/tools/read.test.ts
bun run test engine/src/agents/loop.test.ts
bun run test                           # full sweep — zero regressions
bun run build

# Live verification — agent SEES a real image.
# Pick any small JPG/PNG on disk (or use the fixture we just added).
TEST_IMG="$HOME/Downloads/jellyclaw-engine/test/fixtures/images/tiny.png"
[ -f "$TEST_IMG" ] || TEST_IMG=$(find "$HOME/Downloads" -maxdepth 3 -iname "*.png" -size -1M 2>/dev/null | head -1)
[ -n "$TEST_IMG" ] || { echo "no test image found"; exit 1; }
echo "using $TEST_IMG"

./dist/cli.js run \
  --permission-mode bypassPermissions --max-turns 3 \
  "Read the image at ${TEST_IMG} and describe exactly what you see in one sentence. \
   If you cannot see an image — if you receive base64 text or a stringified blob — \
   say 'I received a stringified image, not a visual.' and stop."

# Expect: a visual description. NOT the words "stringified" or "base64".
```

### Expected output

- `bun run test engine/src/tools/read.test.ts` — green, 4 new cases.
- `bun run test engine/src/agents/loop.test.ts` — green, 2 new cases proving the image content-array shape.
- Live run: the agent produces a one-sentence description of the pixel content (color, subject). It does NOT produce the bail-out phrase.
- `ContentBlockParam` type widened; no downstream callers break (grep confirms only 3 construction sites: success, error, abort-fallback).
- 10 MB cap enforced inside `read.ts` — `readImage()` returns a text fallback above the threshold. No oversized base64 ever reaches the model.

### Tests to add

- `engine/src/tools/read.test.ts`:
  - PNG read → `kind:"image"`, `media_type:"image/png"`, `source.data` is a base64 string matching `/^[A-Za-z0-9+/]+=*$/`.
  - JPG read → `media_type:"image/jpeg"`.
  - 10 MB + 1 byte buffer → `kind:"text"` with the resize hint substring.
  - `.bmp` (not in `IMAGE_MIME`) → falls through to text reader — regression guard.
- `engine/src/agents/loop.test.ts` (or nearest tool-loop test):
  - Mock Read returning `kind:"image"` → emitted `ContentBlockParam.content` is an array with one `{type:"image", source:...}` block.
  - Mock Read returning `kind:"text"` → `content` remains a string. Regression guard.
  - `tool.result` event's `output` field carries the raw ReadOutput (image variant) — observers still get structured data.

### Common pitfalls

- **Do not double-encode base64.** `bytes.toString("base64")` in `readImage()` produces a base64 string. Anthropic's schema expects that string verbatim in `source.data`. Wrapping it in another JSON.stringify corrupts it. Unit-test: the emitted `data` field equals the raw base64 (no extra quotes).
- **`ReadOutput` is a discriminated union — narrow on `kind`, not `instanceof`.** Shape checks only. Do not import Read's internals into loop.ts beyond the type.
- **`stringifyResult` truncation must NOT run on the image path.** Today it elides at `MAX_TOOL_RESULT_BYTES` — a 1 MB base64 string triggers truncation and produces a mangled data URL. Skip the function entirely when the output is an image. Unit-test that a 5 MB fixture survives intact byte-for-byte.
- **The 10 MB cap is per-image, not per-request.** Anthropic also has a ~20 MB per-request total and an ~8000 px max dimension. We enforce only the per-image byte cap (the simplest one). If the model rejects an oversize request, surface the error as a tool_error — don't silently retry.
- **Animated GIFs** — Anthropic processes only the first frame. Fine for most screenshots. Document it in `docs/tools.md` Read section.
- **WebP and HEIC** — WebP is supported by Anthropic. HEIC is NOT (per docs). `IMAGE_MIME` already excludes HEIC. If a user adds `.heic` later, reject with a clear message ("Anthropic vision does not accept HEIC — convert to PNG/JPG first").
- **The `tool.result` event's `output` field is separate** — it's for observers (dashboards, logs). Keep carrying the raw `ReadOutput` there. Only the model-facing `ContentBlockParam` gets the array-of-images transform.
- **Multi-image per tool call** — a single Read always returns ONE image (or one text/notebook/pdf). Arrays of N images would come from MCP tools that return image content — separate code path, not in this prompt.
- **Do not leak pixel data to logs.** Pino redact list should NOT stringify `output.source.data` at info level. If today it dumps the full ReadOutput, add `output.source.data` to the redact list in `engine/src/logger.ts` or log a byte-length summary instead.

## Closeout

1. Append to `COMPLETION-LOG.md`: `08.T7-01 ✅` with the two new test files, 10 MB cap number, and the live-run subject ("described a PNG visually, did not stringify").
2. Print `DONE: T7-01` on success, `FAIL: T7-01 <reason>` on fatal failure.
