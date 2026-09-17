import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Animated, Easing, Platform, Pressable, processColor, StyleSheet, View,
  type GestureResponderEvent, type PressableProps, type ViewStyle,
} from 'react-native';
import { getFeedbackPalette, getRippleGeometry } from './pressFeedback';

type Props = Omit<PressableProps, 'android_ripple'> & { ref?: React.Ref<View> };
type Ripple = ReturnType<typeof getRippleGeometry> & { id: number };
const animationOptions = {
  useNativeDriver: Platform.OS !== 'web',
  isInteraction: false,
  easing: Easing.out(Easing.quad),
};

/** One local interaction; the original Pressable still owns layout and actions. */
export default function ActionPressable({
  children, style, disabled, onPress, onPressIn, onPressOut, ref, ...props
}: Props) {
  const host = useRef<View>(null);
  const session = useRef({ id: 0, active: false });
  const [ripple, setRipple] = useState<Ripple | null>(null);
  const [motion] = useState(() => ({
    scale: new Animated.Value(0.02),
    opacity: new Animated.Value(0),
    wash: new Animated.Value(0),
  }));
  const enabled = !disabled && !props['aria-disabled'] && !props.accessibilityState?.disabled && !!onPress;

  useLayoutEffect(() => {
    if (ripple && ripple.id === session.current.id) {
      Animated.timing(motion.scale, { ...animationOptions, toValue: 1, duration: 240 }).start();
    }
  }, [motion, ripple]);

  useEffect(() => {
    // Also cancels a late measure callback when disabled or unmounted.
    if (!enabled) setRipple(null);
    return () => {
      session.current = { id: session.current.id + 1, active: false };
      motion.scale.stopAnimation();
      motion.opacity.stopAnimation();
      motion.wash.stopAnimation();
      motion.opacity.setValue(0);
      motion.wash.setValue(0);
    };
  }, [enabled, motion]);

  const start = (event: GestureResponderEvent) => {
    if (enabled) {
      const id = ++session.current.id;
      session.current.active = true;
      const { pageX, pageY } = event.nativeEvent;
      setRipple(null);
      motion.scale.stopAnimation();
      motion.scale.setValue(0.02);
      motion.opacity.setValue(1);
      motion.wash.setValue(1);
      // Measure the actual root on every press, including after list/page scroll.
      // This only positions the visual; onPress never waits for measurement.
      host.current?.measure((_x, _y, width, height, rootX, rootY) => {
        // A quick release may precede measure. It can still show the remainder
        // of the short fade, but never revive an expired/cancelled session.
        if (session.current.id !== id || width <= 0 || height <= 0) return;
        setRipple({ ...getRippleGeometry(pageX, pageY, { pageX: rootX, pageY: rootY, width, height }), id });
      });
    }
    onPressIn?.(event);
  };

  const end = (event: GestureResponderEvent) => {
    session.current.active = false;
    const id = session.current.id;
    if (enabled) {
      Animated.timing(motion.wash, { ...animationOptions, toValue: 0, duration: 120 }).start();
      Animated.timing(motion.opacity, { ...animationOptions, toValue: 0, duration: 160 }).start(({ finished }) => {
        if (finished && session.current.id === id && !session.current.active) {
          session.current.id++;
          setRipple(null);
        }
      });
    }
    onPressOut?.(event);
  };

  return (
    <Pressable
      {...props}
      ref={(node) => {
        host.current = node;
        if (typeof ref === 'function') return ref(node);
        if (ref) ref.current = node;
      }}
      style={style}
      disabled={disabled}
      onPress={onPress}
      onPressIn={start}
      onPressOut={end}
    >
      {(state) => {
        const base = StyleSheet.flatten(typeof style === 'function' ? style(state) : style) ?? {};
        const color = processColor(base.backgroundColor);
        const palette = getFeedbackPalette(typeof color === 'number' ? color : null);
        // Copy only the clip shape; never clip the root's border/shadow/content.
        const shape: ViewStyle = {
          borderRadius: base.borderRadius,
          borderTopLeftRadius: base.borderTopLeftRadius,
          borderTopRightRadius: base.borderTopRightRadius,
          borderBottomLeftRadius: base.borderBottomLeftRadius,
          borderBottomRightRadius: base.borderBottomRightRadius,
          borderTopStartRadius: base.borderTopStartRadius,
          borderTopEndRadius: base.borderTopEndRadius,
          borderBottomStartRadius: base.borderBottomStartRadius,
          borderBottomEndRadius: base.borderBottomEndRadius,
          borderCurve: base.borderCurve,
        };
        return (
          <>
            {enabled ? (
              <View pointerEvents="none" accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.clip, shape]}>
                <Animated.View style={[StyleSheet.absoluteFillObject, {
                  backgroundColor: '#fff',
                  opacity: motion.wash.interpolate({ inputRange: [0, 1], outputRange: [0, palette.washOpacity] }),
                }]} />
                {ripple ? (
                  <Animated.View style={{
                    position: 'absolute',
                    left: ripple.x - ripple.radius, top: ripple.y - ripple.radius,
                    width: ripple.radius * 2, height: ripple.radius * 2,
                    borderRadius: ripple.radius, backgroundColor: palette.rippleColor,
                    opacity: motion.opacity, transform: [{ scale: motion.scale }],
                  }} />
                ) : null}
              </View>
            ) : null}
            {typeof children === 'function' ? children(state) : children}
          </>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  clip: { ...StyleSheet.absoluteFillObject, overflow: 'hidden' },
});
