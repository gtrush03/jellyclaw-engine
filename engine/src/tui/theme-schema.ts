/**
 * Runtime validation for vendored OpenCode theme JSON.
 *
 * The vendored TUI renders theme keys lazily; a missing key (e.g. `diffAdded`)
 * crashes at render time rather than load time. This schema is the load-bearing
 * guard: run any theme JSON through `parseThemeJson` before handing it to the
 * renderer, and a bad theme fails fast with a readable Zod error instead of
 * a blank screen mid-session.
 *
 * Keys mirror `engine/src/tui/_vendored/opencode/src/cli/cmd/tui/context/theme.tsx`
 * (`ThemeJson` type). We do NOT re-export from there to avoid pulling the
 * vendored module (and its Solid/OpenTUI deps) into engine-level test paths.
 */

import { z } from "zod";

const HexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/u, "must be a 6-digit hex color like #A1B2C3");
const RefName = z.string().min(1);
const ColorScalar = z.union([HexColor, RefName]);

const Variant = z.object({
  dark: ColorScalar,
  light: ColorScalar,
});

const ColorValue = z.union([HexColor, RefName, Variant]);

const REQUIRED_THEME_KEYS = [
  "primary",
  "secondary",
  "accent",
  "error",
  "warning",
  "success",
  "info",
  "text",
  "textMuted",
  "background",
  "backgroundPanel",
  "backgroundElement",
  "border",
  "borderActive",
  "borderSubtle",
  "diffAdded",
  "diffRemoved",
  "diffContext",
  "diffHunkHeader",
  "diffHighlightAdded",
  "diffHighlightRemoved",
  "diffAddedBg",
  "diffRemovedBg",
  "diffContextBg",
  "diffLineNumber",
  "diffAddedLineNumberBg",
  "diffRemovedLineNumberBg",
  "markdownText",
  "markdownHeading",
  "markdownLink",
  "markdownLinkText",
  "markdownCode",
  "markdownBlockQuote",
  "markdownEmph",
  "markdownStrong",
  "markdownHorizontalRule",
  "markdownListItem",
  "markdownListEnumeration",
  "markdownImage",
  "markdownImageText",
  "markdownCodeBlock",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
] as const;

export const REQUIRED_THEME_KEY_SET: ReadonlySet<string> = new Set(REQUIRED_THEME_KEYS);

const themeShape: Record<string, z.ZodTypeAny> = {};
for (const key of REQUIRED_THEME_KEYS) themeShape[key] = ColorValue;
// Optional passthroughs — the vendored type permits these.
themeShape.selectedListItemText = ColorValue.optional();
themeShape.backgroundMenu = ColorValue.optional();
themeShape.thinkingOpacity = z.number().optional();

export const ThemeJsonSchema = z
  .object({
    $schema: z.string().optional(),
    defs: z.record(z.string(), ColorScalar).optional(),
    theme: z.object(themeShape),
  })
  .strict();

export type ThemeJsonParsed = z.infer<typeof ThemeJsonSchema>;

export function parseThemeJson(value: unknown): ThemeJsonParsed {
  return ThemeJsonSchema.parse(value);
}
