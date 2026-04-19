/**
 * Theme barrel export — single import for all TUI styling tokens.
 *
 * Usage:
 *   import { brand, typography, density, borders } from "./theme/index.js";
 */

export type { BorderStyle, BorderVariant } from "./borders.js";
export { borders, pickBorderForTerm } from "./borders.js";

export type { BrandPalette, RowAccents } from "./brand.js";
export {
  brand,
  DEFAULT_ROW_ACCENTS,
  GRADIENT_BELL,
  GRADIENT_HEAT,
  GRADIENT_JELLY,
  gradient,
  PALETTE_VERSION,
  pickRowAccents,
} from "./brand.js";

export type { Density, GapScale, PaddingScale, VerticalPaddingScale } from "./density.js";
export { density } from "./density.js";

export type { Typography, TypographyStyle } from "./typography.js";
export { typography } from "./typography.js";
