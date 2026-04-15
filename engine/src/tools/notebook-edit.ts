/**
 * NotebookEdit tool — parity with Claude Code's `NotebookEdit`.
 *
 * Edits a cell of a Jupyter notebook (.ipynb, nbformat v4). Supports three
 * edit modes:
 *   - `replace` — overwrite a cell's source. Optionally changes `cell_type`
 *     (which resets outputs + execution_count) or wipes outputs.
 *   - `insert`  — splice a new cell in after the target index (or append if
 *     no index provided).
 *   - `delete`  — remove the target cell.
 *
 * Invariants:
 *   - `notebook_path` must be absolute and live under `ctx.cwd` (unless the
 *     `notebook.outside_cwd` permission is granted).
 *   - The notebook must have been Read in this session (`ctx.readCache`).
 *   - The notebook must be nbformat 4 and have a `cells` array.
 *   - Outputs + execution_count are PRESERVED on a pure source replace —
 *     callers opt into wiping them via `clear_outputs` or by changing the
 *     cell's `cell_type`.
 *
 * Writes are atomic via `<path>.jellyclaw.tmp` → rename, matching Write/Edit.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";

import notebookEditSchema from "../../../test/fixtures/tools/claude-code-schemas/notebookedit.json" with {
  type: "json",
};

import {
  CwdEscapeError,
  InvalidInputError,
  InvalidNotebookError,
  type JsonSchema,
  NotebookEditRequiresReadError,
  type Tool,
  type ToolContext,
} from "./types.js";

export const notebookEditInputSchema = z.object({
  notebook_path: z.string().min(1),
  new_source: z.string().optional(),
  cell_id: z.string().optional(),
  cell_number: z.number().int().min(0).optional(),
  cell_type: z.enum(["code", "markdown"]).optional(),
  edit_mode: z.enum(["replace", "insert", "delete"]).default("replace"),
  clear_outputs: z.boolean().optional(),
});

export type NotebookEditInput = z.input<typeof notebookEditInputSchema>;

export interface NotebookEditOutput {
  notebook_path: string;
  cell_count: number;
  modified_cell_id: string;
}

interface NotebookCell {
  cell_type: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  id?: string;
  outputs?: unknown[];
  execution_count?: number | null;
  [key: string]: unknown;
}

interface NotebookJson {
  cells: NotebookCell[];
  metadata?: Record<string, unknown>;
  nbformat: number;
  nbformat_minor?: number;
  [key: string]: unknown;
}

function ensureInsideCwd(resolved: string, ctx: ToolContext): void {
  const cwd = ctx.cwd;
  const inside = resolved === cwd || resolved.startsWith(cwd + sep);
  if (inside) return;
  if (!ctx.permissions.isAllowed("notebook.outside_cwd")) {
    throw new CwdEscapeError(resolved, cwd);
  }
}

function ensureCellId(cell: NotebookCell): string {
  if (typeof cell.id === "string" && cell.id.length > 0) return cell.id;
  const id = randomUUID();
  cell.id = id;
  return id;
}

export const notebookEditTool: Tool<NotebookEditInput, NotebookEditOutput> = {
  name: "NotebookEdit",
  description:
    "Edit a Jupyter notebook (.ipynb v4) cell. Supports replace / insert / delete. Preserves outputs unless clear_outputs is true. Changing cell_type resets execution_count and outputs. Requires the notebook to have been Read in this session.",
  inputSchema: notebookEditSchema as JsonSchema,
  zodSchema: notebookEditInputSchema as unknown as z.ZodType<NotebookEditInput>,
  overridesOpenCode: true,
  // biome-ignore lint/suspicious/useAwait: Tool.handler contract is async; body is fully synchronous fs I/O wrapped in a Promise.
  async handler(input, ctx) {
    const parsed = notebookEditInputSchema.parse(input);

    if (!isAbsolute(parsed.notebook_path)) {
      throw new InvalidInputError("notebook_path must be absolute", {
        notebook_path: parsed.notebook_path,
      });
    }

    const absPath = resolve(parsed.notebook_path);
    ensureInsideCwd(absPath, ctx);

    if (!existsSync(absPath)) {
      throw new InvalidInputError("Notebook does not exist", { path: absPath });
    }

    if (!ctx.readCache.has(absPath)) {
      throw new NotebookEditRequiresReadError(absPath);
    }

    const raw = readFileSync(absPath, "utf8");
    let doc: NotebookJson;
    try {
      doc = JSON.parse(raw) as NotebookJson;
    } catch (err) {
      throw new InvalidNotebookError(absPath, `JSON parse failed: ${(err as Error).message}`);
    }

    if (doc.nbformat !== 4) {
      throw new InvalidNotebookError(absPath, "expected nbformat 4");
    }
    if (!Array.isArray(doc.cells)) {
      throw new InvalidNotebookError(absPath, "expected cells array");
    }

    const cells = doc.cells;

    // Locate target cell (if relevant to the edit mode).
    let targetIdx: number | undefined;
    if (parsed.cell_id !== undefined) {
      const idx = cells.findIndex((c) => c.id === parsed.cell_id);
      if (idx < 0) {
        throw new InvalidInputError("cell_id not found", {
          path: absPath,
          cell_id: parsed.cell_id,
        });
      }
      targetIdx = idx;
    } else if (parsed.cell_number !== undefined) {
      if (parsed.cell_number >= cells.length) {
        throw new InvalidInputError("cell_number out of range", {
          path: absPath,
          cell_number: parsed.cell_number,
          cell_count: cells.length,
        });
      }
      targetIdx = parsed.cell_number;
    } else if (parsed.edit_mode !== "insert") {
      // replace / delete require an explicit locator.
      throw new InvalidInputError("must provide cell_id or cell_number", {
        path: absPath,
        edit_mode: parsed.edit_mode,
      });
    }

    let modifiedCellId: string;

    if (parsed.edit_mode === "replace") {
      if (targetIdx === undefined) {
        // Should be unreachable (checked above) but satisfies the type narrower.
        throw new InvalidInputError("must provide cell_id or cell_number", { path: absPath });
      }
      if (parsed.new_source === undefined) {
        throw new InvalidInputError("new_source required for replace", { path: absPath });
      }
      const cell = cells[targetIdx];
      if (cell === undefined) {
        throw new InvalidInputError("cell_number out of range", { path: absPath });
      }

      const typeChanged = parsed.cell_type !== undefined && parsed.cell_type !== cell.cell_type;
      if (typeChanged && parsed.cell_type !== undefined) {
        cell.cell_type = parsed.cell_type;
        cell.outputs = [];
        cell.execution_count = null;
      }

      // Store source as a plain string — the nbformat v4 spec accepts both
      // `string` and `string[]`, and Read's normalizer already handles both.
      cell.source = parsed.new_source;

      if (parsed.clear_outputs === true && cell.cell_type === "code") {
        cell.outputs = [];
        cell.execution_count = null;
      }

      modifiedCellId = ensureCellId(cell);
    } else if (parsed.edit_mode === "insert") {
      if (parsed.cell_type === undefined) {
        throw new InvalidInputError("cell_type required for insert", { path: absPath });
      }
      if (parsed.new_source === undefined) {
        throw new InvalidInputError("new_source required for insert", { path: absPath });
      }

      const newCell: NotebookCell = {
        cell_type: parsed.cell_type,
        source: parsed.new_source,
        metadata: {},
        id: randomUUID(),
      };
      if (parsed.cell_type === "code") {
        newCell.outputs = [];
        newCell.execution_count = null;
      }

      const insertAt = targetIdx === undefined ? cells.length : targetIdx + 1;
      cells.splice(insertAt, 0, newCell);
      modifiedCellId = newCell.id as string;
    } else {
      // delete
      if (targetIdx === undefined) {
        throw new InvalidInputError("must provide cell_id or cell_number", { path: absPath });
      }
      const removed = cells.splice(targetIdx, 1)[0];
      if (removed === undefined) {
        throw new InvalidInputError("cell_number out of range", { path: absPath });
      }
      modifiedCellId = ensureCellId(removed);
    }

    // Serialize. nbformat's canonical indentation is 1 space.
    const serialized = `${JSON.stringify(doc, null, 1)}\n`;

    const tmpPath = `${absPath}.jellyclaw.tmp`;
    try {
      writeFileSync(tmpPath, serialized, "utf8");
      renameSync(tmpPath, absPath);
    } catch (err) {
      try {
        if (existsSync(tmpPath)) rmSync(tmpPath, { force: true, recursive: true });
      } catch {
        // swallow — never mask the original error
      }
      throw err;
    }

    return {
      notebook_path: absPath,
      cell_count: cells.length,
      modified_cell_id: modifiedCellId,
    };
  },
};
