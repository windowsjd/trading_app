import React from 'react';
import { View } from '../../theme/native';
import { semantic } from '../../theme/tokens';

/** A font-independent 10 × 7 triangle; the parent owns touch and accessibility. */
export default function DisclosureTriangle({ direction, color = semantic.secondary, testID }: {
  direction: 'up' | 'down';
  color?: string;
  testID?: string;
}) {
  return (
    <View testID={testID} accessible={false} pointerEvents="none" style={{
      width: 0, height: 0, flexShrink: 0,
      borderLeftWidth: 5, borderRightWidth: 5,
      borderLeftColor: 'transparent', borderRightColor: 'transparent',
      ...(direction === 'up'
        ? { borderBottomWidth: 7, borderBottomColor: color }
        : { borderTopWidth: 7, borderTopColor: color }),
    }} />
  );
}
