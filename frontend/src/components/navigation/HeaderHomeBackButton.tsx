import React from 'react';
import { HeaderBackButton } from '@react-navigation/elements';
import { useNavigation, type NavigationProp, type ParamListBase } from '@react-navigation/native';

/**
 * 퀘스트 and 가이드 are no longer tab roots (2026-11-07): Home's header opens
 * them, so their first screen gets a back button to Home. An active beginner
 * guide's navigation hold applies to this move like to any other.
 */
export default function HeaderHomeBackButton({ tintColor }: { tintColor?: string }) {
  const navigation = useNavigation<NavigationProp<ParamListBase>>();
  return (
    <HeaderBackButton testID="header-home-back" tintColor={tintColor} displayMode="minimal" accessibilityLabel="홈으로"
      onPress={() => navigation.navigate('HomeTab')} />
  );
}
