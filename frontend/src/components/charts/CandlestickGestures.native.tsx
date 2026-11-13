import React, { useEffect, useMemo } from 'react';
import { View } from '../../theme/native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

import {
  CHART_PAN_ACTIVATION_PX,
  LONG_PRESS_MS,
  TAP_SLOP_PX,
  createChartGestureSession,
  isWithinChartBounds,
  pinchScale,
  classifyTwoFingerGesture,
  type TouchPair,
  type ChartTouch,
} from './candlestickGesturePolicy';
import type { CandlestickGesturesProps } from './CandlestickGestures';

/** One finger: a tap (pins / clears the crosshair), a long press (scrubs the
 * crosshair, which stays where it is lifted) or a drag — on the plot it moves
 * the chart both ways, on the price axis it scales prices — race each other;
 * pinch and two-finger pan recognizers run alongside. Shared touch intention
 * locks X zoom (a pinch), Y zoom (a vertical pinch) or parallel vertical Y
 * scaling until lift. No manual activation or Reanimated dependency: pending
 * recognition never owns the chart session.
 *
 * The drag activates after CHART_PAN_ACTIVATION_PX in any direction — before
 * the platform's scroll slop — so a drag that starts on the chart moves the
 * chart and the screen around it scrolls only from outside the chart
 * (2026-11-13; before, any vertical drag went to the screen). */
export default function CandlestickGestures({
  children,
  paddingLeft,
  innerWidth,
  chartWidth,
  chartHeight,
  onGestureStart,
  onPan,
  onZoom,
  onPriceScale,
  onPriceZoom,
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
    let panOrigin = { x: 0, y: 0 };
    // Where the finger went down decides the drag: the price axis (right of
    // the plot) scales prices, anywhere else moves the chart.
    let panMode: 'pan' | 'priceScale' = 'pan';
    // Only a drag that activated in THIS touch may end its session: a stale
    // 'priceScale' must never end a two-finger price scaling.
    let panActive = false;
    // A second finger in this touch sequence: its lift is never a tap.
    let multiTouch = false;

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
      .minDistance(CHART_PAN_ACTIVATION_PX)
      .minPointers(1)
      .maxPointers(1)
      .onStart((event) => {
        panOrigin = { x: event.translationX, y: event.translationY };
        panMode = event.x - event.translationX >= paddingLeft + innerWidth ? 'priceScale' : 'pan';
        panActive = session.begin(panMode);
      })
      .onUpdate((event) => {
        if (!panActive || !session.isOwner(panMode)) return;
        const dy = event.translationY - panOrigin.y;
        if (panMode === 'priceScale') onPriceScale(dy);
        else onPan(event.translationX - panOrigin.x, dy);
      })
      .onFinalize(() => {
        if (!panActive) return;
        panActive = false;
        session.end(panMode);
      })
      .runOnJS(true);

    // A simple tap: lifted before the long press, without travelling. Never
    // while another gesture owns the chart or after a second finger touched.
    const tap = Gesture.Tap()
      .maxDuration(LONG_PRESS_MS)
      .maxDistance(TAP_SLOP_PX)
      .onBegin(() => {
        multiTouch = false;
      })
      .onEnd((event, success) => {
        if (!success || multiTouch || session.owner() !== 'none') return;
        onCrosshair({ type: 'tap', point: { x: event.x, y: event.y } });
      })
      .runOnJS(true);

    let pairStart: TouchPair | null = null;
    let pairNow: TouchPair | null = null;
    let twoMode: 'pinch' | 'priceZoom' | 'priceScale' | null = null;
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
        return;
      }
      const scale = pinchScale(
        Math.hypot(pairNow[1].x - pairNow[0].x, pairNow[1].y - pairNow[0].y),
        Math.hypot(
          pairStart[1].x - pairStart[0].x,
          pairStart[1].y - pairStart[0].y,
        ),
      );
      // Y zooms about where the pinch began; X about the fingers' midpoint.
      if (mode === 'priceZoom')
        onPriceZoom(scale, (pairStart[0].y + pairStart[1].y) / 2);
      else onZoom(scale, (pairNow[0].x + pairNow[1].x) / 2 - paddingLeft);
    };
    const readTouches = (event: {
      allTouches: ChartTouch[];
      numberOfTouches: number;
    }) => {
      rawTouchesAvailable = true;
      if (event.numberOfTouches >= 2) multiTouch = true;
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
        multiTouch = true;
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
        Gesture.Race(crosshairPan, chartPan, tap),
      ),
      session,
    };
  }, [
    paddingLeft,
    innerWidth,
    chartWidth,
    chartHeight,
    onGestureStart,
    onPan,
    onZoom,
    onPriceScale,
    onPriceZoom,
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
