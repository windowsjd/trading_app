import React from 'react';
import {
  Pressable,
  Text,
  ActivityIndicator,
  StyleSheet,
  ViewStyle,
} from 'react-native';

type CTAState = 'enabled' | 'disabled' | 'loading' | 'blocked';

interface CTAButtonProps {
  label: string;
  state?: CTAState;
  onPress?: () => void;
  style?: ViewStyle;
  testID?: string;
}

export default function CTAButton({
  label,
  state = 'enabled',
  onPress,
  style,
  testID,
}: CTAButtonProps) {
  const disabled = state === 'disabled' || state === 'loading' || state === 'blocked';

  return (
    <Pressable
      testID={testID}
      style={[
        styles.button,
        state === 'blocked' && styles.blocked,
        state === 'disabled' && styles.disabled,
        style,
      ]}
      onPress={onPress}
      disabled={disabled}
    >
      {state === 'loading' ? (
        <ActivityIndicator color="#fff" />
      ) : (
        <Text style={styles.text}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#111',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  disabled: {
    opacity: 0.45,
  },
  blocked: {
    opacity: 0.45,
  },
  text: {
    color: '#fff',
    fontWeight: '700',
  },
});