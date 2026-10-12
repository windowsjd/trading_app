import React, { useEffect, useRef } from 'react';
import Svg, { Path } from 'react-native-svg';
import { Animated, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from '../../theme/native';
import { useAppearance } from '../../theme/appearance';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { primaryGradient } from '../../theme/tokens';

/** Brand whale (two-lobed fluke) in a 32×32 box; the body sits slightly low-left. */
export const WHALE_PATH = 'M2.5 18.6C2.5 14.2 6.6 11.4 12.4 11.4C17.6 11.4 21.2 13.8 23.4 16.6C24.3 15.6 25 14.3 25.2 12.8C24.1 12.3 23.2 11.4 22.7 10C24.2 9.9 25.4 10.3 26.2 11.1C26.9 9.9 28.2 9 29.8 8.8C29.6 10.4 28.7 11.8 27.4 12.6C26.9 16 24.7 19.8 19.8 21.6C15.4 23.2 8.8 23 5.6 21.5C3.6 20.6 2.5 19.7 2.5 18.6Z';

/** One indeterminate lap; the arc never claims a share of the work. */
export const WHALE_LOADER_LAP_MS = 1100;
const ARC_SHARE = 0.28;
const linear = (progress: number) => progress;
/** A real progress value is shown below 100% until the caller finishes. */
export const MAX_DISPLAYED_PROGRESS = 0.99;

export function displayedProgress(progress: number | null | undefined): number | null {
  if (typeof progress !== 'number' || !Number.isFinite(progress)) return null;
  return Math.min(Math.max(progress, 0), MAX_DISPLAYED_PROGRESS);
}

const ring = (center: number, radius: number) =>
  `M${center} ${center - radius}A${radius} ${radius} 0 1 1 ${center} ${center + radius}A${radius} ${radius} 0 1 1 ${center} ${center - radius}`;

type Props = {
  /** Outer diameter: 20–24 inside buttons, 56 for a screen. */
  size?: number;
  /** Known progress 0–1. Omit for work whose progress is unknown (API reads). */
  progress?: number | null;
  /** `onAction` sits on a filled brand/colored button (white ink). */
  tone?: 'brand' | 'onAction';
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Trading Class loading mark: the brand whale inside a ring. Unknown progress
 * circles the ring; known progress fills it clockwise from the top. The caller
 * unmounts it on completion, failure or cancel.
 */
export default function WhaleLoader({ size = 56, progress, tone = 'brand', accessibilityLabel = '불러오는 중', testID, style }: Props) {
  const { mode } = useAppearance();
  const reduced = useReducedMotion();
  const spin = useRef(new Animated.Value(0)).current;
  const value = displayedProgress(progress);
  const spinning = value === null && !reduced;

  useEffect(() => {
    spin.setValue(0);
    if (!spinning) return;
    // One native-driven loop: the ring turns on the UI thread without a JS lap.
    const loop = Animated.loop(Animated.timing(spin, {
      toValue: 1,
      duration: WHALE_LOADER_LAP_MS,
      easing: linear,
      useNativeDriver: Platform.OS !== 'web',
      isInteraction: false,
    }));
    loop.start();
    return () => loop.stop();
  }, [spin, spinning]);

  const onAction = tone === 'onAction';
  const accent = onAction ? primaryGradient.foreground : mode === 'dark' ? '#7aa5ff' : primaryGradient.colors[0];
  const track = onAction ? 'rgba(255,255,255,0.35)' : mode === 'dark' ? 'rgba(122,165,255,0.22)' : 'rgba(50,111,229,0.16)';
  const disc = onAction ? undefined : mode === 'dark' ? 'rgba(122,165,255,0.10)' : 'rgba(50,111,229,0.07)';
  const stroke = Math.max(2, Math.round(size * 0.075 * 10) / 10);
  const center = size / 2;
  const radius = center - stroke / 2;
  const circumference = 2 * Math.PI * radius;
  const whale = size * 0.62;
  const arc = (share: number) => (
    <Path d={ring(center, radius)} stroke={accent} strokeWidth={stroke} strokeLinecap="round" fill="none"
      strokeDasharray={[Math.max(share * circumference, 0.01), circumference]} />
  );

  return (
    <View testID={testID} accessible accessibilityRole="progressbar" accessibilityLabel={accessibilityLabel}
      accessibilityState={{ busy: true }}
      accessibilityValue={value === null ? undefined : { min: 0, max: 100, now: Math.round(value * 100) }}
      style={[{ width: size, height: size }, style]}>
      <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} accessible={false}>
        {disc ? <Path d={ring(center, radius)} fill={disc} /> : null}
        <Path d={ring(center, radius)} stroke={track} strokeWidth={stroke} fill="none" />
        {/* Reduced Motion with unknown progress shows no arc: a still arc would read as a share. */}
        {value !== null ? arc(value) : null}
      </Svg>
      {spinning ? (
        <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, {
          transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
        }]}>
          <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} accessible={false}>{arc(ARC_SHARE)}</Svg>
        </Animated.View>
      ) : null}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center]}>
        {/* Optical centering: the fluke rises to the upper right. */}
        <Svg width={whale} height={whale} viewBox="0 0 32 32" accessible={false} style={{ marginTop: size * 0.05, marginLeft: -size * 0.02 }}>
          <Path d={WHALE_PATH} fill={accent} />
        </Svg>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
});
