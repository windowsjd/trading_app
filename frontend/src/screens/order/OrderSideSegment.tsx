import React, { useMemo, useState } from 'react';
import { Animated, StyleSheet, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useReducedMotion } from '../../theme/useReducedMotion';
import ActionPressable from '../../components/common/ActionPressable';
import { useSelectionMotion } from '../../components/common/SegmentedControl';
import { TEST_IDS } from '../../constants/testIds';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';

export type OrderSide = 'buy' | 'sell';

const SIDES = ['buy', 'sell'] as const;
const LABEL: Record<OrderSide, string> = { buy: '매수', sell: '매도' };
const TEST_ID: Record<OrderSide, string> = { buy: TEST_IDS.assetDetail.buyButton, sell: TEST_IDS.assetDetail.sellButton };
const COLOR = { buy: BUY_COLOR, sell: SELL_COLOR } as const;
const INSET = 3;

/**
 * One track for 매수/매도. The selected side is owned by the caller and changes
 * immediately; only the colored thumb and label colors follow it visually, on
 * the same selection motion as every segmented control. The sliding thumb is
 * the feedback, so a press only tints the target (no ink over the thumb).
 * Colors stay in themed Views (BUY_COLOR/SELL_COLOR), Animated wrappers carry
 * only transform and opacity. Futures reuses the track for 롱/숏 (`labels`),
 * which take the same BUY/SELL colors as their positions.
 */
export default function OrderSideSegment({ side, onChange, labels = LABEL, testIDs = TEST_ID, testID = 'order-side-segment', disabled = false }: {
  side: OrderSide;
  onChange: (side: OrderSide) => void;
  labels?: Record<OrderSide, string>;
  testIDs?: Record<OrderSide, string>;
  testID?: string;
  /** A command in flight keeps the committed side. */
  disabled?: boolean;
}) {
  const reduced = useReducedMotion();
  const [trackWidth, setTrackWidth] = useState(0);
  const progress = useSelectionMotion(side === 'sell' ? 1 : 0, reduced);

  const thumbWidth = Math.max(0, (trackWidth - INSET * 2) / 2);
  const translateX = useMemo(
    () => progress.interpolate({ inputRange: [0, 1], outputRange: [0, thumbWidth] }),
    [progress, thumbWidth],
  );
  // Label and thumb fills cross-fade on the thumb's own clock.
  const fades = useMemo(() => {
    const fade = (outputRange: number[]) => progress.interpolate({ inputRange: [0, 1], outputRange });
    return { buy: { active: fade([1, 0]), resting: fade([0, 1]) }, sell: { active: fade([0, 1]), resting: fade([1, 0]) } };
  }, [progress]);
  const opacity = (value: OrderSide, active: boolean) => fades[value][active ? 'active' : 'resting'];
  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      style={[styles.track, disabled && styles.disabled]}
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
            transform: [{ translateX }],
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
            feedback="selection"
            testID={testIDs[value]}
            accessibilityRole="tab"
            accessibilityLabel={labels[value]}
            accessibilityState={{ selected, disabled }}
            aria-selected={selected}
            disabled={disabled}
            // Before the track is measured there is no thumb; the selected
            // segment paints its own color so no frame shows a neutral pair.
            style={[styles.segment, thumbWidth === 0 && selected && { backgroundColor: COLOR[value] }]}
            onPress={() => {
              if (value !== side) onChange(value);
            }}
          >
            <View style={styles.labelStack}>
              <Animated.View style={{ opacity: opacity(value, false) }}>
                <Text style={styles.label}>{labels[value]}</Text>
              </Animated.View>
              <Animated.View
                style={[styles.activeLabel, { opacity: opacity(value, true) }]}
                accessible={false}
                importantForAccessibility="no-hide-descendants"
              >
                <Text style={[styles.label, styles.labelActive]}>{labels[value]}</Text>
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
  disabled: { opacity: 0.5 },
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
