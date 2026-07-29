import React, { useCallback, useEffect, useRef } from 'react';
import { View } from 'react-native';

import {
  createWheelGestureSession,
  resolveWheelHandling,
  wheelZoomScale,
} from './candlestickGesturePolicy';
import type { CandlestickGesturesProps } from './CandlestickGestures';

/**
 * Web gesture adapter (react-native-web).
 *
 *  - LEFT MOUSE DRAG pans; the crosshair is suppressed while dragging and
 *    returns on the next hover move.
 *  - HOVER shows the crosshair; leaving the chart clears it.
 *  - A wheel that arrives DURING a drag is swallowed (still `preventDefault`,
 *    but no zoom/pan and no wheel session): one gesture owns the viewport at a
 *    time. Wheels work normally again after mouseup.
 *  - WHEEL over the chart zooms about the pointer — a plain vertical wheel,
 *    and equally Ctrl/Cmd + wheel, which is what browsers report for a
 *    trackpad pinch. Shift + wheel and horizontal trackpad input pan instead.
 *    Every wheel event the chart handles calls `preventDefault()` (the
 *    listener is `passive: false`), so the page neither scrolls nor
 *    browser-zooms while the pointer is over the chart; wheels anywhere else
 *    never reach this adapter and scroll the detail screen normally.
 *  - A wheel BURST is one gesture: the viewport is snapshotted once and each
 *    event applies the accumulated zoom/pan against it, so fast scrolling
 *    accumulates instead of re-zooming a stale snapshot (see
 *    `createWheelGestureSession`).
 */
export default function CandlestickGestures({
  children,
  innerWidth,
  paddingLeft,
  slotWidth,
  chartWidth,
  chartHeight,
  onGestureStart,
  onPan,
  onZoom,
  onCrosshair,
  onGestureEnd,
}: CandlestickGesturesProps) {
  const containerRef = useRef<View>(null);
  const dragRef = useRef<{ active: boolean; startX: number }>({
    active: false,
    startX: 0,
  });
  // Handlers are attached once; the latest callbacks are read through a ref.
  const handlersRef = useRef({
    innerWidth,
    paddingLeft,
    slotWidth,
    chartWidth,
    chartHeight,
    onGestureStart,
    onPan,
    onZoom,
    onCrosshair,
    onGestureEnd,
  });
  handlersRef.current = {
    innerWidth,
    paddingLeft,
    slotWidth,
    chartWidth,
    chartHeight,
    onGestureStart,
    onPan,
    onZoom,
    onCrosshair,
    onGestureEnd,
  };

  const toLocal = useCallback((node: HTMLElement, clientX: number, clientY: number) => {
    const rect = node.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }, []);

  useEffect(() => {
    const node = containerRef.current as unknown as HTMLElement | null;
    if (!node?.addEventListener) return undefined;

    const wheelSession = createWheelGestureSession({
      onGestureStart: () => handlersRef.current.onGestureStart(),
      onZoom: (scale, focalX) => handlersRef.current.onZoom(scale, focalX),
      onPan: (translationX) => handlersRef.current.onPan(translationX),
      onGestureEnd: () => handlersRef.current.onGestureEnd(),
    });

    const onWheel = (event: WheelEvent) => {
      const handlers = handlersRef.current;
      const handling = resolveWheelHandling(event, {
        dragActive: dragRef.current.active,
      });
      if (handling === 'skip') return;
      // The chart handles every wheel that lands on it, so the page must not
      // scroll or browser-zoom underneath it — including the wheels swallowed
      // during a drag.
      event.preventDefault();
      // Mid-drag: consumed, but no zoom, no pan and NO wheel session, so the
      // drag keeps its own viewport snapshot and its single start/end pair.
      if (handling === 'consume') return;
      const local = toLocal(node, event.clientX, event.clientY);
      if (handling === 'zoom') {
        wheelSession.zoom(
          wheelZoomScale(event.deltaY),
          local.x - handlers.paddingLeft,
        );
        return;
      }
      wheelSession.pan(-(event.deltaX || event.deltaY));
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
      // A drag owns the viewport snapshot: close any open wheel session first.
      wheelSession.end();
      dragRef.current = { active: true, startX: event.clientX };
      handlersRef.current.onGestureStart();
      handlersRef.current.onCrosshair(null);
    };

    const onMouseMove = (event: MouseEvent) => {
      const handlers = handlersRef.current;
      if (dragRef.current.active) {
        handlers.onPan(event.clientX - dragRef.current.startX);
        return;
      }
      const local = toLocal(node, event.clientX, event.clientY);
      handlers.onCrosshair(local);
    };

    const endDrag = () => {
      if (!dragRef.current.active) return;
      dragRef.current = { active: false, startX: 0 };
      handlersRef.current.onGestureEnd();
    };

    const onMouseLeave = () => {
      endDrag();
      wheelSession.end();
      handlersRef.current.onCrosshair(null);
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    node.addEventListener('mousedown', onMouseDown);
    node.addEventListener('mousemove', onMouseMove);
    node.addEventListener('mouseleave', onMouseLeave);
    // Releasing outside the chart must still end the drag.
    window.addEventListener('mouseup', endDrag);

    return () => {
      node.removeEventListener('wheel', onWheel);
      node.removeEventListener('mousedown', onMouseDown);
      node.removeEventListener('mousemove', onMouseMove);
      node.removeEventListener('mouseleave', onMouseLeave);
      window.removeEventListener('mouseup', endDrag);
      // Drop the pending idle timer so it cannot fire after unmount.
      wheelSession.dispose();
    };
  }, [toLocal]);

  return <View ref={containerRef}>{children}</View>;
}
