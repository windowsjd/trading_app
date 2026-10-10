import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useReducedMotion } from '../../theme/useReducedMotion';
import ActionPressable from '../../components/common/ActionPressable';
import { TEST_IDS } from '../../constants/testIds';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';

export type OrderSide = 'buy' | 'sell';

const SIDES = ['buy', 'sell'] as const;
const LABEL = { buy: '매수', sell: '매도' } as const;
const COLOR = { buy: BUY_COLOR, sell: SELL_COLOR } as const;
const INSET = 3;
export const SIDE_SEGMENT_DURATION = 200;

/**
 * One track for 매수/매도. The selected side is owned by the caller and changes
 * immediately; only the colored thumb and label colors follow it visually.
 * Colors stay in themed Views (BUY_COLOR/SELL_COLOR), Animated wrappers carry
 * only transform and opacity.
 */
export default function OrderSideSegment({ side, onChange }: {
  side: OrderSide;
  onChange: (side: OrderSide) => void;
}) {
  const reduced = useReducedMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const progress = useRef(new Animated.Value(side === 'sell' ? 1 : 0)).current;
  const shownSide = useRef(side);
  useEffect(() => {
    const target = side === 'sell' ? 1 : 0;
    // Only an actual side change moves; mount and a resolved motion
    // preference land on the target directly.
    const changed = shownSide.current !== side;
    shownSide.current = side;
    if (reduced || !changed) {
      progress.setValue(target);
      return;
    }
    // A rapid second tap stops this run and continues from the current point.
    const animation = Animated.timing(progress, {
      toValue: target,
      duration: SIDE_SEGMENT_DURATION,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== 'web',
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reduced, side]);

  const thumbWidth = Math.max(0, (trackWidth - INSET * 2) / 2);
  const opacity = (value: OrderSide, active: boolean) =>
    progress.interpolate({
      inputRange: [0, 1],
      outputRange: (value === 'buy') === active ? [1, 0] : [0, 1],
    });
  return (
    <View
      testID="order-side-segment"
      accessibilityRole="tablist"
      style={styles.track}
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        setTrackWidth((previous) => (Math.abs(previous - width) < 0.5 ? previous : width));
      }}
    >
      {thumbWidth > 0 ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.thumb, {
            width: thumbWidth,
            transform: [{
              translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [0, thumbWidth] }),
            }],
          }]}
        >
          {SIDES.map((value) => (
            <Animated.View key={value} style={[styles.fill, { opacity: opacity(value, true) }]}>
              <View testID={`order-side-thumb-${value}`} style={[styles.fill, { backgroundColor: COLOR[value] }]} />
            </Animated.View>
          ))}
        </Animated.View>
      ) : null}
      {SIDES.map((value) => {
        const selected = side === value;
        return (
          <ActionPressable
            key={value}
            testID={value === 'buy' ? TEST_IDS.assetDetail.buyButton : TEST_IDS.assetDetail.sellButton}
            accessibilityRole="tab"
            accessibilityLabel={LABEL[value]}
            accessibilityState={{ selected }}
            aria-selected={selected}
            // Before the track is measured there is no thumb; the selected
            // segment paints its own color so no frame shows a neutral pair.
            style={[styles.segment, thumbWidth === 0 && selected && { backgroundColor: COLOR[value] }]}
            onPress={() => {
              if (value !== side) onChange(value);
            }}
          >
            <View style={styles.labelStack}>
              <Animated.View style={{ opacity: opacity(value, false) }}>
                <Text style={styles.label}>{LABEL[value]}</Text>
              </Animated.View>
              <Animated.View
                style={[styles.activeLabel, { opacity: opacity(value, true) }]}
                accessible={false}
                importantForAccessibility="no-hide-descendants"
              >
                <Text style={[styles.label, styles.labelActive]}>{LABEL[value]}</Text>
              </Animated.View>
            </View>
          </ActionPressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    minWidth: 0,
    padding: INSET,
    borderRadius: 11,
    backgroundColor: semantic.raised,
  },
  thumb: {
    position: 'absolute',
    top: INSET,
    bottom: INSET,
    left: INSET,
    borderRadius: 8,
    overflow: 'hidden',
  },
  fill: { ...StyleSheet.absoluteFillObject },
  // Each target spans the full 44px track; the thumb stays inset by INSET.
  segment: {
    flex: 1,
    minWidth: 0,
    minHeight: 44,
    marginVertical: -INSET,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  labelStack: { minWidth: 0, maxWidth: '100%' },
  activeLabel: { ...StyleSheet.absoluteFillObject },
  label: {
    fontSize: 14,
    fontWeight: '700',
    color: semantic.secondary,
    textAlign: 'center',
  },
  labelActive: { color: semantic.onAccent },
});
