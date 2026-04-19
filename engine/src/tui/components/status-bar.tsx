/**
 * Status bar — top of the TUI (T1-04 polish).
 *
 * Layout (one row, terminal width ≥ 80):
 *
 *   <session-slug> · <cwd-basename>   <right-aligned pills…>
 *                                      [ model ]  [ cost ]  [ ctx used/max ]
 *
 * Pills are short labels with a tinted `backgroundColor` and bold text:
 *   - Model pill   → `jellyCyan` bg (always shown)
 *   - Cost pill    → `amberEye` bg (only rendered when `costUsd > 0.01`)
 *   - Context pill → `medusaViolet` bg (`<used>/<max>` tokens)
 *
 * Narrow terminals (< 80 cols) collapse to the model pill only so the bar
 * never wraps. The reconnecting / disconnected badge stays on its own row
 * appended after the main bar so it's never suppressed by the collapse.
 *
 * A bottom single-line border drawn from `brand.tidewaterDim` separates the
 * bar from the transcript — no double/round border on the main row.
 */

import { basename } from "node:path";
import { Box, Text } from "ink";
import type { UiConnection, UiStatus, UiUsage } from "../state/types.js";
import { brand, pickRowAccents } from "../theme/brand.js";
import { density } from "../theme/density.js";
import { typography } from "../theme/typography.js";
import { Jellyfish } from "./jellyfish.js";

/** Below this terminal width the bar collapses to the model pill only. */
export const NARROW_COL_THRESHOLD = 80;
/** Default context-window size when the caller doesn't supply one. */
export const DEFAULT_CONTEXT_MAX_TOKENS = 200_000;
/** Cost pill suppression threshold (spec: render only when cost > $0.01). */
export const COST_PILL_MIN_USD = 0.01;

export interface StatusBarProps {
  sessionId: string | null;
  model: string;
  usage: UiUsage;
  status: UiStatus;
  /** Monotonic tick from state — drives spinner frame selection. */
  tick: number;
  reducedMotion: boolean;
  /** Connection health state. */
  connection?: UiConnection;
  /** Current working directory — basename is rendered in the bar. */
  cwd?: string;
  /** Context-window size for the active model (tokens). Defaults to 200k. */
  contextMaxTokens?: number;
  /** Override the measured terminal width (primarily for deterministic tests). */
  terminalWidth?: number;
}

function formatCost(usage: UiUsage): string {
  if (usage.costUsd < COST_PILL_MIN_USD) return "<$0.01";
  return `$${usage.costUsd.toFixed(2)}`;
}

function formatContext(usage: UiUsage, maxTokens: number): string {
  const used =
    usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return `${compactTokens(used)}/${compactTokens(maxTokens)}`;
}

function compactTokens(n: number): string {
  if (n >= 1000) {
    const k = Math.round(n / 100) / 10;
    return `${k}k`;
  }
  return `${n}`;
}

function resolveModelLabel(model: string): string {
  const trimmed = model.trim();
  if (trimmed.length === 0) return "default";
  if (trimmed === "(default)") return "default";
  return trimmed;
}

function sessionSlug(sessionId: string | null): string {
  if (sessionId === null || sessionId.length === 0) return "new";
  return sessionId.slice(0, 8);
}

function cwdLabel(cwd: string | undefined): string {
  if (cwd === undefined || cwd.length === 0) return "";
  const base = basename(cwd);
  return base.length === 0 ? cwd : base;
}

/** Pill — bold label on a tinted `backgroundColor` (typography.pill). */
function Pill(props: {
  readonly bg: string;
  readonly fg?: string;
  readonly label: string;
}): JSX.Element {
  const fg = props.fg ?? brand.abyss;
  return (
    <Text
      backgroundColor={props.bg}
      color={fg}
      bold={typography.pill.bold}
    >{` ${props.label} `}</Text>
  );
}

function ConnectionBadge(props: { connection: UiConnection }): JSX.Element | null {
  const conn = props.connection;
  if (conn.kind === "connected") {
    return null;
  }
  if (conn.kind === "reconnecting") {
    return <Text color={brand.amberEye}>{`\u27F3 reconnecting (attempt ${conn.attempt})`}</Text>;
  }
  return <Text color={brand.error}>{`\u2717 disconnected: ${conn.reason}`}</Text>;
}

function StatusGlyph(props: {
  status: UiStatus;
  tick: number;
  reducedMotion: boolean;
}): JSX.Element {
  switch (props.status) {
    case "streaming":
      return <Jellyfish size="compact" tick={props.tick} reducedMotion={props.reducedMotion} />;
    case "awaiting-permission":
      return <Text color={brand.amberEye}>!</Text>;
    case "error":
      return <Text color={brand.error}>{"\u2717"}</Text>;
    default:
      return <Text color={brand.tidewater}>{"\u00B7"}</Text>;
  }
}

export function StatusBar(props: StatusBarProps): JSX.Element {
  const accents = pickRowAccents(props.sessionId);
  const termWidth = props.terminalWidth ?? process.stdout?.columns ?? 80;
  const narrow = termWidth < NARROW_COL_THRESHOLD;
  const contextMax = props.contextMaxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS;

  const slug = sessionSlug(props.sessionId);
  const dir = cwdLabel(props.cwd);
  const modelLabel = resolveModelLabel(props.model);

  const showCostPill = props.usage.costUsd > COST_PILL_MIN_USD;

  return (
    <Box flexDirection="column">
      <Box
        borderStyle="single"
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={brand.tidewaterDim}
        paddingX={density.padX.sm}
      >
        {/* Left: brand + session slug + cwd basename */}
        <Box>
          <Text color={accents.user}>{"\u{1FABC} "}</Text>
          <Text bold color={brand.foam}>
            jellyclaw
          </Text>
          <Text color={brand.tidewaterDim}>{" \u00B7 "}</Text>
          <Text color={brand.foamDark}>{slug}</Text>
          {dir.length > 0 ? (
            <>
              <Text color={brand.tidewaterDim}>{" \u00B7 "}</Text>
              <Text
                color={brand.neutralBridge}
                dimColor={typography.caption.dim}
              >{`~/${dir}`}</Text>
            </>
          ) : null}
        </Box>

        {/* Right spacer — pushes pills to the right edge. */}
        <Box flexGrow={1} />

        {/* Right: pills. Narrow terminals keep only the model pill. */}
        <Box>
          <Pill bg={brand.jellyCyan} label={modelLabel} />
          {!narrow && showCostPill ? (
            <>
              <Text> </Text>
              <Pill bg={brand.amberEye} label={formatCost(props.usage)} />
            </>
          ) : null}
          {!narrow ? (
            <>
              <Text> </Text>
              <Pill
                bg={brand.medusaViolet}
                fg={brand.foam}
                label={formatContext(props.usage, contextMax)}
              />
            </>
          ) : null}
          <Text color={brand.tidewaterDim}>{"  "}</Text>
          <StatusGlyph
            status={props.status}
            tick={props.tick}
            reducedMotion={props.reducedMotion}
          />
        </Box>
      </Box>

      {/* Connection badge — separate row so narrow collapse never hides it. */}
      {props.connection !== undefined && props.connection.kind !== "connected" ? (
        <Box paddingX={density.padX.sm}>
          <ConnectionBadge connection={props.connection} />
        </Box>
      ) : null}
    </Box>
  );
}
