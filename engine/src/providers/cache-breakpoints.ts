/**
 * Pure function that plans `cache_control` breakpoints on a ProviderRequest
 * per SPEC §7 + research-notes §3. Separated from the provider wrapper so
 * it can be unit-tested without touching the SDK.
 *
 * Rules (research-notes §3.5/§3.6):
 *   1. System: breakpoint on the LAST system block, TTL = configurable (5m | 1h).
 *   2. Tools: breakpoint on the LAST tool entry, TTL = 5m.
 *   3. memory.claudeMd: prepend as user-turn text block, breakpoint on it (5m).
 *   4. memory.skills: concatenate top-N, append as user-turn text block AFTER
 *      CLAUDE.md, breakpoint on the LAST (i.e. the skills block itself) — 5m.
 *
 * The breakpoint ALWAYS goes on the last block of the stable prefix, not on
 * the varying user turn that follows.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { CacheControlInput, ProviderRequest, SystemBlock } from "./types.js";

export interface BreakpointOptions {
  enabled: boolean;
  /** Max N skills to include. Default 12 per SPEC §7. */
  skillsTopN: number;
  /** TTL for the SYSTEM breakpoint. Tools/memory always get 5m. */
  systemTTL: "5m" | "1h";
}

export const defaultBreakpointOptions: BreakpointOptions = {
  enabled: true,
  skillsTopN: 12,
  systemTTL: "1h",
};

export interface PlannedRequest {
  system: SystemBlock[];
  tools: Anthropic.Messages.Tool[] | undefined;
  messages: Anthropic.Messages.MessageParam[];
  /** True when any breakpoint in the plan has ttl=1h (caller sets beta header). */
  hasOneHourBreakpoint: boolean;
  /** Metadata for telemetry/debug. */
  plan: {
    systemPlaced: boolean;
    toolsPlaced: boolean;
    claudeMdPlaced: boolean;
    skillsPlaced: boolean;
    skillsIncluded: number;
  };
}

const SKILL_SEPARATOR = "\n\n---\n\n";

function buildSkillsBlob(skills: Array<{ name: string; body: string }>): string {
  return skills.map((s) => `<skill name="${s.name}">\n${s.body}\n</skill>`).join(SKILL_SEPARATOR);
}

/**
 * Returns a new request object with cache_control placed according to §7.
 * Never mutates input.
 */
export function planBreakpoints(
  req: ProviderRequest,
  opts: BreakpointOptions = defaultBreakpointOptions,
): PlannedRequest {
  const plan = {
    systemPlaced: false,
    toolsPlaced: false,
    claudeMdPlaced: false,
    skillsPlaced: false,
    skillsIncluded: 0,
  };

  // --- SYSTEM -----------------------------------------------------------
  const system: SystemBlock[] = req.system.map((b) => ({ ...b }));
  if (opts.enabled && system.length > 0) {
    const last = system.at(-1);
    if (last && last.text.length > 0) {
      last.cache_control = { type: "ephemeral", ttl: opts.systemTTL };
      plan.systemPlaced = true;
    }
  }

  // --- TOOLS ------------------------------------------------------------
  let tools: Anthropic.Messages.Tool[] | undefined;
  if (req.tools && req.tools.length > 0) {
    tools = req.tools.map((t) => ({ ...t }));
    if (opts.enabled) {
      const last = tools.at(-1);
      if (last) {
        // Attach cache_control. SDK's CacheControlEphemeral type in 0.40.1
        // does not yet include the `ttl` field, but the wire format accepts
        // it (per research-notes §3.3). Cast is intentional and isolated.
        (last as { cache_control?: CacheControlInput }).cache_control = {
          type: "ephemeral",
          ttl: "5m",
        };
        plan.toolsPlaced = true;
      }
    }
  }

  // --- MESSAGES (memory injection) --------------------------------------
  const messages: Anthropic.Messages.MessageParam[] = req.messages.map((m) => ({ ...m }));

  if (opts.enabled && req.memory) {
    const memBlocks: Anthropic.Messages.TextBlockParam[] = [];

    if (req.memory.claudeMd && req.memory.claudeMd.length > 0) {
      memBlocks.push({
        type: "text",
        text: req.memory.claudeMd,
      });
      plan.claudeMdPlaced = true;
    }

    if (req.memory.skills && req.memory.skills.length > 0 && opts.skillsTopN > 0) {
      const slice = req.memory.skills.slice(0, opts.skillsTopN);
      if (slice.length > 0) {
        memBlocks.push({
          type: "text",
          text: buildSkillsBlob(slice),
        });
        plan.skillsPlaced = true;
        plan.skillsIncluded = slice.length;
      }
    }

    if (memBlocks.length > 0) {
      // Breakpoint on the LAST memory block (whichever it is — skills if
      // present, else CLAUDE.md). Research-notes §3.6.
      const lastMemIdx = memBlocks.length - 1;
      const last = memBlocks[lastMemIdx];
      if (last) {
        (last as { cache_control?: CacheControlInput }).cache_control = {
          type: "ephemeral",
          ttl: "5m",
        };
      }

      // Inject into the FIRST user message, or prepend a new one.
      const firstUserIdx = messages.findIndex((m) => m.role === "user");
      if (firstUserIdx >= 0) {
        const target = messages[firstUserIdx];
        if (target) {
          const existing = target.content;
          const existingArray: Anthropic.Messages.ContentBlockParam[] =
            typeof existing === "string" ? [{ type: "text", text: existing }] : [...existing];
          messages[firstUserIdx] = {
            ...target,
            content: [...memBlocks, ...existingArray],
          };
        }
      } else {
        messages.unshift({ role: "user", content: memBlocks });
      }
    }
  }

  const hasOneHourBreakpoint = plan.systemPlaced && opts.systemTTL === "1h";

  return { system, tools, messages, hasOneHourBreakpoint, plan };
}
