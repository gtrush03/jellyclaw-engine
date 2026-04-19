/**
 * Typography tokens for the Ink TUI.
 *
 * Ink's <Text> only supports bold/dim/italic/underline — not font sizes.
 * The "scale" is expressed via weight (bold) and dim states.
 */

export interface TypographyStyle {
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
}

export interface Typography {
  /** Headings — bold, full brightness. */
  readonly heading: TypographyStyle;
  /** Body text — regular weight, full brightness. */
  readonly body: TypographyStyle;
  /** Monospace code/tool output — regular weight. */
  readonly mono: TypographyStyle;
  /** Captions/metadata — dimmed for de-emphasis. */
  readonly caption: TypographyStyle;
  /** Pills/badges — bold for emphasis. */
  readonly pill: TypographyStyle;
  /** Emphasis within body text. */
  readonly emphasis: TypographyStyle;
}

export const typography: Typography = {
  heading: { bold: true, dim: false },
  body: { bold: false, dim: false },
  mono: { bold: false, dim: false },
  caption: { bold: false, dim: true },
  pill: { bold: true, dim: false },
  emphasis: { bold: false, dim: false, italic: true },
};
