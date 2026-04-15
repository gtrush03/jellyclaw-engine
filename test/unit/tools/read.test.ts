/**
 * Unit tests for the Read tool. Fixtures (notebook, PDFs, PNG) are synthesized
 * into a tmp cwd via `beforeAll` so the repo stays clean of opaque binaries.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLogger } from "../../../engine/src/logger.js";
import { allowAll, denyAll } from "../../../engine/src/tools/permissions.js";
import { readTool } from "../../../engine/src/tools/read.js";
import {
  CwdEscapeError,
  InvalidInputError,
  type ToolContext,
} from "../../../engine/src/tools/types.js";
import readSchema from "../../fixtures/tools/claude-code-schemas/read.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Hand-roll a minimal, valid PDF with `pageTexts.length` pages. Each page shows
 * its text via a single Helvetica Tj operator. The resulting bytes parse
 * cleanly under pdfjs-dist's legacy build.
 */
function buildPdfBytes(pageTexts: readonly string[]): Buffer {
  const header = "%PDF-1.4\n";
  let body = header;
  const nPages = pageTexts.length;

  const PAGES_ID = 2;
  let nextId = 3;
  const pageIds: number[] = [];
  const contentIds: number[] = [];
  for (let i = 0; i < nPages; i++) {
    pageIds.push(nextId++);
    contentIds.push(nextId++);
  }
  const FONT_ID = nextId++;

  const offsets: number[] = new Array(FONT_ID + 1).fill(0);

  const writeObj = (id: number, content: string): void => {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${content}\nendobj\n`;
  };

  writeObj(1, `<< /Type /Catalog /Pages ${PAGES_ID} 0 R >>`);
  const kids = pageIds.map((id) => `${id} 0 R`).join(" ");
  writeObj(PAGES_ID, `<< /Type /Pages /Kids [${kids}] /Count ${nPages} >>`);
  for (let i = 0; i < nPages; i++) {
    const pid = pageIds[i]!;
    const cid = contentIds[i]!;
    const text = pageTexts[i]!;
    const stream = `BT /F1 18 Tf 100 700 Td (${text}) Tj ET`;
    writeObj(cid, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    writeObj(
      pid,
      `<< /Type /Page /Parent ${PAGES_ID} 0 R /MediaBox [0 0 612 792] /Contents ${cid} 0 R /Resources << /Font << /F1 ${FONT_ID} 0 R >> >> >>`,
    );
  }
  writeObj(FONT_ID, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  const xrefOffset = body.length;
  const total = FONT_ID + 1;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const trailer = `trailer << /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body + xref + trailer, "latin1");
}

/** 1x1 red PNG (known-good binary). */
const TINY_RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function makeCtx(cwd: string, perms = denyAll): ToolContext {
  return {
    cwd,
    sessionId: "test-session",
    readCache: new Set<string>(),
    abort: new AbortController().signal,
    logger: createLogger({ level: "silent" }),
    permissions: perms,
  };
}

// ---------------------------------------------------------------------------
// Shared fixture state
// ---------------------------------------------------------------------------

let tmpRoot: string;
let outsideRoot: string;
let textPath: string;
let emptyPath: string;
let notebookPath: string;
let pdfSmallPath: string;
let pdfBigPath: string;
let pngPath: string;
let outsidePath: string;

