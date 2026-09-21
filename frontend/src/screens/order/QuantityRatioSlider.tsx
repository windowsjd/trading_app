import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

export type QuantityRatioSliderProps = {
  value: number;
  disabled: boolean;
  disabledReason?: string;
  onChange: (ratio: number) => void;
};

const THUMB_SIZE = 20;

/** A horizontal gesture leaves vertical scrolling to the containing screen. */
export default function QuantityRatioSlider(props: QuantityRatioSliderProps) {
  const [width, setWidth] = useState(0);
  const current = useRef(props);
  current.current = props;
  const trackWidth = Math.max(0, width - THUMB_SIZE);
  const change = (ratio: number) => {
    if (!current.current.disabled) {
      current.current.onChange(
        Math.max(0, Math.min(100, Math.round(ratio * 100))) / 100,
      );
    }
  };
  const changeAt = (x: number) => {
    if (trackWidth > 0) change((x - THUMB_SIZE / 2) / trackWidth);
  };
  const pan = Gesture.Pan()
    .enabled(!props.disabled)
    .activeOffsetX([-4, 4])
    .failOffsetY([-8, 8])
    .maxPointers(1)
    .onStart((event) => changeAt(event.x))
    .onUpdate((event) => changeAt(event.x))
    .runOnJS(true);
  const tap = Gesture.Tap()
    .enabled(!props.disabled)
    .maxDistance(8)
    .onEnd((event, success) => {
      if (success) changeAt(event.x);
    })
    .runOnJS(true);

  return (
    <GestureDetector gesture={Gesture.Race(pan, tap)}>
      <View
        testID="order-quantity-slider"
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="주문 수량 비율"
        accessibilityHint={props.disabledReason}
        accessibilityState={{ disabled: props.disabled }}
        accessibilityValue={{
          min: 0,
          max: 100,
          now: Math.round(props.value * 100),
          text: `${Math.round(props.value * 100)}%`,
        }}
        accessibilityActions={[
          { name: 'increment', label: '1% 늘리기' },
          { name: 'decrement', label: '1% 줄이기' },
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === 'increment')
            change(props.value + 0.01);
          if (nativeEvent.actionName === 'decrement')
            change(props.value - 0.01);
        }}
        onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)}
        style={[styles.control, props.disabled && styles.disabled]}
      >
        <View pointerEvents="none" style={styles.track}>
          <View style={[styles.fill, { width: `${props.value * 100}%` }]} />
        </View>
        <View
          pointerEvents="none"
          style={[styles.thumb, { left: trackWidth * props.value }]}
        />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  control: { height: 44, width: '100%', minWidth: 0, justifyContent: 'center' },
  disabled: { opacity: 0.4 },
  track: {
    height: 4,
    marginHorizontal: THUMB_SIZE / 2,
    borderRadius: 2,
    backgroundColor: '#dfe4e9',
  },
  fill: { height: 4, borderRadius: 2, backgroundColor: '#202a35' },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: '#202a35',
  },
});
