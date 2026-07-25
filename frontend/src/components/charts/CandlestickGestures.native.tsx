import React, { useMemo } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import {
  HORIZONTAL_PAN_SLOP_PX,
  LONG_PRESS_MOVE_SLOP_PX,
  LONG_PRESS_MS,
  pinchScale,
} from './candlestickGesturePolicy';
import type { CandlestickGesturesProps } from './CandlestickGestures';

/**
 * Native (iOS/Android) gesture adapter.
 *
 * Recognizers and how they stay out of each other's way:
 *  - PINCH (two fingers) zooms about the finger midpoint. It clears crosshair
 *    mode so a leftover long press cannot fight it.
 *  - LONG PRESS (~300ms, held still) turns crosshair mode ON. Scrubbing then
 *    runs through `crosshairPan`, a manually-activated pan that only claims
 *    the touch once crosshair mode is on — which is why a vertical scrub works
 *    while a normal vertical swipe still belongs to the parent ScrollView.
 *  - CHART PAN is a one-finger pan constrained with `activeOffsetX` /
 *    `failOffsetY`: it activates only for clearly horizontal drags, so the
 *    detail screen keeps scrolling vertically. It is skipped in crosshair mode.
 *
 * A drag maps 1:1 to candles and stops at the data edges — no inertia, fling
 * or rubber-band in this first version.
 */
export default function CandlestickGestures({
  children,
  paddingLeft,
  onGestureStart,
  onPan,
  onZoom,
  onCrosshair,
  onGestureEnd,
}: CandlestickGesturesProps) {
  const gesture = useMemo(() => {
    // Crosshair mode is read synchronously by several recognizers, so it lives
    // outside React state.
    const session = { crosshair: false };

    const endCrosshair = () => {
      if (!session.crosshair) return;
      session.crosshair = false;
      onCrosshair(null);
      onGestureEnd();
    };

    const longPress = Gesture.LongPress()
      .minDuration(LONG_PRESS_MS)
      .maxDistance(LONG_PRESS_MOVE_SLOP_PX)
      .shouldCancelWhenOutside(false)
      .onStart((event) => {
        session.crosshair = true;
        onCrosshair({ x: event.x, y: event.y });
      })
      .runOnJS(true);

    const crosshairPan = Gesture.Pan()
      // Stays out of the way until a long press has armed crosshair mode.
      .manualActivation(true)
      .onTouchesMove((event, manager) => {
        if (!session.crosshair) return;
        manager.activate();
        const touch = event.changedTouches[0] ?? event.allTouches[0];
        if (touch) onCrosshair({ x: touch.x, y: touch.y });
      })
      .onFinalize(endCrosshair)
      .runOnJS(true);

    const chartPan = Gesture.Pan()
      .activeOffsetX([-HORIZONTAL_PAN_SLOP_PX, HORIZONTAL_PAN_SLOP_PX])
      .failOffsetY([-HORIZONTAL_PAN_SLOP_PX * 2, HORIZONTAL_PAN_SLOP_PX * 2])
      .minPointers(1)
      .maxPointers(1)
      .onBegin(() => {
        if (!session.crosshair) onGestureStart();
      })
      .onUpdate((event) => {
        if (session.crosshair) return;
        onPan(event.translationX);
      })
      .onFinalize(() => {
        if (!session.crosshair) onGestureEnd();
      })
      .runOnJS(true);

    const pinch = Gesture.Pinch()
      .onBegin(() => {
        endCrosshair();
        onGestureStart();
      })
      .onUpdate((event) => {
        // `event.scale` is already relative to the pinch start; the shared
        // policy bounds it so a single bad frame cannot explode the zoom.
        onZoom(pinchScale(event.scale, 1), event.focalX - paddingLeft);
      })
      .onFinalize(() => {
        onGestureEnd();
      })
      .runOnJS(true);

    return Gesture.Simultaneous(pinch, longPress, crosshairPan, chartPan);
  }, [paddingLeft, onGestureStart, onPan, onZoom, onCrosshair, onGestureEnd]);

  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false}>{children}</View>
    </GestureDetector>
  );
}
