import React, { useEffect, useRef } from 'react';
import { View } from '../../theme/native';
import {
  CHART_PAN_ACTIVATION_PX,
  createWheelGestureSession,
  resolveWheelHandling,
  wheelZoomScale,
} from './candlestickGesturePolicy';
import type { CandlestickGesturesProps } from './CandlestickGestures';

/** DOM adapter: one pointer either moves the chart (pressed on the plot, both
 * ways) or scales prices (pressed on the price axis), once it has travelled
 * CHART_PAN_ACTIVATION_PX; released before that it is a click, which pins the
 * crosshair there or clears the pinned one (2026-11-13). A mouse hovering
 * shows a following crosshair unless one is pinned; leaving clears only that.
 * Capture tracks outside release; every cancellation also closes wheel state.
 * The chart takes touch drags too (`touch-action: none`), the page scrolls
 * from outside it. */
export default function CandlestickGestures(props: CandlestickGesturesProps) {
  const containerRef = useRef<View>(null);
  const handlersRef = useRef(props);
  handlersRef.current = props;

  useEffect(() => {
    const node = containerRef.current as unknown as HTMLElement | null;
    if (!node?.addEventListener) return undefined;
    const previousStyles = {
      userSelect: node.style.userSelect,
      touchAction: node.style.touchAction,
    };
    node.style.userSelect = 'none';
    node.style.touchAction = 'none';
    let drag: {
      id: number;
      x: number;
      y: number;
      local: { x: number; y: number };
      mode: 'pan' | 'priceScale';
      started: boolean;
    } | null = null;
    const local = (event: { clientX: number; clientY: number }) => {
      const rect = node.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const wheel = createWheelGestureSession({
      onGestureStart: () => handlersRef.current.onGestureStart(),
      onZoom: (scale, x) => handlersRef.current.onZoom(scale, x),
      onPan: (x, y) => handlersRef.current.onPan(x, y),
      onGestureEnd: () => handlersRef.current.onGestureEnd(),
    });
    const endDrag = () => {
      const previous = drag;
      drag = null; // Clear first: releasePointerCapture may emit capture loss.
      if (!previous) return;
      if (node.hasPointerCapture?.(previous.id))
        node.releasePointerCapture(previous.id);
      if (previous.started) handlersRef.current.onGestureEnd();
    };
    // Blur, a hidden page, a cancelled pointer: end what is moving; a pinned
    // crosshair stays.
    const cancel = () => {
      endDrag();
      wheel.end();
      handlersRef.current.onCrosshair({ type: 'leave' });
    };
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.isPrimary === false || drag) return;
      wheel.end();
      const point = local(event);
      const h = handlersRef.current;
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        local: point,
        mode: point.x >= h.paddingLeft + h.innerWidth ? 'priceScale' : 'pan',
        started: false,
      };
      event.preventDefault();
      try {
        node.setPointerCapture?.(event.pointerId);
      } catch {
        /* Window release still applies. */
      }
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.id) return;
      // Recover even when the browser never delivered the terminal event.
      if ((event.buttons & 1) === 0) {
        cancel();
        return;
      }
      event.preventDefault();
      const h = handlersRef.current;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.started) {
        if (Math.hypot(dx, dy) < CHART_PAN_ACTIVATION_PX) return;
        drag.started = true;
        h.onCrosshair({ type: 'leave' });
        h.onGestureStart();
      }
      if (drag.mode === 'priceScale') h.onPriceScale(dy);
      else h.onPan(dx, dy);
    };
    const onHover = (event: PointerEvent) => {
      if (drag || event.buttons !== 0 || event.pointerType === 'touch') return;
      handlersRef.current.onCrosshair({ type: 'hover', point: local(event) });
    };
    const onUp = (event: PointerEvent) => {
      if (drag?.id !== event.pointerId) return;
      const click = !drag.started && event.type === 'pointerup' ? drag.local : null;
      endDrag();
      // Pressed and released in place: a click (or tap) toggles the pin.
      if (click) handlersRef.current.onCrosshair({ type: 'tap', point: click });
    };
    const onLeave = () => {
      if (!drag) handlersRef.current.onCrosshair({ type: 'leave' });
    };
    const onOut = (event: PointerEvent) => {
      if (!event.relatedTarget) cancel();
    };
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') cancel();
    };
    const onWheel = (event: WheelEvent) => {
      const handling = resolveWheelHandling(event, { dragActive: !!drag });
      if (handling === 'skip') return;
      event.preventDefault();
      if (handling === 'consume') return;
      if (handling === 'zoom')
        wheel.zoom(
          wheelZoomScale(event.deltaY),
          local(event).x - handlersRef.current.paddingLeft,
        );
      else wheel.pan(-(event.deltaX || event.deltaY));
    };

    node.addEventListener('pointerdown', onDown);
    node.addEventListener('pointermove', onHover);
    node.addEventListener('pointerleave', onLeave);
    node.addEventListener('lostpointercapture', onUp);
    node.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('pointerout', onOut);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancel();
      Object.assign(node.style, previousStyles);
      wheel.dispose();
      node.removeEventListener('pointerdown', onDown);
      node.removeEventListener('pointermove', onHover);
      node.removeEventListener('pointerleave', onLeave);
      node.removeEventListener('lostpointercapture', onUp);
      node.removeEventListener('wheel', onWheel);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('pointerout', onOut);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return (
    <View ref={containerRef} testID="candlestick-gestures">
      {props.children}
    </View>
  );
}
