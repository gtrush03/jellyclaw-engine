/**
 * Unit tests for the NotebookEdit tool.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../../../engine/src/logger.js";
import { getTool } from "../../../engine/src/tools/index.js";
import { notebookEditTool } from "../../../engine/src/tools/notebook-edit.js";
import { allowAll, denyAll } from "../../../engine/src/tools/permissions.js";
import {
  InvalidInputError,
  InvalidNotebookError,
  NotebookEditRequiresReadError,
  type ToolContext,
} from "../../../engine/src/tools/types.js";
import notebookEditSchema from "../../fixtures/tools/claude-code-schemas/notebookedit.json" with {
  type: "json",
};

interface TestCell {
  cell_type: "code" | "markdown";
  source: string | string[];
  metadata?: Record<string, unknown>;
  id?: string;
  outputs?: unknown[];
  execution_count?: number | null;
}

function buildNotebook(cells: TestCell[], nbformat = 4): string {
  return JSON.stringify({
    cells,
    metadata: {},
    nbformat,
    nbformat_minor: 5,
  });
}

function makeCtx(cwd: string, opts: { allow?: boolean } = {}): ToolContext {
  return {
    cwd,
    sessionId: "test-session",
    readCache: new Set<string>(),
    abort: new AbortController().signal,
    logger: createLogger({ level: "silent" }),
    permissions: opts.allow ? allowAll : denyAll,
  };
}

function seedNotebook(cwd: string, name: string, cells: TestCell[], nbformat = 4): string {
  const path = resolve(join(cwd, name));
  writeFileSync(path, buildNotebook(cells, nbformat), "utf8");
  return path;
}

function readNotebook(path: string): {
  cells: TestCell[];
  nbformat: number;
  nbformat_minor: number;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    cells: TestCell[];
    nbformat: number;
    nbformat_minor: number;
  };
}

describe("notebookEditTool", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "jellyclaw-nb-"));
  });

  afterEach(() => {
    try {
      rmSync(cwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("replace by cell_number preserves outputs and execution_count", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "a.ipynb", [
      { cell_type: "markdown", source: "# Title", id: "c0" },
      {
        cell_type: "code",
        source: "print(1)",
        id: "c1",
        outputs: [{ output_type: "stream", text: "1" }],
        execution_count: 1,
      },
      { cell_type: "code", source: "x=2", id: "c2", outputs: [], execution_count: 2 },
    ]);
    ctx.readCache.add(nb);

    const out = await notebookEditTool.handler(
      { notebook_path: nb, cell_number: 1, new_source: "print(42)" },
      ctx,
    );

    expect(out.notebook_path).toBe(nb);
    expect(out.cell_count).toBe(3);
    expect(out.modified_cell_id).toBe("c1");

    const after = readNotebook(nb);
    expect(after.cells[1]?.source).toBe("print(42)");
    expect(after.cells[1]?.outputs).toEqual([{ output_type: "stream", text: "1" }]);
    expect(after.cells[1]?.execution_count).toBe(1);
  });

  it("insert markdown after cell_number 2 puts it at index 3", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "b.ipynb", [
      { cell_type: "code", source: "a", id: "c0" },
      { cell_type: "code", source: "b", id: "c1" },
      { cell_type: "code", source: "c", id: "c2" },
    ]);
    ctx.readCache.add(nb);

    const out = await notebookEditTool.handler(
      {
        notebook_path: nb,
        edit_mode: "insert",
        cell_number: 2,
        cell_type: "markdown",
        new_source: "# New",
      },
      ctx,
    );

    expect(out.cell_count).toBe(4);
    const after = readNotebook(nb);
    expect(after.cells).toHaveLength(4);
    expect(after.cells[3]?.cell_type).toBe("markdown");
    expect(after.cells[3]?.source).toBe("# New");
    expect(after.cells[3]?.id).toBe(out.modified_cell_id);
  });

  it("insert without locator appends at end", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "bb.ipynb", [
      { cell_type: "code", source: "a", id: "c0" },
      { cell_type: "code", source: "b", id: "c1" },
    ]);
    ctx.readCache.add(nb);

    const out = await notebookEditTool.handler(
      {
        notebook_path: nb,
        edit_mode: "insert",
        cell_type: "code",
        new_source: "z",
      },
      ctx,
    );

    expect(out.cell_count).toBe(3);
    const after = readNotebook(nb);
    expect(after.cells[2]?.source).toBe("z");
    expect(after.cells[2]?.cell_type).toBe("code");
    expect(after.cells[2]?.execution_count).toBeNull();
    expect(after.cells[2]?.outputs).toEqual([]);
  });

  it("delete by cell_number removes the cell", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "c.ipynb", [
      { cell_type: "code", source: "a", id: "c0" },
      { cell_type: "code", source: "b", id: "c1" },
      { cell_type: "code", source: "c", id: "c2" },
    ]);
    ctx.readCache.add(nb);

    const out = await notebookEditTool.handler(
      { notebook_path: nb, edit_mode: "delete", cell_number: 0 },
      ctx,
    );

    expect(out.cell_count).toBe(2);
    expect(out.modified_cell_id).toBe("c0");
    const after = readNotebook(nb);
    expect(after.cells.map((c) => c.source)).toEqual(["b", "c"]);
  });

  it("clear_outputs wipes outputs and execution_count on replace", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "d.ipynb", [
      {
        cell_type: "code",
        source: "print(1)",
        id: "c0",
        outputs: [{ output_type: "stream", text: "1" }],
        execution_count: 3,
      },
    ]);
    ctx.readCache.add(nb);

    await notebookEditTool.handler(
      {
        notebook_path: nb,
        cell_number: 0,
        new_source: "print(2)",
        clear_outputs: true,
      },
      ctx,
    );

    const after = readNotebook(nb);
    expect(after.cells[0]?.source).toBe("print(2)");
    expect(after.cells[0]?.outputs).toEqual([]);
    expect(after.cells[0]?.execution_count).toBeNull();
  });

  it("changing cell_type resets outputs and execution_count", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "e.ipynb", [
      {
        cell_type: "code",
        source: "print(1)",
        id: "c0",
        outputs: [{ output_type: "stream", text: "1" }],
        execution_count: 5,
      },
    ]);
    ctx.readCache.add(nb);

    await notebookEditTool.handler(
      {
        notebook_path: nb,
        cell_number: 0,
        new_source: "# Now markdown",
        cell_type: "markdown",
      },
      ctx,
    );

    const after = readNotebook(nb);
    expect(after.cells[0]?.cell_type).toBe("markdown");
    expect(after.cells[0]?.source).toBe("# Now markdown");
    expect(after.cells[0]?.outputs).toEqual([]);
    expect(after.cells[0]?.execution_count).toBeNull();
  });

  it("rejects nbformat 3 with InvalidNotebookError", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "old.ipynb", [{ cell_type: "code", source: "x", id: "c0" }], 3);
    ctx.readCache.add(nb);

    await expect(
      notebookEditTool.handler({ notebook_path: nb, cell_number: 0, new_source: "y" }, ctx),
    ).rejects.toBeInstanceOf(InvalidNotebookError);
  });

  it("throws NotebookEditRequiresReadError when notebook not in readCache", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "fresh.ipynb", [{ cell_type: "code", source: "x", id: "c0" }]);
    // intentionally do NOT add to readCache

    await expect(
      notebookEditTool.handler({ notebook_path: nb, cell_number: 0, new_source: "y" }, ctx),
    ).rejects.toBeInstanceOf(NotebookEditRequiresReadError);
  });

  it("locates a cell by cell_id and replaces it", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "byid.ipynb", [
      { cell_type: "code", source: "a", id: "alpha" },
      { cell_type: "code", source: "b", id: "beta" },
    ]);
    ctx.readCache.add(nb);

    const out = await notebookEditTool.handler(
      { notebook_path: nb, cell_id: "beta", new_source: "B!" },
      ctx,
    );

    expect(out.modified_cell_id).toBe("beta");
    const after = readNotebook(nb);
    expect(after.cells[1]?.source).toBe("B!");
  });

  it("throws InvalidInputError when cell_id not found", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "miss.ipynb", [{ cell_type: "code", source: "a", id: "c0" }]);
    ctx.readCache.add(nb);

    await expect(
      notebookEditTool.handler({ notebook_path: nb, cell_id: "nope", new_source: "x" }, ctx),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("throws InvalidInputError when cell_number is out of range", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "range.ipynb", [{ cell_type: "code", source: "a", id: "c0" }]);
    ctx.readCache.add(nb);

    await expect(
      notebookEditTool.handler({ notebook_path: nb, cell_number: 7, new_source: "x" }, ctx),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("insert without cell_type is rejected", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "ins.ipynb", [{ cell_type: "code", source: "a", id: "c0" }]);
    ctx.readCache.add(nb);

    await expect(
      notebookEditTool.handler({ notebook_path: nb, edit_mode: "insert", new_source: "x" }, ctx),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("replace without new_source is rejected", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "rep.ipynb", [{ cell_type: "code", source: "a", id: "c0" }]);
    ctx.readCache.add(nb);

    await expect(
      notebookEditTool.handler({ notebook_path: nb, cell_number: 0 }, ctx),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("relative notebook_path is rejected", async () => {
    const ctx = makeCtx(cwd);
    await expect(
      notebookEditTool.handler(
        { notebook_path: "./foo.ipynb", cell_number: 0, new_source: "x" },
        ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("missing notebook file is rejected", async () => {
    const ctx = makeCtx(cwd);
    const target = resolve(join(cwd, "ghost.ipynb"));
    await expect(
      notebookEditTool.handler({ notebook_path: target, cell_number: 0, new_source: "x" }, ctx),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it("leaves the original notebook intact when the atomic rename fails", async () => {
    const ctx = makeCtx(cwd);
    const nb = seedNotebook(cwd, "atomic.ipynb", [
      { cell_type: "code", source: "original", id: "c0" },
    ]);
    ctx.readCache.add(nb);
    const originalBytes = readFileSync(nb, "utf8");

    // Block the tmp path with a non-empty directory so renameSync fails.
    const tmpPath = `${nb}.jellyclaw.tmp`;
    mkdirSync(tmpPath);
    writeFileSync(join(tmpPath, "blocker"), "x", "utf8");

    await expect(
      notebookEditTool.handler({ notebook_path: nb, cell_number: 0, new_source: "replaced" }, ctx),
    ).rejects.toThrow();

    expect(readFileSync(nb, "utf8")).toBe(originalBytes);

    rmSync(tmpPath, { recursive: true, force: true });
  });

  it("inputSchema deep-equals the Claude Code fixture", () => {
    expect(notebookEditTool.inputSchema).toEqual(notebookEditSchema);
  });

  it("is registered as NotebookEdit in the tool registry", () => {
    expect(getTool("NotebookEdit")).toBe(notebookEditTool);
  });
});
