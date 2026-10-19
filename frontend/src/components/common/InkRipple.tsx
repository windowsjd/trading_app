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

type Measurable = { measure?: (callback: (x: number, y: number, width: number, height: number) => void) => void };

/**
 * Touch-point ink for one surface. Press and release are imperative (they come
 * from Pressable events) and the measured size lives in a ref, so neither
 * mounting nor pressing re-renders the surface.
 */
export function useInkRipple(reduced: boolean) {
  const size = useRef<RippleSize>({ width: 0, height: 0 });
  // The ink layer itself, measured on a press its first onLayout has not reached yet.
  const layer = useRef<View | null>(null);
  // A press waiting for that measurement; a release before it arrives is kept.
  const pending = useRef<{ released: boolean } | null>(null);
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

  const start = useCallback((localX?: number, localY?: number) => {
    const origin = rippleOrigin(size.current, localX, localY);
    const cover = rippleScale(size.current, origin);
    // Android applies each native setValue as its own batch, so a frame can
    // land between two of them. Shrink first, then move, then show: no frame
    // paints the previous press's spread ink at the new point or at full
    // opacity (a card-wide flash, or an arc where it no longer covers).
    spread.setValue(reduced ? cover : rippleMotion.startScale);
    x.setValue(origin.x - RIPPLE_BASE / 2);
    y.setValue(origin.y - RIPPLE_BASE / 2);
    fade.setValue(1);
    shown.current = true;
    if (reduced) return;
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
    if (pending.current) pending.current.released = true;
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

  /**
   * Local coordinates inside the surface; none (keyboard) starts at its center.
   * Layout events reach JS asynchronously, late on a busy JS thread (a list of
   * rows that just mounted under live prices): a press before the layer's first
   * onLayout measures it instead of showing nothing. Fabric answers that from
   * the committed layout at once; an asynchronous answer (web) still inks.
   */
  const press = useCallback((localX?: number, localY?: number) => {
    pending.current = null;
    if (size.current.width && size.current.height) {
      start(localX, localY);
      return;
    }
    const node = layer.current as unknown as Measurable | null;
    if (!node?.measure) return;
    const token = { released: false };
    pending.current = token;
    node.measure((_x, _y, width, height) => {
      if (pending.current !== token) return;
      pending.current = null;
      if (!width || !height) return;
      if (!size.current.width || !size.current.height) size.current = { width, height };
      start(localX, localY);
      // Released before the size arrived: the ink still shows, then fades.
      if (token.released) release();
    });
  }, [release, start]);

  return { x, y, spread, fade, layer, onLayout, press, release };
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
    <View ref={ripple.layer} pointerEvents="none" accessible={false} accessibilityElementsHidden
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
