import React, { useMemo, useRef } from 'react';
import { View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import type { LineChartGesturesProps } from './LineChartGestures';

/** Touch-down previews without claiming the ScrollView. Only horizontal pan
 * activates; vertical movement fails the recognizer and clears the preview. */
export default function LineChartGestures({
  children,
  onSelect,
}: LineChartGesturesProps) {
  const callback = useRef(onSelect);
  callback.current = onSelect;
  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .maxPointers(1)
        .activeOffsetX([-8, 8])
        .failOffsetY([-8, 8])
        .onTouchesDown((event) => {
          callback.current(
            event.numberOfTouches === 1 ? event.allTouches[0].x : null,
          );
        })
        .onStart((event) => callback.current(event.x))
        .onUpdate((event) => callback.current(event.x))
        .onTouchesUp(() => callback.current(null))
        .onTouchesCancelled(() => callback.current(null))
        .onFinalize(() => callback.current(null)),
    [],
  );
  return (
    <GestureDetector gesture={gesture}>
      <View collapsable={false}>{children}</View>
    </GestureDetector>
  );
}
