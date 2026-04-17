/**
 * Skill tool — retrieves a skill's body content by name.
 *
 * The model invokes `Skill({ name: "..." })` to load the full SKILL.md body
 * (not the frontmatter, just the content below the `---` fence). The engine
 * advertises available skills in the system prompt via `buildSkillInjection()`.
 *
 * Returns `{ content: string }` on success.
 * Returns a tool_error with code "unknown_skill" if the name isn't found.
 */

import { z } from "zod";
import type { SkillRegistry } from "../skills/registry.js";
import { type JsonSchema, type Tool, type ToolContext, ToolError } from "./types.js";

export const skillInputSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, "name must be kebab-case [a-z0-9-]+"),
});

export type SkillInput = z.input<typeof skillInputSchema>;

export interface SkillOutput {
  readonly content: string;
}

export class UnknownSkillError extends ToolError {
  constructor(name: string, available: readonly string[]) {
    super(
      "unknown_skill",
      `Unknown skill "${name}". Available: ${available.length > 0 ? available.join(", ") : "(none)"}`,
      { name, available },
    );
    this.name = "UnknownSkillError";
  }
}

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "The skill name to retrieve (kebab-case)",
      pattern: "^[a-z0-9-]+$",
    },
  },
  required: ["name"],
  additionalProperties: false,
};

/**
 * Factory to create the Skill tool with an injected registry.
 * The registry is passed at CLI bootstrap time; the handler closes over it.
 */
export function createSkillTool(registry: SkillRegistry): Tool<SkillInput, SkillOutput> {
  return {
    name: "Skill",
    description:
      "Retrieve a skill's full body content by name. Skills are discovered at engine startup from ~/.jellyclaw/skills, ~/.claude/skills, ./.jellyclaw/skills, and ./.claude/skills. The system prompt lists available skills.",
    inputSchema,
    zodSchema: skillInputSchema as unknown as z.ZodType<SkillInput>,
    overridesOpenCode: false,
    // biome-ignore lint/suspicious/useAwait: async for interface consistency
    async handler(input, _ctx: ToolContext): Promise<SkillOutput> {
      const parsed = skillInputSchema.parse(input);
      const skill = registry.get(parsed.name);

      if (skill === undefined) {
        const available = registry.list().map((s) => s.name);
        throw new UnknownSkillError(parsed.name, available);
      }

      return { content: skill.body };
    },
  };
}
