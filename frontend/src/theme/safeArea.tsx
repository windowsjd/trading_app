import React from 'react';
import { SafeAreaView as NativeSafeAreaView, type SafeAreaViewProps } from 'react-native-safe-area-context';
import { useAppearance } from './appearance';
import { themeStyle } from './colorStyles';

export * from 'react-native-safe-area-context';

export function SafeAreaView(props: SafeAreaViewProps) {
  const { mode } = useAppearance();
  return <NativeSafeAreaView {...props} style={themeStyle(props.style, mode)} />;
}
