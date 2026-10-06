import React, { useEffect, useRef } from 'react';
import { primaryGradient, resolveSemanticColor, resolveSemanticStyle, type ActionGradient } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import { useReducedMotion } from '../../theme/useReducedMotion';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  processColor,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from '../../theme/native';
import { buttonFeedback, getFeedbackPalette, splitButtonStyle } from './pressFeedback';
import PrimaryButtonBackground from './PrimaryButtonBackground';

type Props = Omit<PressableProps, 'android_ripple'> & {
  ref?: React.Ref<View>;
  /** Opt in only for general primary actions; disabled surfaces stay unchanged. */
  primary?: boolean;
  gradient?: ActionGradient;
  /** Place the decorative wash on a smaller surface inside the hit target. */
  feedbackStyle?: StyleProp<ViewStyle>;
};

/** Button motion is opt-in; rows/cards keep their static feedback. */
export default function ActionPressable({ feedback, primary = false, gradient, ...props }: Props & {
  /** `none` is reserved for Market sort; `button` requires a visual surface. */
  feedback?: 'default' | 'button' | 'none';
}) {
  if (feedback === 'none') return <Pressable {...props} />;
  if (feedback === 'button' || (feedback === undefined && primary)) {
    return <ButtonActionPressable {...props} gradient={gradient ?? (primary ? primaryGradient : undefined)} />;
  }
  return <FeedbackActionPressable {...props} primary={primary} />;
}

function ButtonActionPressable({ children, style, disabled, onPress, gradient, ...props }: Props) {
  const { colors, mode, financialPreference } = useAppearance();
  const blocked = !!disabled || !!props['aria-disabled'] || !!props.accessibilityState?.disabled;
  const visualStyle = (state: { pressed: boolean }) => StyleSheet.flatten(resolveSemanticStyle(
    [typeof style === 'function' ? style(state) : style, gradient && !blocked && { backgroundColor: gradient.colors[0] }],
    colors, mode, financialPreference,
  )) ?? {};
  return (
    <Pressable {...props} disabled={blocked} onPress={onPress}
      style={(state) => splitButtonStyle(visualStyle(state)).target}>
      {(state) => <ButtonSurface pressed={state.pressed} enabled={!blocked && !!onPress}
        style={splitButtonStyle(visualStyle(state)).surface} gradient={blocked ? undefined : gradient}>
        {typeof children === 'function' ? children(state) : children}
      </ButtonSurface>}
    </Pressable>
  );
}

function ButtonSurface({ children, pressed, enabled, style, gradient }: {
  children: React.ReactNode; pressed: boolean; enabled: boolean; style: ViewStyle; gradient?: ActionGradient;
}) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced || !enabled) { progress.setValue(0); return; }
    const animation = Animated.timing(progress, {
      toValue: pressed ? 1 : 0,
      duration: pressed ? buttonFeedback.pressDuration : buttonFeedback.releaseDuration,
      easing: Easing.out(Easing.quad),
      useNativeDriver: Platform.OS !== 'web',
      isInteraction: false,
    });
    animation.start();
    return () => animation.stop();
  }, [enabled, pressed, progress, reduced]);
  const shape = clipShape(style);
  return (
    <Animated.View pointerEvents="none" style={[styles.buttonSurface, style, {
      transform: [{ scale: reduced || !enabled ? 1 : progress.interpolate({ inputRange: [0, 1], outputRange: [1, buttonFeedback.scale], extrapolate: 'clamp' }) }],
    }]}>
      {gradient ? <PrimaryButtonBackground shape={shape} gradient={gradient} /> : null}
      {enabled ? <Animated.View pointerEvents="none" accessible={false} accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants" style={[styles.clip, shape, {
          backgroundColor: buttonFeedback.washColor,
          opacity: reduced ? (pressed ? buttonFeedback.washOpacity : 0)
            : progress.interpolate({ inputRange: [0, 1], outputRange: [0, buttonFeedback.washOpacity], extrapolate: 'clamp' }),
        }]} /> : null}
      {children}
    </Animated.View>
  );
}

function clipShape(base: ViewStyle): ViewStyle {
  return {
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
}

function FeedbackActionPressable({ children, style, disabled, onPress, primary = false, feedbackStyle, ...props }: Props) {
  const { colors, mode, financialPreference } = useAppearance();
  const showPrimary = primary && !disabled && !props['aria-disabled'] && !props.accessibilityState?.disabled;
  const surfaceStyle: PressableProps['style'] = showPrimary
    ? typeof style === 'function'
      ? (state: Parameters<typeof style>[0]) => [style(state), styles.primary]
      : [style, styles.primary]
    : style;
  const enabled =
    !disabled &&
    !props['aria-disabled'] &&
    !props.accessibilityState?.disabled &&
    !!onPress;

  return (
    <Pressable {...props} style={surfaceStyle} disabled={disabled} onPress={onPress}>
      {(state) => {
        const base = StyleSheet.flatten(feedbackStyle ?? (typeof surfaceStyle === 'function' ? surfaceStyle(state) : surfaceStyle)) ?? {};
        const color = processColor(resolveSemanticColor(base.backgroundColor, colors, mode, financialPreference) ?? colors.screen);
        const palette = getFeedbackPalette(typeof color === 'number' ? color : null);
        // Copy only the clip shape; never clip the root's border/shadow/content.
        const shape = clipShape(base);
        return (
          <>
            {showPrimary ? <PrimaryButtonBackground shape={shape} /> : null}
            {enabled ? (
              <View
                pointerEvents="none"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                  feedbackStyle ? styles.target : styles.clip,
                  shape,
                  feedbackStyle,
                  {
                    backgroundColor: palette.washColor,
                    // Static feedback also respects Reduced Motion, including
                    // before the OS preference resolves. Pressable owns cancel,
                    // release, keyboard input and accessibility activation.
                    opacity: state.pressed ? palette.washOpacity : 0,
                  },
                ]}
              />
            ) : null}
            {typeof children === 'function' ? children(state) : children}
          </>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  buttonSurface: { alignSelf: 'stretch', flexGrow: 1 },
  primary: { backgroundColor: primaryGradient.colors[0] },
  clip: { ...StyleSheet.absoluteFillObject, overflow: 'hidden' },
  target: { position: 'absolute', overflow: 'hidden' },
});
