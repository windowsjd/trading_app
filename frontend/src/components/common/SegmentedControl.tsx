import React, { useEffect, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { useReducedMotion } from '../../theme/useReducedMotion';
import ActionPressable from './ActionPressable';

/**
 * Reference video 2: the pill covers half its travel in the first frame and
 * settles in ~130ms. Ease-out cubic over 140ms measured 47/81/96% at
 * 33/67/100ms on web (reference 50/82/96%). Shared with the 매수/매도
 * segment so every selection moves alike.
 */
export const selectionMotion = { duration: 140 } as const;
/** Ease-out cubic (identical to Easing.out(Easing.cubic)). */
export const selectionEasing = (progress: number) => 1 - (1 - progress) ** 3;
const INSET = 3;

export type SegmentOption<K extends string> = {
  key: K;
  label: string;
  testID?: string;
  accessibilityLabel?: string;
  disabled?: boolean;
  /** e.g. a learning lock next to the label. */
  accessory?: React.ReactNode;
};

/**
 * One box for mutually exclusive choices. The caller owns `value`; the pill
 * only follows it, so a guarded choice (learning lock) never moves the pill
 * and the pill and the selected label can never disagree. Labels switch at
 * once, the track never re-lays out, and a rapid second tap continues from
 * the pill's current point.
 */
export default function SegmentedControl<K extends string>({ options, value, onChange, testID, accessibilityLabel, style, compact = false }: {
  options: readonly SegmentOption<K>[];
  value: K;
  onChange: (key: NoInfer<K>) => void;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  /** 36dp rows for dense forms; the default is the 44dp touch row. */
  compact?: boolean;
}) {
  const reduced = useReducedMotion();
  const { mode } = useAppearance();
  const [trackWidth, setTrackWidth] = useState(0);
  const index = Math.max(0, options.findIndex(option => option.key === value));
  const progress = useRef(new Animated.Value(index)).current;
  const shown = useRef(index);
  useEffect(() => {
    // Only an actual change moves; mount and a resolved motion preference land directly.
    const changed = shown.current !== index;
    shown.current = index;
    if (reduced || !changed) {
      progress.setValue(index);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: index,
      duration: selectionMotion.duration,
      easing: selectionEasing,
      useNativeDriver: Platform.OS !== 'web',
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [index, progress, reduced]);

  const count = Math.max(options.length, 1);
  const thumbWidth = Math.max(0, (trackWidth - INSET * 2) / count);
  const thumbColor = mode === 'dark' ? semantic.border : semantic.surface;
  return (
    <View testID={testID} accessibilityRole="tablist" accessibilityLabel={accessibilityLabel} style={[styles.track, style]}
      onLayout={(event) => {
        const width = event.nativeEvent.layout.width;
        setTrackWidth(previous => (Math.abs(previous - width) < 0.5 ? previous : width));
      }}>
      {thumbWidth > 0 ? (
        <Animated.View pointerEvents="none" testID={testID ? `${testID}-indicator` : undefined} style={[styles.thumb, {
          width: thumbWidth,
          transform: [{ translateX: progress.interpolate({ inputRange: [0, count], outputRange: [0, thumbWidth * count] }) }],
        }]}>
          <View style={[styles.thumbFill, { backgroundColor: thumbColor }]} />
        </Animated.View>
      ) : null}
      {options.map(option => {
        const selected = option.key === value;
        return (
          <ActionPressable
            key={option.key}
            feedback="selection"
            testID={option.testID}
            accessibilityRole="tab"
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected, disabled: !!option.disabled }}
            aria-selected={selected}
            disabled={option.disabled}
            // A compact row keeps the 44dp target through the track's inset.
            hitSlop={compact ? { top: 3, bottom: 3 } : undefined}
            // Before the track is measured there is no pill; the selected segment paints its own.
            style={[styles.segment, compact && styles.compact, thumbWidth === 0 && selected && { backgroundColor: thumbColor }]}
            onPress={() => { if (!selected) onChange(option.key); }}
          >
            <View style={styles.labelRow}>
              {option.accessory}
              <Text style={[styles.label, selected && styles.labelSelected, option.disabled && styles.labelDisabled]}>{option.label}</Text>
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
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  thumbFill: { ...StyleSheet.absoluteFillObject, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: semantic.border },
  // Each target spans the full track height; the pill stays inset by INSET.
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
  compact: { minHeight: 38, paddingVertical: 6 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, minWidth: 0, maxWidth: '100%' },
  label: { fontSize: 14, lineHeight: 20, fontWeight: '600', color: semantic.secondary, textAlign: 'center', flexShrink: 1 },
  labelSelected: { color: semantic.text, fontWeight: '700' },
  labelDisabled: { opacity: 0.5 },
});
