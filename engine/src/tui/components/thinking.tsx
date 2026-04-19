/**
 * Thinking / streaming inline indicator (T1-03 polish).
 *
 * Subtle italic dim label ("thinking…") paired with the minimal spinner shipped
 * by T1-02. Typography follows `typography.caption` (dim + italic) so the hint
 * recedes behind real assistant text.
 *
 * Fade behaviour:
 *   - Rendered inline next to the live assistant reply while streaming.
 *   - Each time a new `lastTickMs` timestamp arrives from the parent, the
 *     component schedules an auto-fade after `FADE_AFTER_MS` (≤500ms). If no
 *     new tick arrives within that window, the spinner hides itself so the
 *     next assistant chunk is not crowded by a stale indicator.
 *   - Reduced-motion: paints one static glyph instead of animating.
 *
 * Usage sites:
 *   - Status bar (compact mode, no label)
 *   - Transcript row (inline, with label)
 */

import { Text } from "ink";
import { useEffect, useState } from "react";
import { brand } from "../theme/brand.js";
import { typography } from "../theme/typography.js";
import { Jellyfish } from "./jellyfish.js";

/** How long the spinner remains on-screen after the last thinking event. */
export const FADE_AFTER_MS = 500;

export interface ThinkingProps {
  /** Accent colour for the spinner; defaults to medusaViolet. */
  readonly accentColor?: string;
  /** If true, show static glyph instead of animation. */
  readonly reducedMotion?: boolean;
  /** Custom label text; defaults to "thinking". */
  readonly label?: string;
  /** If false, hide the label entirely (compact mode). */
  readonly showLabel?: boolean;
  /**
   * Timestamp of the last thinking event from the parent. When provided, the
   * indicator auto-fades `FADE_AFTER_MS` after this value stops changing.
   * Omit to keep the spinner on-screen indefinitely (caller-controlled mode).
   */
  readonly lastTickMs?: number;
}

export function Thinking(props: ThinkingProps): JSX.Element | null {
  const accent = props.accentColor ?? brand.medusaViolet;
  const labelText = props.label ?? "thinking";
  const [faded, setFaded] = useState(false);

  useEffect(() => {
    if (props.lastTickMs === undefined) return;
    setFaded(false);
    const id = setTimeout(() => setFaded(true), FADE_AFTER_MS);
    return () => clearTimeout(id);
  }, [props.lastTickMs]);

  if (faded) return null;

  return (
    <Text>
      <Jellyfish variant="minimal" reducedMotion={props.reducedMotion === true} color={accent} />
      {props.showLabel !== false ? (
        <Text
          color={brand.tidewater}
          dimColor={typography.caption.dim}
          italic={typography.emphasis.italic ?? true}
        >
          {` ${labelText}\u2026`}
        </Text>
      ) : null}
    </Text>
  );
}
