import React, { useCallback, useEffect, useRef } from 'react';
import { View } from 'react-native';

import {
  classifyWheelIntent,
  wheelZoomScale,
} from './candlestickGesturePolicy';
import type { CandlestickGesturesProps } from './CandlestickGestures';

/**
 * Web gesture adapter (react-native-web).
 *
 *  - LEFT MOUSE DRAG pans; the crosshair is suppressed while dragging and
 *    returns on the next hover move.
 *  - HOVER shows the crosshair; leaving the chart clears it.
 *  - CTRL/CMD + wheel — which is also what browsers report for a trackpad
 *    pinch — zooms about the pointer. Shift/horizontal wheel pans. A plain
 *    vertical wheel is left alone so the page keeps scrolling, and only the
 *    zoom/pan cases call preventDefault (so browser zoom is untouched).
 */
export default function CandlestickGestures({
  children,
  innerWidth,
  paddingLeft,
  slotWidth,
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

    const onWheel = (event: WheelEvent) => {
      const handlers = handlersRef.current;
      const intent = classifyWheelIntent(event);
      if (intent === 'page-scroll') return; // page keeps scrolling
      // Only zoom/pan consume the event.
      event.preventDefault();
      const local = toLocal(node, event.clientX, event.clientY);
      if (intent === 'zoom') {
        handlers.onGestureStart();
        handlers.onZoom(
          wheelZoomScale(event.deltaY),
          local.x - handlers.paddingLeft,
        );
        handlers.onGestureEnd();
        return;
      }
      handlers.onGestureStart();
      handlers.onPan(-(event.deltaX || event.deltaY));
      handlers.onGestureEnd();
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return;
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
    };
  }, [toLocal]);

  return <View ref={containerRef}>{children}</View>;
}
