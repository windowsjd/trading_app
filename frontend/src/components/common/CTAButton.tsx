import { logoutGradient, primaryGradient, semantic } from '../../theme/tokens';
import React from 'react';
import {
  Text,
  ActivityIndicator,
  StyleSheet,
  View,
  ViewStyle,
} from '../../theme/native';
import ActionPressable from './ActionPressable';

type CTAState = 'enabled' | 'disabled' | 'loading' | 'blocked';

interface CTAButtonProps {
  label: string;
  leadingIcon?: React.ReactNode;
  state?: CTAState;
  onPress?: () => void;
  style?: ViewStyle;
  testID?: string;
  /** History entry uses secondary; back and recovery actions keep neutral. */
  variant?: 'primary' | 'secondary' | 'neutral' | 'logout';
}

export default function CTAButton({
  label,
  leadingIcon,
  state = 'enabled',
  onPress,
  style,
  testID,
  variant = 'primary',
}: CTAButtonProps) {
  const disabled = state === 'disabled' || state === 'loading' || state === 'blocked';

  return (
    <ActionPressable
      feedback="button"
      primary={variant === 'primary' && style?.backgroundColor === undefined}
      gradient={variant === 'logout' ? logoutGradient : undefined}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: state === 'loading' }}
      style={[
        styles.button,
        variant === 'logout' && styles.logout,
        variant === 'secondary' && styles.secondary,
        state === 'blocked' && styles.blocked,
        state === 'disabled' && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      {state === 'loading' ? (
        <ActivityIndicator color={variant === 'secondary' ? semantic.secondaryActionForeground : primaryGradient.foreground} />
      ) : leadingIcon ? (
        <View style={styles.labelGroup}>
          <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.icon}>{leadingIcon}</View>
          <Text style={[styles.text, styles.iconLabel, variant === 'secondary' && styles.secondaryText]}>{label}</Text>
        </View>
      ) : (
        <Text style={variant === 'secondary' ? [styles.text, styles.secondaryText] : styles.text}>{label}</Text>
      )}
    </ActionPressable>
  );
}

const styles = StyleSheet.create({
  labelGroup: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, maxWidth: '100%' },
  icon: { flexShrink: 0 },
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
