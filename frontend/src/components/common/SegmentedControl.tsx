import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, Text, View, type StyleProp, type ViewStyle } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { useReducedMotion } from '../../theme/useReducedMotion';
import ActionPressable from './ActionPressable';

/**
 * The selection slide is a critically damped spring, shared with the 매수/매도
 * segment. Android replays a native `timing` from a 60fps table without
 * interpolation (uneven steps at 90/120Hz) and skips ahead after a busy frame;
 * a native spring is integrated on the device's own frame clock and resumes
 * after a dropped frame. A light push starts it on the first frame without the
 * old jump: 20/37/64/80/94% at 17/33/67/100/167ms, never past the target.
 */
export const selectionMotion = { stiffness: 576, damping: 48, mass: 1, push: 12 } as const;
const OMEGA = Math.sqrt(selectionMotion.stiffness / selectionMotion.mass);
const INSET = 3;

/** One launched slide, in segment units and units per second. */
export type SelectionRun = { from: number; to: number; velocity: number; at: number };

/** Where a launched slide is after `seconds` (the spring's closed form). */
export function selectionState(run: SelectionRun, seconds: number) {
  const t = Math.max(0, seconds);
  const decay = Math.exp(-OMEGA * t);
  const distance = run.to - run.from;
  return {
    position: run.to - decay * (distance + (OMEGA * distance - run.velocity) * t),
    velocity: decay * (run.velocity * (1 - OMEGA * t) + OMEGA * OMEGA * distance * t),
  };
}

/**
 * Launch speed toward `to`: the current momentum plus the push, capped so a
 * critically damped spring cannot pass the target (or swing far away from it).
 */
export function selectionLaunchVelocity(position: number, velocity: number, to: number) {
  const distance = to - position;
  const limit = OMEGA * Math.abs(distance);
  return Math.min(limit, Math.max(-limit, velocity + selectionMotion.push * distance));
}

/**
 * The indicator follows `position`. Mount, an unchanged position and Reduced
 * Motion land directly; a change mid-slide starts from the current point with
 * its current velocity, so a rapid second tap neither stalls nor jumps back.
 */
export function useSelectionMotion(position: number, reduced: boolean) {
  const progress = useRef(new Animated.Value(position)).current;
  const shown = useRef(position);
  const run = useRef<SelectionRun | null>(null);
  useEffect(() => {
    const from = shown.current;
    shown.current = position;
    if (reduced || from === position) {
      run.current = null;
      progress.setValue(position);
      return;
    }
    // Monotonic: a wall-clock step must not invent momentum.
    const at = performance.now();
    // A long-finished run has settled at its target with no velocity.
    const current = run.current ? selectionState(run.current, (at - run.current.at) / 1000) : { position: from, velocity: 0 };
    const velocity = selectionLaunchVelocity(current.position, current.velocity, position);
    run.current = { from: current.position, to: position, velocity, at };
    const animation = Animated.spring(progress, {
      toValue: position,
      stiffness: selectionMotion.stiffness,
      damping: selectionMotion.damping,
      mass: selectionMotion.mass,
      velocity,
      overshootClamping: true,
      // Segment units: about 0.2pt and 2pt/s on a phone-width segment.
      restDisplacementThreshold: 0.002,
      restSpeedThreshold: 0.02,
      useNativeDriver: Platform.OS !== 'web',
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [position, progress, reduced]);
  return progress;
}

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
  const progress = useSelectionMotion(index, reduced);

  const count = Math.max(options.length, 1);
  const thumbWidth = Math.max(0, (trackWidth - INSET * 2) / count);
  // One node per geometry: a parent re-render (live prices) mid-slide must not
  // rebuild the native animated graph.
  const translateX = useMemo(
    () => progress.interpolate({ inputRange: [0, count], outputRange: [0, thumbWidth * count] }),
    [count, progress, thumbWidth],
  );
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
          transform: [{ translateX }],
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
