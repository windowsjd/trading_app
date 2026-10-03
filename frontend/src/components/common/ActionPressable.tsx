import React from 'react';
import { resolveSemanticColor } from '../../theme/tokens';
import { useAppearance } from '../../theme/appearance';
import {
  Pressable,
  processColor,
  StyleSheet,
  View,
  type PressableProps,
  type ViewStyle,
} from '../../theme/native';
import { getFeedbackPalette } from './pressFeedback';

type Props = Omit<PressableProps, 'android_ripple'> & { ref?: React.Ref<View> };

/** One immediate pressed surface; no motion clock or delayed action. */
export default function ActionPressable({ feedback = 'default', ...props }: Props & {
  /** Reserved for the compact Market sort directions. */
  feedback?: 'default' | 'none';
}) {
  return feedback === 'none' ? <Pressable {...props} /> : <FeedbackActionPressable {...props} />;
}

function FeedbackActionPressable({ children, style, disabled, onPress, ...props }: Props) {
  const { colors, mode, financialPreference } = useAppearance();
  const enabled =
    !disabled &&
    !props['aria-disabled'] &&
    !props.accessibilityState?.disabled &&
    !!onPress;

  return (
    <Pressable {...props} style={style} disabled={disabled} onPress={onPress}>
      {(state) => {
        const base = StyleSheet.flatten(typeof style === 'function' ? style(state) : style) ?? {};
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
            {enabled ? (
              <View
                pointerEvents="none"
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                style={[
                  styles.clip,
                  shape,
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
  clip: { ...StyleSheet.absoluteFillObject, overflow: 'hidden' },
});
