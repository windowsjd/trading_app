import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import {
  createWheelGestureSession,
  resolveWheelHandling,
  wheelZoomScale,
} from './candlestickGesturePolicy';
import type { CandlestickGesturesProps } from './CandlestickGestures';

/** DOM adapter: one pointer owns either plot X-pan or price-axis Y-scale.
 * Capture tracks outside release; every cancellation also closes wheel state. */
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
    node.style.touchAction = 'pan-y';
    let drag: {
      id: number;
      x: number;
      y: number;
      mode: 'pan' | 'priceScale';
    } | null = null;
    const local = (event: { clientX: number; clientY: number }) => {
      const rect = node.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const wheel = createWheelGestureSession({
      onGestureStart: () => handlersRef.current.onGestureStart(),
      onZoom: (scale, x) => handlersRef.current.onZoom(scale, x),
      onPan: (x) => handlersRef.current.onPan(x),
      onGestureEnd: () => handlersRef.current.onGestureEnd(),
    });
    const endDrag = () => {
      const previous = drag;
      drag = null; // Clear first: releasePointerCapture may emit capture loss.
      if (!previous) return;
      if (node.hasPointerCapture?.(previous.id))
        node.releasePointerCapture(previous.id);
      handlersRef.current.onGestureEnd();
    };
    const cancel = () => {
      endDrag();
      wheel.end();
      handlersRef.current.onCrosshair(null);
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
        mode: point.x >= h.paddingLeft + h.innerWidth ? 'priceScale' : 'pan',
      };
      event.preventDefault();
      try {
        node.setPointerCapture?.(event.pointerId);
      } catch {
        /* Window release still applies. */
      }
      h.onGestureStart();
      h.onCrosshair(null);
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
      if (drag.mode === 'priceScale') h.onPriceScale(event.clientY - drag.y);
      else h.onPan(event.clientX - drag.x);
    };
    const onHover = (event: PointerEvent) => {
      if (drag || event.buttons !== 0) return;
      handlersRef.current.onCrosshair(local(event));
    };
    const onUp = (event: PointerEvent) => {
      if (drag?.id === event.pointerId) cancel();
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
    node.addEventListener('pointerleave', cancel);
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
      node.removeEventListener('pointerleave', cancel);
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
