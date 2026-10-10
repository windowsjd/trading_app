import React, { useEffect, useId, useRef, useState } from 'react';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Animated, Easing, Platform, StyleSheet, View } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { useAppearance } from '../../theme/appearance';

const SWEEP_MS = 720;
const CYCLE_MS = 2500;

/** Surface decoration only. The owner gates it by the current guide and capability. */
export default function QuestTargetHighlight({ active, radius }: { active: boolean; radius: number }) {
  const reducedMotion = useReducedMotion();
  const { mode } = useAppearance();
  const sweep = useRef(new Animated.Value(0)).current;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const id = `quest-shine-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const native = Platform.OS !== 'web';
  useEffect(() => {
    sweep.setValue(0);
    if (!active || reducedMotion || !size.width) return;
    const animation = Animated.loop(Animated.sequence([
      Animated.timing(sweep, { toValue: 1, duration: SWEEP_MS, easing: Easing.linear, useNativeDriver: native, isInteraction: false }),
      Animated.delay(CYCLE_MS - SWEEP_MS),
    ]));
    animation.start();
    return () => { animation.stop(); sweep.setValue(0); };
  }, [active, native, reducedMotion, size.width, sweep]);

  if (!active) return null;
  return (
    <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      testID="quest-target-highlight" style={StyleSheet.absoluteFill}
      onLayout={event => {
        const { width, height } = event.nativeEvent.layout;
        setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
      }}>
      <View style={[styles.halo, { borderRadius: radius + 4 }]} />
      <View testID="quest-target-glow" style={[styles.glow, { borderRadius: radius, shadowOpacity: mode === 'dark' ? 0.35 : 0.22 }]} />
      {reducedMotion || !size.width ? null : (
        <View style={[StyleSheet.absoluteFill, { borderRadius: radius, overflow: 'hidden' }]}>
          <Animated.View testID="quest-target-shimmer" style={{
            position: 'absolute', top: -size.height / 2, width: size.width * 0.65, height: size.height * 2,
            transform: [{ translateX: sweep.interpolate({ inputRange: [0, 1], outputRange: [-size.width, size.width * 1.5] }) }, { rotate: '20deg' }],
          }}>
            <Svg width="100%" height="100%" pointerEvents="none">
              <Defs><LinearGradient id={id} x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0} />
                <Stop offset="0.5" stopColor="#FFFFFF" stopOpacity={0.32} />
                <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
              </LinearGradient></Defs>
              <Rect width="100%" height="100%" fill={`url(#${id})`} />
            </Svg>
          </Animated.View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // A faint halo also works on Android versions without native shadow blur.
  halo: { position: 'absolute', top: -4, bottom: -4, left: -4, right: -4, borderWidth: 4, borderColor: 'rgba(112,175,255,0.08)' },
  glow: { ...StyleSheet.absoluteFillObject, borderWidth: 1, borderColor: 'rgba(112,175,255,0.45)',
    shadowColor: '#70AFFF', shadowRadius: 10, shadowOffset: { width: 0, height: 0 },
    backgroundColor: 'rgba(112,175,255,0.06)' },
});
