import React, { useEffect, useMemo } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import {
  HORIZONTAL_PAN_SLOP_PX,
  LONG_PRESS_MS,
  createChartGestureSession,
  isWithinChartBounds,
  pinchScale,
  classifyTwoFingerGesture,
  type TouchPair,
  type ChartTouch,
} from './candlestickGesturePolicy';
import type { CandlestickGesturesProps } from './CandlestickGestures';

/** One-finger horizontal pan/long-press race alongside simultaneous native
 * pinch and two-finger pan recognizers. Shared touch intention locks either
 * X zoom or parallel vertical Y scaling until lift. No manual activation or
 * Reanimated dependency: pending recognition never owns the chart session. */
export default function CandlestickGestures({
  children,
  paddingLeft,
  chartWidth,
  chartHeight,
  onGestureStart,
  onPan,
  onZoom,
  onPriceScale,
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

    let pairStart: TouchPair | null = null;
    let pairNow: TouchPair | null = null;
    let twoMode: 'pinch' | 'priceScale' | null = null;
    let pinchActive = false;
    let twoPanActive = false;
    let rawTouchesAvailable = false;
    const finishTwo = () => {
      if (twoMode) session.end(twoMode);
      pairStart = pairNow = null;
      twoMode = null;
    };
    const applyTouches = () => {
      if (!pairStart || !pairNow || (!pinchActive && !twoPanActive)) return;
      const mode = twoMode ?? classifyTwoFingerGesture(pairStart, pairNow);
      if (!mode) return;
      if (!twoMode) {
        twoMode = mode;
        session.takeOver(mode);
      }
      if (!session.isOwner(mode)) return;
      if (mode === 'priceScale') {
        onPriceScale(
          (pairNow[0].y + pairNow[1].y - pairStart[0].y - pairStart[1].y) / 2,
        );
      } else {
        onZoom(
          pinchScale(
            Math.hypot(
              pairNow[1].x - pairNow[0].x,
              pairNow[1].y - pairNow[0].y,
            ),
            Math.hypot(
              pairStart[1].x - pairStart[0].x,
              pairStart[1].y - pairStart[0].y,
            ),
          ),
          (pairNow[0].x + pairNow[1].x) / 2 - paddingLeft,
        );
      }
    };
    const readTouches = (event: {
      allTouches: ChartTouch[];
      numberOfTouches: number;
    }) => {
      rawTouchesAvailable = true;
      if (event.numberOfTouches !== 2 || event.allTouches.length !== 2) {
        finishTwo();
        return;
      }
      const touches = [...event.allTouches].sort((a, b) => a.id - b.id);
      const next: TouchPair = [touches[0], touches[1]];
      if (
        pairStart &&
        pairStart.some((touch, index) => touch.id !== next[index].id)
      )
        finishTwo();
      pairStart ??= next;
      pairNow = next;
      applyTouches();
    };
    const pinch = Gesture.Pinch()
      .onTouchesDown(readTouches)
      .onTouchesMove(readTouches)
      .onTouchesUp(finishTwo)
      .onTouchesCancelled(finishTwo)
      .onStart(() => {
        pinchActive = true;
        applyTouches();
      })
      .onUpdate((event) => {
        if (rawTouchesAvailable) {
          applyTouches();
          return;
        }
        // Native scale remains a fallback if a platform starts delivering
        // recognizer updates before its raw two-touch snapshot.
        if (twoMode === 'priceScale') return;
        if (!twoMode && Math.abs(Math.log(event.scale)) >= 0.06) {
          twoMode = 'pinch';
          session.takeOver('pinch');
        }
        if (session.isOwner('pinch'))
          onZoom(pinchScale(event.scale, 1), event.focalX - paddingLeft);
      })
      .onFinalize(() => {
        pinchActive = false;
        if (twoMode === 'pinch' || !twoPanActive) finishTwo();
      })
      .runOnJS(true);
    const pricePan = Gesture.Pan()
      .minPointers(2)
      .maxPointers(2)
      .minDistance(0)
      .averageTouches(true)
      .onTouchesDown(readTouches)
      .onTouchesMove(readTouches)
      .onTouchesUp(finishTwo)
      .onTouchesCancelled(finishTwo)
      .onStart(() => {
        twoPanActive = true;
        applyTouches();
      })
      .onUpdate(applyTouches)
      .onFinalize(() => {
        twoPanActive = false;
        if (twoMode === 'priceScale' || !pinchActive) finishTwo();
      })
      .runOnJS(true);

    return {
      gesture: Gesture.Simultaneous(
        pinch,
        pricePan,
        Gesture.Race(crosshairPan, chartPan),
      ),
      session,
    };
  }, [
    paddingLeft,
    chartWidth,
    chartHeight,
    onGestureStart,
    onPan,
    onZoom,
    onPriceScale,
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
