import React from 'react';
import { primaryGradient, resolveSemanticColor } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import {
  Pressable,
  processColor,
  StyleSheet,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from '../../theme/native';
import { getFeedbackPalette } from './pressFeedback';
import PrimaryButtonBackground from './PrimaryButtonBackground';

type Props = Omit<PressableProps, 'android_ripple'> & {
  ref?: React.Ref<View>;
  /** Opt in only for general primary actions; disabled surfaces stay unchanged. */
  primary?: boolean;
  /** Place the decorative wash on a smaller surface inside the hit target. */
  feedbackStyle?: StyleProp<ViewStyle>;
};

/** One immediate pressed surface; no motion clock or delayed action. */
export default function ActionPressable({ feedback = 'default', primary = false, ...props }: Props & {
  /** Reserved for the compact Market sort directions. */
  feedback?: 'default' | 'none';
}) {
  return feedback === 'none' ? <Pressable {...props} /> : <FeedbackActionPressable {...props} primary={primary} />;
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
  primary: { backgroundColor: primaryGradient.colors[0] },
  clip: { ...StyleSheet.absoluteFillObject, overflow: 'hidden' },
  target: { position: 'absolute', overflow: 'hidden' },
});
