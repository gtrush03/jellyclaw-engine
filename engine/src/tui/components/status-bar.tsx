/**
 * Status bar — top of the TUI.
 *
 * Shows (left → right): jellyfish glyph · app name · model (if resolved)
 * · session id (if started) · token total · cost · status glyph. Accent
 * colour rotates per-session via `pickRowAccents` so repeated launches feel
 * distinct.
 *
 * Slots are collapsed rather than placeholder-filled: if there's no model
 * resolved yet, or no session started, those slots are hidden entirely so
 * the bar never shows "· ·" with empty space between. Separators are
 * inserted between *rendered* slots only.
 *
 * Uses a single-line bottom border drawn from `brand.tidewaterDim` for a
 * premium "Claude Code"-style separator look — no double/round borders on the
 * main row.
 */

import type { ReactNode } from "react";
import { Box, Text } from "ink";
import type { UiStatus, UiUsage } from "../state/types.js";
import { brand, pickRowAccents } from "../theme/brand.js";
import { Jellyfish } from "./jellyfish.js";

export interface StatusBarProps {
  sessionId: string | null;
  model: string;
  usage: UiUsage;
  status: UiStatus;
  /** Monotonic tick from state — drives spinner frame selection. */
  tick: number;
  reducedMotion: boolean;
}

function formatTokens(usage: UiUsage): string {
  const total = usage.inputTokens + usage.outputTokens;
  if (total >= 1000) {
    const k = Math.round(total / 100) / 10;
    return `${k}k tok`;
  }
  return `${total} tok`;
}

function formatCost(usage: UiUsage): string {
  if (usage.costUsd <= 0) return "$0.00";
  if (usage.costUsd < 0.01) return "<$0.01";
  return `$${usage.costUsd.toFixed(2)}`;
}

function isResolvedModel(model: string): boolean {
  const trimmed = model.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === "(default)") return false;
  return true;
}

export function StatusBar(props: StatusBarProps): JSX.Element {
  const accents = pickRowAccents(props.sessionId);
  const slots: ReactNode[] = [];

  // Brand slot — always present.
  slots.push(
    <Box key="brand">
      <Text color={accents.user}>{"\u{1FABC} "}</Text>
      <Text bold color={brand.foam}>
        jellyclaw
      </Text>
    </Box>,
  );

  if (isResolvedModel(props.model)) {
    slots.push(
      <Text key="model" color={brand.foam}>
        {props.model}
      </Text>,
    );
  }

  if (props.sessionId !== null && props.sessionId.length > 0) {
    slots.push(
      <Text key="session" color={brand.tidewater}>
        {props.sessionId.slice(0, 8)}
      </Text>,
    );
  }

  slots.push(
    <Text key="tokens" color={accents.assistant}>
      {formatTokens(props.usage)}
    </Text>,
  );
  slots.push(
    <Text key="cost" color={accents.tool}>
      {formatCost(props.usage)}
    </Text>,
  );
  slots.push(
    <StatusGlyph
      key="status"
      status={props.status}
      tick={props.tick}
      reducedMotion={props.reducedMotion}
    />,
  );

  const rendered: ReactNode[] = [];
  for (let i = 0; i < slots.length; i += 1) {
    if (i > 0) {
      rendered.push(
        <Text key={`sep-${i}`} color={brand.tidewaterDim}>
          {" \u00B7 "}
        </Text>,
      );
    }
    rendered.push(slots[i]);
  }

  return (
    <Box
      borderStyle="single"
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderColor={brand.tidewaterDim}
      paddingX={1}
    >
      {rendered}
    </Box>
  );
}

interface GlyphProps {
  status: UiStatus;
  tick: number;
  reducedMotion: boolean;
}

function StatusGlyph(props: GlyphProps): JSX.Element {
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
