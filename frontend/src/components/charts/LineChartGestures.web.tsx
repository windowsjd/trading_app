import React, { useEffect, useRef } from 'react';
import { View, type ViewStyle } from 'react-native';
import type { LineChartGesturesProps } from './LineChartGestures';

export default function LineChartGestures({
  children,
  onSelect,
}: LineChartGesturesProps) {
  const ref = useRef<View>(null);
  const callback = useRef(onSelect);
  callback.current = onSelect;
  useEffect(() => {
    const node = ref.current as unknown as HTMLElement | null;
    if (!node?.addEventListener) return;
    let origin: { x: number; y: number } | null = null;
    let vertical = false;
    const select = (event: PointerEvent) =>
      callback.current(event.clientX - node.getBoundingClientRect().left);
    const down = (event: PointerEvent) => {
      origin = { x: event.clientX, y: event.clientY };
      vertical = false;
      select(event);
    };
    const move = (event: PointerEvent) => {
      if (
        origin &&
        Math.abs(event.clientY - origin.y) > 8 &&
        Math.abs(event.clientY - origin.y) > Math.abs(event.clientX - origin.x)
      )
        vertical = true;
      if (vertical) callback.current(null);
      else if (origin || event.pointerType === 'mouse') select(event);
    };
    const end = () => {
      origin = null;
      vertical = false;
      callback.current(null);
    };
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerleave', end);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
    return () => {
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerleave', end);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
    };
  }, []);
  return (
    <View ref={ref} style={{ touchAction: 'pan-y' } as ViewStyle}>
      {children}
    </View>
  );
}
