import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  processColor,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type PressableProps,
  type PressableStateCallbackType,
  type ViewStyle,
} from 'react-native';
import {
  getFeedbackPalette,
  getRippleGeometry,
  PRESS_IN_DURATION_MS,
  PRESS_IN_SCALE,
  PRESS_OUT_DURATION_MS,
  RIPPLE_EXPAND_DURATION_MS,
  RIPPLE_FADE_DURATION_MS,
  WASH_FADE_DURATION_MS,
} from './pressFeedback';

type Props = Omit<PressableProps, 'android_ripple'> & { ref?: React.Ref<View> };
type Ripple = ReturnType<typeof getRippleGeometry> & { id: number };

const animationOptions = {
  useNativeDriver: Platform.OS !== 'web',
  isInteraction: false,
  easing: Easing.out(Easing.quad),
};

/** One local interaction; the original Pressable still owns layout and actions. */
export default function ActionPressable({
  children,
  style,
  disabled,
  onPress,
  onPressIn,
  onPressOut,
  ref,
  ...props
}: Props) {
  const host = useRef<View>(null);
  const session = useRef({ id: 0, active: false, expanded: false });
  const [ripple, setRipple] = useState<Ripple | null>(null);
  const [pressScale, setPressScale] = useState(1);
  const [motion] = useState(() => ({
    rippleScale: new Animated.Value(0.02),
    opacity: new Animated.Value(0),
    wash: new Animated.Value(0),
    pressScale: new Animated.Value(1),
  }));
  const enabled =
    !disabled &&
    !props['aria-disabled'] &&
    !props.accessibilityState?.disabled &&
    !!onPress;

  useEffect(() => {
    // Keep the root a regular Pressable: Animated's web wrapper turns a style
    // callback into an array, so Pressable never evaluates its visual styles.
    // Only this pressed button renders scale frames; parents/sibling rows don't.
    const listener = motion.pressScale.addListener(({ value }) => setPressScale(value));
    return () => motion.pressScale.removeListener(listener);
  }, [motion]);

  const finishRipple = useCallback(
    (id: number) => {
      Animated.timing(motion.opacity, {
        ...animationOptions,
        toValue: 0,
        duration: RIPPLE_FADE_DURATION_MS,
      }).start(({ finished }) => {
        if (
          finished &&
          session.current.id === id &&
          !session.current.active
        ) {
          session.current = {
            id: id + 1,
            active: false,
            expanded: false,
          };
          setRipple(null);
        }
      });
    },
    [motion],
  );

  useEffect(() => {
    // Also cancels a late measure callback when disabled or unmounted.
    if (!enabled) setRipple(null);
    return () => {
      session.current = {
        id: session.current.id + 1,
        active: false,
        expanded: false,
      };
      motion.rippleScale.stopAnimation();
      motion.opacity.stopAnimation();
      motion.wash.stopAnimation();
      motion.pressScale.stopAnimation();
      motion.opacity.setValue(0);
      motion.wash.setValue(0);
      motion.pressScale.setValue(1);
    };
  }, [enabled, motion]);

  const animatedStyle = (state: PressableStateCallbackType) => {
    const resolved = typeof style === 'function' ? style(state) : style;
    const base = StyleSheet.flatten(resolved) ?? {};
    const scale = enabled ? pressScale : 1;
    const composedTransform: ViewStyle['transform'] =
      typeof base.transform === 'string'
        ? `${base.transform} scale(${scale})`
        : [...(base.transform ?? []), { scale }];

    return [
      resolved,
      {
        // The animated transform is visual only. Reapply any caller transforms
        // before it so scale never overwrites an existing translation/rotation.
        transform: composedTransform,
      },
    ];
  };

  const start = (event: GestureResponderEvent) => {
    if (enabled) {
      const id = ++session.current.id;
      session.current.active = true;
      session.current.expanded = false;
      const { pageX, pageY } = event.nativeEvent;
      // Keep an existing circle mounted until measure supplies the new origin.
      // Detaching its Animated.View can stop the shared values just started by
      // a rapid second tap, leaving that new ripple stuck at its initial size.
      motion.rippleScale.stopAnimation();
      motion.rippleScale.setValue(0.02);
      motion.opacity.setValue(1);
      motion.wash.setValue(1);
      Animated.timing(motion.pressScale, {
        ...animationOptions,
        useNativeDriver: false,
        toValue: PRESS_IN_SCALE,
        duration: PRESS_IN_DURATION_MS,
      }).start();
      // Start the lifecycle at touch-down rather than after async measurement.
      // A quick tap therefore gets the full expansion, and a measure callback
      // arriving after this session finishes cannot resurrect it.
      Animated.timing(motion.rippleScale, {
        ...animationOptions,
        toValue: 1,
        duration: RIPPLE_EXPAND_DURATION_MS,
      }).start(({ finished }) => {
        if (!finished || session.current.id !== id) return;
        session.current.expanded = true;
        if (!session.current.active) finishRipple(id);
      });
      // Measure the actual root on every press, including after list/page scroll.
      // This only positions the visual; onPress never waits for measurement.
      host.current?.measure((_x, _y, width, height, rootX, rootY) => {
        // A quick release may precede measure. Its ripple still completes one
        // expansion before fading, but never revives an obsolete session.
        if (session.current.id !== id || width <= 0 || height <= 0) return;
        setRipple({
          ...getRippleGeometry(pageX, pageY, {
            pageX: rootX,
            pageY: rootY,
            width,
            height,
          }),
          id,
        });
      });
    }
    onPressIn?.(event);
  };

  const end = (event: GestureResponderEvent) => {
    session.current.active = false;
    const id = session.current.id;
    if (enabled) {
      Animated.timing(motion.pressScale, {
        ...animationOptions,
        useNativeDriver: false,
        toValue: 1,
        duration: PRESS_OUT_DURATION_MS,
      }).start();
      Animated.timing(motion.wash, {
        ...animationOptions,
        toValue: 0,
        duration: WASH_FADE_DURATION_MS,
      }).start();
      if (session.current.expanded) finishRipple(id);
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
      style={animatedStyle}
      disabled={disabled}
      onPress={onPress}
      onPressIn={start}
      onPressOut={end}
    >
      {(state) => {
        const base =
          StyleSheet.flatten(
            typeof style === 'function' ? style(state) : style,
          ) ?? {};
        const color = processColor(base.backgroundColor);
        const palette = getFeedbackPalette(
          typeof color === 'number' ? color : null,
        );
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
              <View
                pointerEvents="none"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[styles.clip, shape]}
              >
                <Animated.View
                  style={[
                    StyleSheet.absoluteFillObject,
                    {
                      backgroundColor: '#fff',
                      opacity: motion.wash.interpolate({
                        inputRange: [0, 1],
                        outputRange: [0, palette.washOpacity],
                      }),
                    },
                  ]}
                />
                {ripple ? (
                  <Animated.View
                    style={{
                      position: 'absolute',
                      left: ripple.x - ripple.radius,
                      top: ripple.y - ripple.radius,
                      width: ripple.radius * 2,
                      height: ripple.radius * 2,
                      borderRadius: ripple.radius,
                      backgroundColor: palette.rippleColor,
                      opacity: motion.opacity,
                      transform: [{ scale: motion.rippleScale }],
                    }}
                  />
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
