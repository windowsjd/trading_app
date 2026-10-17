import { logoutGradient, primaryGradient, semantic } from '../../theme/tokens';
import React from 'react';
import {
  Text,
  StyleSheet,
  View,
  ViewStyle,
} from '../../theme/native';
import ActionPressable from './ActionPressable';
import WhaleLoader from '../states/WhaleLoader';
import type { RippleTone } from './pressFeedback';
import LearningLock from '../../features/quest/LearningLock';

type CTAState = 'enabled' | 'disabled' | 'loading' | 'blocked';

interface CTAButtonProps {
  label: string;
  /** Only server-confirmed learning restrictions; operational disabled remains separate. */
  learningHint?: string | null;
  leadingIcon?: React.ReactNode;
  state?: CTAState;
  onPress?: () => void;
  style?: ViewStyle;
  testID?: string;
  /** History entry uses secondary; back and recovery actions keep neutral. */
  variant?: 'primary' | 'secondary' | 'neutral' | 'logout';
  /** Trade-executing commands pass `subtle`. */
  ripple?: RippleTone;
  /** What pressing does, read after the label (e.g. the expected order total). */
  accessibilityHint?: string;
}

export default function CTAButton({
  label,
  learningHint,
  leadingIcon,
  state = 'enabled',
  onPress,
  style,
  testID,
  variant = 'primary',
  ripple,
  accessibilityHint,
}: CTAButtonProps) {
  const disabled = state === 'disabled' || state === 'loading' || state === 'blocked';

  return (
    <ActionPressable
      feedback="button"
      primary={!learningHint && variant === 'primary' && style?.backgroundColor === undefined}
      gradient={variant === 'logout' ? logoutGradient : undefined}
      ripple={ripple}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={learningHint ? `${label}, 학습 제한. ${learningHint}` : label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || !!learningHint, busy: state === 'loading' }}
      style={[
        styles.button,
        variant === 'logout' && styles.logout,
        variant === 'secondary' && styles.secondary,
        state === 'blocked' && styles.blocked,
        state === 'disabled' && styles.disabled,
        style,
        learningHint && styles.learning,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      {state === 'loading' ? (
        // Same line height as the label, so the button keeps its size.
        <View style={styles.loading}>
          <WhaleLoader size={21} tone={variant === 'secondary' ? 'brand' : 'onAction'} accessibilityLabel={`${label} 처리 중`} />
        </View>
      ) : leadingIcon || learningHint ? (
        <View style={styles.labelGroup}>
          <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.icon}>{leadingIcon}</View>
          {learningHint ? <LearningLock /> : null}
          <Text style={[styles.text, styles.iconLabel, variant === 'secondary' && styles.secondaryText, !!learningHint && styles.learningText]}>{label}</Text>
        </View>
      ) : (
        <Text style={variant === 'secondary' ? [styles.text, styles.secondaryText] : styles.text}>{label}</Text>
      )}
    </ActionPressable>
  );
}

const styles = StyleSheet.create({
  learning: { backgroundColor: semantic.raised, borderWidth: 1, borderColor: semantic.border },
  learningText: { color: semantic.secondary },
  labelGroup: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, maxWidth: '100%' },
  icon: { flexShrink: 0 },
  loading: { minHeight: 21, alignItems: 'center', justifyContent: 'center' },
  iconLabel: { flexShrink: 1 },
  button: {
    backgroundColor: semantic.selected,
    borderRadius: 12,
    paddingVertical: 14,
    // Horizontal padding so a long Korean label does not run to the edges, and
    // no numberOfLines so it wraps instead of being cut (작업 10 §B-8).
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.45,
  },
  logout: { backgroundColor: logoutGradient.colors[0] },
  secondary: { backgroundColor: semantic.secondaryActionSurface },
  secondaryText: { color: semantic.secondaryActionForeground },
  blocked: {
    opacity: 0.45,
  },
  text: {
    color: primaryGradient.foreground,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 21,
  },
});
