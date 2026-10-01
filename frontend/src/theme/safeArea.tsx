import React from 'react';
import { SafeAreaView as NativeSafeAreaView, type SafeAreaViewProps } from 'react-native-safe-area-context';
import { useAppearance } from './appearance';
import { resolveSemanticStyle } from './tokens';

export * from 'react-native-safe-area-context';

export function SafeAreaView(props: SafeAreaViewProps) {
  const { colors, mode, financialPreference } = useAppearance();
  return <NativeSafeAreaView {...props} style={resolveSemanticStyle(props.style, colors, mode, financialPreference)} />;
}
