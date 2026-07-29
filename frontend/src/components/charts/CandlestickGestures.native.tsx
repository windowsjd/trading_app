import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import {
  HORIZONTAL_PAN_SLOP_PX,
  LONG_PRESS_MOVE_SLOP_PX,
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
 *  - LONG PRESS (~300ms, held still) turns crosshair mode ON. Scrubbing then
 *    runs through `crosshairPan`, a manually-activated pan that only claims
 *    the touch once crosshair mode is on — which is why a vertical scrub works
 *    while a normal vertical swipe still belongs to the parent ScrollView.
 *    Leaving the chart box ends the crosshair (`shouldCancelWhenOutside` plus
 *    an explicit bounds check on the scrub itself), and BOTH recognizers may
 *    finalize it — the session ignores everything but the first.
 *  - CHART PAN is a one-finger pan constrained with `activeOffsetX` /
 *    `failOffsetY`: it activates only for clearly horizontal drags, so the
 *    detail screen keeps scrolling vertically. It claims the session on
 *    ACTIVATION (not on touch down), so it never blocks a long press, and it
 *    measures translation from the activation point so the chart does not jump
 *    by the activation slop.
 *
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
  const gesture = useMemo(() => {
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

    const longPress = Gesture.LongPress()
      .minDuration(LONG_PRESS_MS)
      .maxDistance(LONG_PRESS_MOVE_SLOP_PX)
      // A finger that leaves the chart cancels the hold, which finalizes here
      // and clears the crosshair.
      .shouldCancelWhenOutside(true)
      .onStart((event) => {
        session.startCrosshair({ x: event.x, y: event.y });
      })
      // A hold released WITHOUT moving never reaches `crosshairPan` (it only
      // activates on touch move), and a cancelled/failed hold has no end event
      // of its own — so the long press must end the crosshair too. The session
      // ignores it when the crosshair is already gone.
      .onFinalize(() => {
        session.end('crosshair');
      })
      .runOnJS(true);

    const crosshairPan = Gesture.Pan()
      // Stays out of the way until a long press has armed crosshair mode.
      .manualActivation(true)
      .shouldCancelWhenOutside(true)
      .onTouchesMove((event, manager) => {
        if (!session.isCrosshairActive()) return;
        manager.activate();
        const touch = event.changedTouches[0] ?? event.allTouches[0];
        if (!touch) return;
        const point = { x: touch.x, y: touch.y };
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
      .failOffsetY([-HORIZONTAL_PAN_SLOP_PX * 2, HORIZONTAL_PAN_SLOP_PX * 2])
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
      .onBegin(() => {
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

    return Gesture.Simultaneous(pinch, longPress, crosshairPan, chartPan);
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

  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false}>{children}</View>
    </GestureDetector>
  );
}
