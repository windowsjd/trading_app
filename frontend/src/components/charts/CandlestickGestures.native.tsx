import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import {
  HORIZONTAL_PAN_SLOP_PX,
  LONG_PRESS_MS,
  createChartGestureSession,
  isWithinChartBounds,
  pinchScale,
} from './candlestickGesturePolicy';
import type { CandlestickGesturesProps } from './CandlestickGestures';

/**
 * Native (iOS/Android) gesture adapter. There are no zoom controls on screen:
 * these gestures are the whole zoom/pan vocabulary.
 *
 * Recognizers and how they stay out of each other's way:
 *  - PINCH (two fingers) zooms about the finger midpoint. It TAKES OVER the
 *    session, so a long press that turns into a pinch ends the crosshair first
 *    and the pinch still reports exactly one start and one end.
 *  - A delayed PAN activates after a stationary hold (~300ms), then tracks
 *    crosshair scrubbing in both directions. RNGH enforces its native movement
 *    slop before activation; afterwards movement does not cancel the hold.
 *    This needs neither a manual state manager nor Reanimated.
 *  - CHART PAN is a one-finger pan constrained with `activeOffsetX` /
 *    `failOffsetY`: it activates only for clearly horizontal drags, so the
 *    detail screen keeps scrolling vertically. It claims the session on
 *    ACTIVATION (not on touch down), so it never blocks a long press, and it
 *    measures translation from the activation point so the chart does not jump
 *    by the activation slop.
 *
 * Crosshair and chart pan RACE: the first active recognizer cancels the other.
 * Pinch is simultaneous with that race, so adding a second finger can zoom.
 * Pending recognizers never claim the JS session or disable page scrolling.
 * Every start/end goes through `createChartGestureSession`, so the chart sees
 * one `onGestureStart`/`onGestureEnd` per real gesture no matter how many of
 * these simultaneous recognizers finalize for a single lift.
 *
 * A drag maps 1:1 to candles and stops at the data edges — no inertia, fling
 * or rubber-band in this first version.
 */
export default function CandlestickGestures({
  children,
  paddingLeft,
  chartWidth,
  chartHeight,
  onGestureStart,
  onPan,
  onZoom,
  onCrosshair,
  onGestureEnd,
}: CandlestickGesturesProps) {
  const { gesture, session } = useMemo(() => {
    // Read synchronously by several recognizers, so it lives outside React
    // state (the state machine itself is in the shared policy).
    const session = createChartGestureSession({
      onGestureStart,
      onGestureEnd,
      onCrosshair,
    });
    const chartBox = { width: chartWidth, height: chartHeight };
    // Chart pan reports translation from the touch start; the session begins
    // at ACTIVATION, so the slop travelled before that is subtracted.
    let panOriginX = 0;

    const crosshairPan = Gesture.Pan()
      .activateAfterLongPress(LONG_PRESS_MS)
      .minPointers(1)
      .maxPointers(1)
      .shouldCancelWhenOutside(true)
      .onStart((event) => {
        session.startCrosshair({ x: event.x, y: event.y });
      })
      .onUpdate((event) => {
        const point = { x: event.x, y: event.y };
        // Scrubbed off the chart: end crosshair mode instead of tracking a
        // finger that is no longer over the plot.
        if (!isWithinChartBounds(point, chartBox)) {
          session.end('crosshair');
          return;
        }
        session.moveCrosshair(point);
      })
      .onFinalize(() => {
        session.end('crosshair');
      })
      .runOnJS(true);

    const chartPan = Gesture.Pan()
      .activeOffsetX([-HORIZONTAL_PAN_SLOP_PX, HORIZONTAL_PAN_SLOP_PX])
      .failOffsetY([-HORIZONTAL_PAN_SLOP_PX, HORIZONTAL_PAN_SLOP_PX])
      .minPointers(1)
      .maxPointers(1)
      .onStart((event) => {
        panOriginX = event.translationX;
        session.begin('pan');
      })
      .onUpdate((event) => {
        if (!session.isOwner('pan')) return;
        onPan(event.translationX - panOriginX);
      })
      .onFinalize(() => {
        session.end('pan');
      })
      .runOnJS(true);

    const pinch = Gesture.Pinch()
      .onStart(() => {
        // Android enters BEGAN on the FIRST finger, before a pinch exists.
        // Claiming onBegin would block every one-finger pan and long press.
        // A long press (or an in-flight pan) that turns into a pinch hands the
        // session over: the previous gesture ends once, the pinch starts once.
        session.takeOver('pinch');
      })
      .onUpdate((event) => {
        if (!session.isOwner('pinch')) return;
        // `event.scale` is already relative to the pinch start; the shared
        // policy bounds it so a single bad frame cannot explode the zoom.
        onZoom(pinchScale(event.scale, 1), event.focalX - paddingLeft);
      })
      .onFinalize(() => {
        session.end('pinch');
      })
      .runOnJS(true);

    return {
      gesture: Gesture.Simultaneous(pinch, Gesture.Race(crosshairPan, chartPan)),
      session,
    };
  }, [
    paddingLeft,
    chartWidth,
    chartHeight,
    onGestureStart,
    onPan,
    onZoom,
    onCrosshair,
    onGestureEnd,
  ]);

  // Rotation, timeframe changes and unmount detach the old recognizers. Close
  // their session even when native cannot deliver a final event after detach.
  useEffect(() => {
    return () => {
      const owner = session.owner();
      if (owner !== 'none') session.end(owner);
    };
  }, [session]);

  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false}>{children}</View>
    </GestureDetector>
  );
}
