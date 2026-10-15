import React, { useCallback, useMemo, useRef } from 'react';
import {
  Animated,
  Easing,
  Platform,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from '../../theme/native';
import { RIPPLE_BASE, rippleMotion, rippleOrigin, rippleScale, type RippleSize } from './pressFeedback';

export type InkRipple = ReturnType<typeof useInkRipple>;

/**
 * Touch-point ink for one surface. Press and release are imperative (they come
 * from Pressable events) and the measured size lives in a ref, so neither
 * mounting nor pressing re-renders the surface.
 */
export function useInkRipple(reduced: boolean) {
  const size = useRef<RippleSize>({ width: 0, height: 0 });
  const x = useRef(new Animated.Value(0)).current;
  const y = useRef(new Animated.Value(0)).current;
  const spread = useRef(new Animated.Value(0)).current;
  const fade = useRef(new Animated.Value(0)).current;
  // Ink a press started and no release has faded yet.
  const shown = useRef(false);
  const native = Platform.OS !== 'web';

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    size.current = { width, height };
  }, []);

  /** Local coordinates inside the surface; none (keyboard) starts at its center. */
  const press = useCallback((localX?: number, localY?: number) => {
    if (!size.current.width || !size.current.height) return;
    const origin = rippleOrigin(size.current, localX, localY);
    x.setValue(origin.x - RIPPLE_BASE / 2);
    y.setValue(origin.y - RIPPLE_BASE / 2);
    fade.setValue(1);
    shown.current = true;
    const cover = rippleScale(size.current, origin);
    if (reduced) {
      spread.setValue(cover);
      return;
    }
    spread.setValue(rippleMotion.startScale);
    Animated.timing(spread, {
      toValue: cover,
      duration: rippleMotion.spreadDuration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: native,
      isInteraction: false,
    }).start();
  }, [fade, native, reduced, spread, x, y]);

  /**
   * The spread keeps going while the ink fades, so a quick tap still reads.
   * Releasing ink that is already fading (or never started) changes nothing.
   */
  const release = useCallback(() => {
    if (!shown.current) return;
    shown.current = false;
    if (reduced) {
      fade.setValue(0);
      return;
    }
    Animated.timing(fade, {
      toValue: 0,
      duration: rippleMotion.fadeDuration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: native,
      isInteraction: false,
    }).start();
  }, [fade, native, reduced]);

  return { x, y, spread, fade, onLayout, press, release };
}

/** The caller positions the layer (fill or a compact surface); it clips to that shape. */
export function InkRippleLayer({ ripple, color, opacity, style }: {
  ripple: InkRipple;
  color: string;
  opacity: number;
  style?: StyleProp<ViewStyle>;
}) {
  // The pressed state re-renders this layer as the ink starts; keep one native node.
  const fade = useMemo(
    () => ripple.fade.interpolate({ inputRange: [0, 1], outputRange: [0, opacity], extrapolate: 'clamp' }),
    [opacity, ripple.fade],
  );
  return (
    <View pointerEvents="none" accessible={false} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants" onLayout={ripple.onLayout} style={[styles.clip, style]}>
      <Animated.View pointerEvents="none" style={[styles.ink, {
        backgroundColor: color,
        opacity: fade,
        transform: [{ translateX: ripple.x }, { translateY: ripple.y }, { scale: ripple.spread }],
      }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  ink: { position: 'absolute', left: 0, top: 0, width: RIPPLE_BASE, height: RIPPLE_BASE, borderRadius: RIPPLE_BASE / 2 },
});
