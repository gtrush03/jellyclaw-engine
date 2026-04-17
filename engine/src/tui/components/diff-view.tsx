/**
 * Diff view component for Edit/Write tool calls (T3-07).
 *
 * Renders a unified diff with:
 * - Green `+ ` prefix for added lines
 * - Red `- ` prefix for deleted lines
 * - Muted `  ` prefix for context lines
 *
 * Large diffs (> maxRows) collapse to first half + "... N lines elided ..." + last half.
 */

import { Box, Text } from "ink";
import type { DiffLine } from "../lib/diff.js";
import { brand } from "../theme/brand.js";

export interface DiffViewProps {
  /** Array of diff lines to render. */
  diff: readonly DiffLine[];
  /** Maximum rows before collapsing (default 40). */
  maxRows?: number;
  /** Border color for the diff card. */
  borderColor?: string;
  /** File path to display in header. */
  filePath?: string;
}

const DEFAULT_MAX_ROWS = 40;

export function DiffView(props: DiffViewProps): JSX.Element {
  const { diff, borderColor = brand.amberEye, filePath } = props;
  const maxRows = props.maxRows ?? DEFAULT_MAX_ROWS;

  // Determine if we need to collapse
  const needsCollapse = diff.length > maxRows;
  const halfRows = Math.floor(maxRows / 2);

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

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1}>
      {filePath !== undefined ? (
        <Box marginBottom={0}>
          <Text bold color={borderColor}>
            {"\u25C7 "}
          </Text>
          <Text color={brand.foam} bold>
            {filePath}
          </Text>
        </Box>
      ) : null}
      {firstHalf.map((line, idx) => (
        <DiffLineRow key={`first-${idx}`} line={line} />
      ))}
      {needsCollapse ? (
        <>
          <Box>
            <Text color={brand.tidewaterDim} italic>
              {`  \u2026 ${elidedCount} lines elided \u2026`}
            </Text>
          </Box>
          <Box>
            <Text color={brand.tidewaterDim} dimColor>
              {"  [press 'd' to expand]"}
            </Text>
          </Box>
          {lastHalf.map((line, idx) => (
            <DiffLineRow key={`last-${idx}`} line={line} />
          ))}
        </>
      ) : null}
    </Box>
  );
}

function DiffLineRow(props: { line: DiffLine }): JSX.Element {
  const { line } = props;

  switch (line.kind) {
    case "add":
      return (
        <Text color={brand.diffAdd}>
          {"+ "}
          {line.text}
        </Text>
      );
    case "del":
      return (
        <Text color={brand.diffDel}>
          {"- "}
          {line.text}
        </Text>
      );
    case "ctx":
      return (
        <Text color={brand.tidewater}>
          {"  "}
          {line.text}
        </Text>
      );
  }
}
