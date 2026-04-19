/**
 * Diff view component (T1-03 polish).
 *
 * Unified diff rendering with `diffAdd` / `diffDel` / `tidewater` tokens.
 *
 * Layout rules:
 *   - Hunk header (file path + `+X / -Y` summary) is dimmed
 *     (`typography.caption`) and sits above the body.
 *   - Added lines:   `+ ` prefix, `brand.diffAdd` foreground.
 *   - Deleted lines: `- ` prefix, `brand.diffDel` foreground.
 *   - Context lines: 2-space prefix, muted tidewater.
 *   - Line wrap: wrap at terminal width − 4. Never horizontally scroll —
 *     `<Text wrap="wrap">` lets Ink wrap within the card.
 *   - Large diffs (> 60 lines): body collapses; summary becomes
 *     `+X / -Y, press Enter to expand`. `Enter` binds via `useInput`
 *     (interactive mode) to expand in-place.
 */

import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { DiffLine } from "../lib/diff.js";
import { borders } from "../theme/borders.js";
import { brand } from "../theme/brand.js";
import { density } from "../theme/density.js";
import { typography } from "../theme/typography.js";

export interface DiffViewProps {
  /** Array of diff lines to render. */
  diff: readonly DiffLine[];
  /** Maximum rows before collapsing (default 60). */
  maxRows?: number;
  /** Border color for the diff card. */
  borderColor?: string;
  /** File path to display in header. */
  filePath?: string;
  /** Terminal width hint; used to clamp wrap boundary. */
  terminalWidth?: number;
  /** If true, attach `useInput` so Enter expands. Off in tests by default. */
  interactive?: boolean;
}

/** Collapse threshold per T1-03 spec: diffs over 60 lines collapse by default. */
const DEFAULT_MAX_ROWS = 60;

/** Wrap budget — we keep the card a couple of columns shy of the terminal width. */
const WRAP_SAFETY_COLS = 4;

function countAddsDels(diff: readonly DiffLine[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of diff) {
    if (line.kind === "add") adds += 1;
    else if (line.kind === "del") dels += 1;
  }
  return { adds, dels };
}

export function DiffView(props: DiffViewProps): JSX.Element {
  const { diff, borderColor = brand.amberEye, filePath } = props;
  const maxRows = props.maxRows ?? DEFAULT_MAX_ROWS;
  const [expanded, setExpanded] = useState(false);

  const interactive = props.interactive === true;
  useInput(
    (_input, key) => {
      if (key.return) {
        setExpanded(true);
      }
    },
    { isActive: interactive },
  );

  // Determine if we need to collapse
  const needsCollapse = !expanded && diff.length > maxRows;
  const halfRows = Math.floor(maxRows / 2);
  const { adds, dels } = countAddsDels(diff);

  let firstHalf: readonly DiffLine[];
  let lastHalf: readonly DiffLine[];
  let elidedCount: number;

  if (needsCollapse) {
    firstHalf = diff.slice(0, halfRows);
    lastHalf = diff.slice(diff.length - halfRows);
    elidedCount = diff.length - maxRows;
  } else {
    firstHalf = diff;
    lastHalf = [];
    elidedCount = 0;
  }

  const termWidth = props.terminalWidth ?? process.stdout?.columns ?? 80;
  const wrapWidth = Math.max(20, termWidth - WRAP_SAFETY_COLS);

  return (
    <Box
      flexDirection="column"
      borderStyle={borders.round.style}
      borderColor={borderColor}
      paddingX={density.padX.sm}
    >
      {/* Hunk header — dimmed path + add/del summary. */}
      {filePath !== undefined || adds > 0 || dels > 0 ? (
        <Box>
          {filePath !== undefined ? (
            <>
              <Text color={borderColor} bold>
                {"\u25C7 "}
              </Text>
              <Text color={brand.foamDark} dimColor={typography.caption.dim}>
                {filePath}
              </Text>
              <Text color={brand.tidewaterDim}>{"  "}</Text>
            </>
          ) : null}
          <Text color={brand.diffAdd} dimColor={typography.caption.dim}>
            {`+${adds}`}
          </Text>
          <Text color={brand.tidewaterDim}>{" / "}</Text>
          <Text color={brand.diffDel} dimColor={typography.caption.dim}>
            {`-${dels}`}
          </Text>
        </Box>
      ) : null}
      {firstHalf.map((line, idx) => (
        <DiffLineRow
          key={`first-${line.kind}-${idx}-${line.text.slice(0, 24)}`}
          line={line}
          wrapWidth={wrapWidth}
        />
      ))}
      {needsCollapse ? (
        <>
          <Box>
            <Text color={brand.tidewaterDim} dimColor={typography.caption.dim} italic>
              {`  \u2026 ${elidedCount} lines elided \u2026`}
            </Text>
          </Box>
          <Box>
            <Text color={brand.tidewaterDim} dimColor={typography.caption.dim}>
              {`  +${adds} / -${dels}, press Enter to expand`}
            </Text>
          </Box>
          {lastHalf.map((line, idx) => (
            <DiffLineRow
              key={`last-${line.kind}-${idx}-${line.text.slice(0, 24)}`}
              line={line}
              wrapWidth={wrapWidth}
            />
          ))}
        </>
      ) : null}
    </Box>
  );
}

interface DiffLineRowProps {
  readonly line: DiffLine;
  readonly wrapWidth: number;
}

function DiffLineRow(props: DiffLineRowProps): JSX.Element {
  const { line } = props;
  // `wrap="wrap"` delegates wrapping to Ink — we never horizontally scroll.
  switch (line.kind) {
    case "add":
      return (
        <Text color={brand.diffAdd} wrap="wrap">
          {"+ "}
          {line.text}
        </Text>
      );
    case "del":
      return (
        <Text color={brand.diffDel} wrap="wrap">
          {"- "}
          {line.text}
        </Text>
      );
    case "ctx":
      return (
        <Text color={brand.tidewater} wrap="wrap">
          {"  "}
          {line.text}
        </Text>
      );
  }
}
