/**
 * Read tool — parity with Claude Code's `Read`.
 *
 * Dispatches by file extension:
 *   - `.ipynb`           → parsed notebook with cells + outputs
 *   - `.pdf`             → per-page text via pdfjs-dist (max 20 pages/call)
 *   - `.png/.jpg/.jpeg/
 *      .gif/.webp`       → base64-encoded image payload
 *   - anything else      → UTF-8 text with 1-indexed `${lineNo}\t${content}` lines
 *
 * Cwd jail: the resolved absolute path must live under `ctx.cwd`. Escapes
 * require the `read.outside_cwd` permission; otherwise throw `CwdEscapeError`.
 *
 * On SUCCESS the resolved absolute path is inserted into `ctx.readCache` so
 * that Write can later enforce its "read before overwrite" invariant.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
// pdfjs-dist legacy build works in Node without a DOM; disableWorker avoids
// the worker-thread bootstrap dance entirely.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";
import readSchema from "../../../test/fixtures/tools/claude-code-schemas/read.json" with {
  type: "json",
};
import { ensureWithinAllowedRoots } from "./permissions.js";
import { InvalidInputError, type JsonSchema, type Tool, type ToolContext } from "./types.js";

const DEFAULT_TEXT_LIMIT = 2000;
const MAX_PDF_PAGES_PER_CALL = 20;
const LARGE_PDF_THRESHOLD = 10;

const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export const readInputSchema = z.object({
  file_path: z.string().min(1),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
  pages: z.string().optional(),
});

export type ReadInput = z.input<typeof readInputSchema>;

export interface NotebookCell {
  readonly cell_type: string;
  readonly source: string;
  readonly outputs: readonly unknown[];
}

export type ReadOutput =
  | { kind: "text"; content: string; total_lines: number }
  | { kind: "notebook"; cells: readonly NotebookCell[] }
  | {
      kind: "pdf";
      pages: ReadonlyArray<{ readonly page: number; readonly text: string }>;
      total_pages: number;
    }
  | {
      kind: "image";
      source: { readonly type: "base64"; readonly media_type: string; readonly data: string };
    };

interface PdfRange {
  readonly start: number;
  readonly end: number;
}

function parsePagesRange(raw: string): PdfRange {
  const trimmed = raw.trim();
  const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(trimmed);
  if (!m) {
    throw new InvalidInputError(`invalid pages range: ${raw}`);
  }
  const first = m[1];
  const second = m[2];
  if (first === undefined) {
    throw new InvalidInputError(`invalid pages range: ${raw}`);
  }
  const start = Number.parseInt(first, 10);
  const end = second !== undefined ? Number.parseInt(second, 10) : start;
  if (start < 1 || end < start) {
    throw new InvalidInputError(`invalid pages range: ${raw}`);
  }
  if (end - start + 1 > MAX_PDF_PAGES_PER_CALL) {
    throw new InvalidInputError("pages range exceeds max 20");
  }
  return { start, end };
}

function ensureInsideCwd(resolved: string, ctx: ToolContext): void {
  ensureWithinAllowedRoots(resolved, ctx, "read.outside_cwd");
}

function normalizeNotebookSource(source: unknown): string {
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return source.map((s) => (typeof s === "string" ? s : "")).join("");
  return "";
}

function readTextFile(
  bytes: Buffer,
  offset: number | undefined,
  limit: number | undefined,
): {
  content: string;
  total_lines: number;
} {
  if (bytes.byteLength === 0) {
    return { content: "<system-reminder>File is empty.</system-reminder>\n", total_lines: 0 };
  }
  const raw = bytes.toString("utf8");
  // Preserve trailing empty line behavior: split on "\n" and drop a single empty final entry
  // caused by a trailing newline, matching Claude Code's line-count semantics.
  const parts = raw.split("\n");
  const lines = parts.length > 0 && parts[parts.length - 1] === "" ? parts.slice(0, -1) : parts;
  const total = lines.length;
  const startLine = Math.max(1, offset ?? 1);
  const take = limit ?? DEFAULT_TEXT_LIMIT;
  const slice = lines.slice(startLine - 1, startLine - 1 + take);
  const formatted = slice.map((line, i) => `${startLine + i}\t${line}`).join("\n");
  return { content: formatted, total_lines: total };
}

function readNotebook(
  bytes: Buffer,
  offset: number | undefined,
  limit: number | undefined,
): ReadOutput {
  const parsed = JSON.parse(bytes.toString("utf8")) as {
    cells?: ReadonlyArray<{ cell_type?: unknown; source?: unknown; outputs?: unknown }>;
  };
  const cellsRaw = parsed.cells ?? [];
  const startCell = Math.max(1, offset ?? 1);
  const take = limit ?? DEFAULT_TEXT_LIMIT;
  const slice = cellsRaw.slice(startCell - 1, startCell - 1 + take);
  const cells: NotebookCell[] = slice.map((c) => ({
    cell_type: typeof c.cell_type === "string" ? c.cell_type : "unknown",
    source: normalizeNotebookSource(c.source),
    outputs: Array.isArray(c.outputs) ? (c.outputs as readonly unknown[]) : [],
  }));
  return { kind: "notebook", cells };
}

async function readPdf(bytes: Buffer, pagesArg: string | undefined): Promise<ReadOutput> {
  const data = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // `disableWorker` is honored by pdfjs at runtime but is absent from the
  // published DocumentInitParameters type. Cast through `unknown` to keep
  // strict TS happy while still passing the flag to the library.
  const params = {
    data,
    disableWorker: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    verbosity: 0,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0];
  const loading = pdfjs.getDocument(params);
  const doc = await loading.promise;
  const total = doc.numPages;

  let range: PdfRange;
  if (pagesArg !== undefined) {
    range = parsePagesRange(pagesArg);
    if (range.end > total) {
      range = { start: range.start, end: total };
    }
    if (range.start > total) {
      await doc.destroy();
      throw new InvalidInputError(`pages range start ${range.start} exceeds total ${total}`);
    }
  } else {
    if (total > LARGE_PDF_THRESHOLD) {
      await doc.destroy();
      throw new InvalidInputError("large PDF requires pages range");
    }
    range = { start: 1, end: total };
  }

  const pages: Array<{ page: number; text: string }> = [];
  for (let i = range.start; i <= range.end; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    const text = tc.items
      .map((it: unknown) => {
        if (typeof it === "object" && it !== null && "str" in it) {
          const s = (it as { str: unknown }).str;
          return typeof s === "string" ? s : "";
        }
        return "";
      })
      .join(" ");
    pages.push({ page: i, text });
  }
  await doc.destroy();
  return { kind: "pdf", pages, total_pages: total };
}

function readImage(bytes: Buffer, ext: string): ReadOutput {
  const mime = IMAGE_MIME[ext];
  if (mime === undefined) {
    throw new InvalidInputError(`unsupported image extension: ${ext}`);
  }
  return {
    kind: "image",
    source: { type: "base64", media_type: mime, data: bytes.toString("base64") },
  };
}

export const readTool: Tool<ReadInput, ReadOutput> = {
  name: "Read",
  description:
    "Read a file from the local filesystem. Dispatches by extension: Jupyter notebooks, PDFs (per-page text, max 20 pages), common images (base64), otherwise UTF-8 text with 1-indexed line prefixes. Supports offset/limit for text/notebook and a pages range for PDF.",
  inputSchema: readSchema as JsonSchema,
  zodSchema: readInputSchema as unknown as z.ZodType<ReadInput>,
  overridesOpenCode: true,
  async handler(input, ctx) {
    const parsed = readInputSchema.parse(input);

    if (!path.isAbsolute(parsed.file_path)) {
      throw new InvalidInputError("file_path must be absolute");
    }

    const resolved = path.resolve(parsed.file_path);
    ensureInsideCwd(resolved, ctx);

    const ext = path.extname(resolved).toLowerCase();
    const bytes = await readFile(resolved);

    let output: ReadOutput;
    if (ext === ".ipynb") {
      output = readNotebook(bytes, parsed.offset, parsed.limit);
    } else if (ext === ".pdf") {
      output = await readPdf(bytes, parsed.pages);
    } else if (ext in IMAGE_MIME) {
      output = readImage(bytes, ext);
    } else {
      const text = readTextFile(bytes, parsed.offset, parsed.limit);
      output = { kind: "text", content: text.content, total_lines: text.total_lines };
    }

    ctx.readCache.add(resolved);
    return output;
  },
};
