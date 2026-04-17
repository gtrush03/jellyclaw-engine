// evolver.mjs — STUB.
//
// Per the MVP spec: return the raw prompt body as startup-context with no
// transformation. The real evolver (prompt expansion, context grafting,
// retrieval) lands in M5.

export function evolvePrompt(parsed) {
  const header = [
    `# Startup context for ${parsed.id}`,
    ``,
    `Tier: T${parsed.tier}`,
    `Title: ${parsed.title}`,
    `Scope (you may only touch these paths):`,
    ...parsed.scope.map((s) => `  - ${s}`),
    ``,
    `Max turns: ${parsed.max_turns}`,
    `Max cost (USD): ${parsed.max_cost_usd}`,
    ``,
    `---`,
    ``,
  ].join("\n");
  return header + parsed.body;
}
