/**
 * Density tokens for the Ink TUI.
 *
 * Terminal UIs measure spacing in character cells:
 * - Horizontal: columns (1 col = 1 character width)
 * - Vertical: rows (1 row = 1 line height)
 *
 * These tokens replace magic numbers like `paddingX={1}` with semantic scales.
 */

export interface PaddingScale {
  readonly none: 0;
  readonly sm: 1;
  readonly md: 2;
  readonly lg: 3;
}

export interface VerticalPaddingScale {
  readonly none: 0;
  readonly sm: 0;
  readonly md: 1;
  readonly lg: 2;
}

export interface GapScale {
  readonly xs: 0;
  readonly sm: 1;
  readonly md: 1;
  readonly lg: 2;
}

export interface Density {
  /** Horizontal paddings in columns. */
  readonly padX: PaddingScale;
  /** Vertical paddings in rows. */
  readonly padY: VerticalPaddingScale;
  /** Gap between sibling stacked boxes. */
  readonly gap: GapScale;
}

export const density: Density = {
  padX: { none: 0, sm: 1, md: 2, lg: 3 },
  padY: { none: 0, sm: 0, md: 1, lg: 2 },
  gap: { xs: 0, sm: 1, md: 1, lg: 2 },
};
