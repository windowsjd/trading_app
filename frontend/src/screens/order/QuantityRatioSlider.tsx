import { semantic } from '../../theme/tokens';
import React, { useRef, useState } from 'react';
import { StyleSheet, View } from '../../theme/native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';

export type QuantityRatioSliderProps = {
  /** Defaults to the order form's `order-quantity-slider`. */
  testID?: string;
  accessibilityLabel?: string;
  value: number;
  disabled: boolean;
  disabledReason?: string;
  onChange: (ratio: number) => void;
  /** Positions on the track (default 100: whole percents). */
  steps?: number;
  /** Spoken value of a position (default `n%`). */
  valueText?: (step: number) => string;
  /** One step for the accessibility actions (default `1%`). */
  stepLabel?: string;
};

const THUMB_SIZE = 20;

/** A horizontal gesture leaves vertical scrolling to the containing screen. */
export default function QuantityRatioSlider(props: QuantityRatioSliderProps) {
  const [width, setWidth] = useState(0);
  const current = useRef(props);
  current.current = props;
  const trackWidth = Math.max(0, width - THUMB_SIZE);
  const steps = props.steps ?? 100;
  const step = Math.round(props.value * steps);
  const valueText = props.valueText ?? ((value: number) => `${value}%`);
  const stepLabel = props.stepLabel ?? '1%';
  const change = (ratio: number) => {
    if (!current.current.disabled) {
      const total = current.current.steps ?? 100;
      current.current.onChange(
        Math.max(0, Math.min(total, Math.round(ratio * total))) / total,
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
        testID={props.testID ?? 'order-quantity-slider'}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={props.accessibilityLabel ?? '주문 수량 비율'}
        accessibilityHint={props.disabledReason}
        accessibilityState={{ disabled: props.disabled }}
        accessibilityValue={{
          min: 0,
          max: steps,
          now: step,
          text: valueText(step),
        }}
        accessibilityActions={[
          { name: 'increment', label: `${stepLabel} 늘리기` },
          { name: 'decrement', label: `${stepLabel} 줄이기` },
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          if (nativeEvent.actionName === 'increment')
            change((step + 1) / steps);
          if (nativeEvent.actionName === 'decrement')
            change((step - 1) / steps);
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
    backgroundColor: semantic.border,
  },
  fill: { height: 4, borderRadius: 2, backgroundColor: semantic.selected },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: semantic.selected,
  },
});
