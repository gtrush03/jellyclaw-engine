/**
 * Memory tool (T3-05).
 *
 * Allows the model to read, write, append, and delete the project-scoped
 * memory file at `~/.jellyclaw/projects/<cwd-hash>/memory/MEMORY.md`.
 *
 * This is a side-effectful tool: it mutates a user-scoped file, so it is
 * NOT in READ_ONLY_TOOLS and normal permission rules apply.
 */

import { z } from "zod";
import { deleteMemory, loadMemory, saveMemory } from "../agents/memory.js";
import type { JsonSchema, Tool } from "./types.js";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const memoryInputSchema = z
  .object({
    action: z.enum(["read", "write", "append", "delete"]),
    content: z.string().optional(),
  })
  .refine(
    (data) => {
      // write/append require non-empty content
      if (data.action === "write" || data.action === "append") {
        return typeof data.content === "string" && data.content.length > 0;
      }
      // read/delete must NOT have content
      return data.content === undefined;
    },
    { message: "write/append require non-empty content; read/delete must not provide content" },
  );

export type MemoryInput = z.input<typeof memoryInputSchema>;

export const memoryJsonSchema: JsonSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["read", "write", "append", "delete"],
      description:
        "The action to perform: read returns current memory, write replaces it, append adds to it, delete removes it.",
    },
    content: {
      type: "string",
      description: "Required for write/append; ignored for read/delete.",
    },
  },
  required: ["action"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const memoryTool: Tool<MemoryInput, string> = {
  name: "Memory",
  description:
    "Read, write, append to, or delete the project-scoped memory file. Memory persists across sessions.",
  inputSchema: memoryJsonSchema,
  zodSchema: memoryInputSchema as unknown as z.ZodType<MemoryInput>,
  overridesOpenCode: false,
  async handler(input, ctx) {
    const parsed = memoryInputSchema.parse(input);

    switch (parsed.action) {
      case "read": {
        const contents = await loadMemory(ctx.cwd);
        return contents ?? "(empty)";
      }
      case "write": {
        // Content is guaranteed by zod refine.
        const content = parsed.content as string;
        await saveMemory(ctx.cwd, content);
        return `memory updated (${Buffer.byteLength(content, "utf8")} bytes)`;
      }
      case "append": {
        // Content is guaranteed by zod refine.
        const content = parsed.content as string;
        const existing = await loadMemory(ctx.cwd);
        const newContent = existing !== null ? `${existing}\n${content}` : content;
        await saveMemory(ctx.cwd, newContent);
        return "memory appended";
      }
      case "delete": {
        await deleteMemory(ctx.cwd);
        return "memory deleted";
      }
    }
  },
};