beforeAll(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "jellyclaw-read-"));
  outsideRoot = mkdtempSync(path.join(tmpdir(), "jellyclaw-read-outside-"));

  // Text fixture — 5 lines.
  textPath = path.join(tmpRoot, "sample.txt");
  await writeFile(textPath, "alpha\nbeta\ngamma\ndelta\nepsilon\n", "utf8");

  // Empty fixture.
  emptyPath = path.join(tmpRoot, "empty.txt");
  await writeFile(emptyPath, "", "utf8");

  // Notebook fixture — 1 markdown cell + 1 code cell with outputs.
  notebookPath = path.join(tmpRoot, "sample.ipynb");
  const notebook = {
    cells: [
      {
        cell_type: "markdown",
        metadata: {},
        source: ["# Title\n", "intro text"],
      },
      {
        cell_type: "code",
        metadata: {},
        execution_count: 1,
        source: "print('hi')\n",
        outputs: [
          {
            output_type: "stream",
            name: "stdout",
            text: ["hi\n"],
          },
        ],
      },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  };
  await writeFile(notebookPath, JSON.stringify(notebook, null, 2), "utf8");

  // PDFs.
  pdfSmallPath = path.join(tmpRoot, "sample.pdf");
  writeFileSync(pdfSmallPath, buildPdfBytes(["Hello World", "Page Two"]));

  pdfBigPath = path.join(tmpRoot, "big.pdf");
  const bigPages = Array.from({ length: 20 }, (_, i) => `BigPage ${i + 1}`);
  writeFileSync(pdfBigPath, buildPdfBytes(bigPages));

  // PNG.
  pngPath = path.join(tmpRoot, "sample.png");
  writeFileSync(pngPath, Buffer.from(TINY_RED_PNG_BASE64, "base64"));

  // Outside-cwd file.
  outsidePath = path.join(outsideRoot, "outside.txt");
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(outsidePath, "secret\n", "utf8");
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("readTool — schema", () => {
  it("inputSchema matches the published Claude Code schema", () => {
    expect(readTool.inputSchema).toEqual(readSchema);
  });
});

describe("readTool — input validation", () => {
  it("rejects relative paths with InvalidInputError", async () => {
    const ctx = makeCtx(tmpRoot);
    await expect(readTool.handler({ file_path: "relative/path.txt" }, ctx)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });
});

describe("readTool — cwd jail", () => {
  it("throws CwdEscapeError when path is outside cwd and perms deny", async () => {
    const ctx = makeCtx(tmpRoot, denyAll);
    await expect(readTool.handler({ file_path: outsidePath }, ctx)).rejects.toBeInstanceOf(
      CwdEscapeError,
    );
  });

  it("allows outside-cwd reads when permission is granted", async () => {
    const ctx = makeCtx(tmpRoot, allowAll);
    const out = await readTool.handler({ file_path: outsidePath }, ctx);
    expect(out.kind).toBe("text");
  });
});

describe("readTool — text", () => {
  it("returns cat-n formatted lines with offset+limit", async () => {
    const ctx = makeCtx(tmpRoot);
    const out = await readTool.handler({ file_path: textPath, offset: 2, limit: 3 }, ctx);
    if (out.kind !== "text") throw new Error("expected text");
    expect(out.total_lines).toBe(5);
    expect(out.content).toBe("2\tbeta\n3\tgamma\n4\tdelta");
  });

  it("handles empty files with a system-reminder notice and populates readCache", async () => {
    const ctx = makeCtx(tmpRoot);
    const out = await readTool.handler({ file_path: emptyPath }, ctx);
    if (out.kind !== "text") throw new Error("expected text");
    expect(out.total_lines).toBe(0);
    expect(out.content).toContain("<system-reminder>File is empty.</system-reminder>");
    expect(ctx.readCache.has(path.resolve(emptyPath))).toBe(true);
  });
});

describe("readTool — notebook", () => {
  it("returns cells with source and outputs", async () => {
    const ctx = makeCtx(tmpRoot);
    const out = await readTool.handler({ file_path: notebookPath }, ctx);
    if (out.kind !== "notebook") throw new Error("expected notebook");
    expect(out.cells).toHaveLength(2);
    expect(out.cells[0]?.cell_type).toBe("markdown");
    expect(out.cells[0]?.source).toBe("# Title\nintro text");
    expect(out.cells[1]?.cell_type).toBe("code");
    expect(out.cells[1]?.outputs).toHaveLength(1);
  });
});

describe("readTool — pdf", () => {
  it("reads a small PDF with pages range", async () => {
    const ctx = makeCtx(tmpRoot);
    const out = await readTool.handler({ file_path: pdfSmallPath, pages: "1-2" }, ctx);
    if (out.kind !== "pdf") throw new Error("expected pdf");
    expect(out.total_pages).toBe(2);
    expect(out.pages).toHaveLength(2);
    expect(out.pages[0]?.text).toContain("Hello");
    expect(out.pages[1]?.text).toContain("Page Two");
  });

  it("rejects a large PDF when no pages range is provided", async () => {
    const ctx = makeCtx(tmpRoot);
    await expect(readTool.handler({ file_path: pdfBigPath }, ctx)).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it("reads 5 pages of a large PDF with pages='1-5'", async () => {
    const ctx = makeCtx(tmpRoot);
    const out = await readTool.handler({ file_path: pdfBigPath, pages: "1-5" }, ctx);
    if (out.kind !== "pdf") throw new Error("expected pdf");
    expect(out.total_pages).toBe(20);
    expect(out.pages).toHaveLength(5);
    expect(out.pages[0]?.page).toBe(1);
    expect(out.pages[4]?.page).toBe(5);
  });

  it("rejects pages ranges exceeding 20", async () => {
    const ctx = makeCtx(tmpRoot);
    await expect(
      readTool.handler({ file_path: pdfBigPath, pages: "1-25" }, ctx),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe("readTool — image", () => {
  it("returns base64 payload with media_type and round-trips to bytes", async () => {
    const ctx = makeCtx(tmpRoot);
    const out = await readTool.handler({ file_path: pngPath }, ctx);
    if (out.kind !== "image") throw new Error("expected image");
    expect(out.source.type).toBe("base64");
    expect(out.source.media_type).toBe("image/png");
    const decoded = Buffer.from(out.source.data, "base64");
    const expected = Buffer.from(TINY_RED_PNG_BASE64, "base64");
    expect(decoded.equals(expected)).toBe(true);
  });
});

describe("readTool — readCache", () => {
  it("records the resolved absolute path after a successful read", async () => {
    const ctx = makeCtx(tmpRoot);
    await readTool.handler({ file_path: textPath }, ctx);
    expect(ctx.readCache.has(path.resolve(textPath))).toBe(true);
  });
});
