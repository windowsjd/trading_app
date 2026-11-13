import React from 'react';
import { View } from '../../theme/native';
import type { ReactNode } from 'react';
import type { CrosshairInput } from './candlestickGesturePolicy';

/**
 * Contract between the chart and its platform gesture adapters, plus the
 * no-gesture fallback.
 *
 * The adapters recognize gestures and report INTENT; all viewport math stays
 * in CandlestickChart + candlestickViewport, so native and web never diverge.
 * Metro/webpack resolve `./CandlestickGestures` to `.native.tsx` on
 * iOS/Android and `.web.tsx` on web; this file is what TypeScript type-checks
 * against and what a platform without its own adapter would fall back to
 * (chart still renders, just without gestures).
 */
export type CandlestickGesturesProps = {
  children: ReactNode;
  /** Plot width in px (used to turn a focal x into a chart ratio). */
  innerWidth: number;
  /** Left padding of the plot area, so x maps into plot coordinates. */
  paddingLeft: number;
  /** Current candle slot width, for pixel → candle pan conversion. */
  slotWidth: number;
  /** Full chart box, so a touch leaving it can end crosshair mode. */
  chartWidth: number;
  chartHeight: number;

  /** A pan/pinch is starting: snapshot the current viewport. */
  onGestureStart: () => void;
  /**
   * Chart move, measured from the gesture start: x pans time, y moves prices
   * (the chart decides when y starts to count — see shouldEngageVerticalPan).
   */
  onPan: (translationX: number, translationY: number) => void;
  /** Pinch/wheel zoom about `focalX` (plot coordinates, px). */
  onZoom: (scale: number, focalX: number) => void;
  /** Vertical price scaling (a drag on the price axis), pixels from the gesture start. */
  onPriceScale: (translationY: number) => void;
  /** Vertical pinch: price zoom about `focalY` (chart coordinates, px). */
  onPriceZoom: (scale: number, focalY: number) => void;
  /** Crosshair input (hover, long-press scrub, release, tap…) in chart coordinates. */
  onCrosshair: (input: CrosshairInput) => void;
  /** Gesture finished (adapters use it to end crosshair/pan sessions). */
  onGestureEnd: () => void;
};

export default function CandlestickGestures({
  children,
}: CandlestickGesturesProps) {
  return <View>{children}</View>;
}
