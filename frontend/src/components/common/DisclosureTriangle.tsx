import React from 'react';
import { View } from '../../theme/native';
import { semantic } from '../../theme/tokens';

/** A font-independent triangle (10 × 7, or 14 × 9 when `large`); the parent
 * owns touch and accessibility. */
export default function DisclosureTriangle({ direction, color = semantic.secondary, testID, large = false }: {
  direction: 'up' | 'down';
  color?: string;
  testID?: string;
  large?: boolean;
}) {
  const half = large ? 7 : 5;
  const depth = large ? 9 : 7;
  return (
    <View testID={testID} accessible={false} pointerEvents="none" style={{
      width: 0, height: 0, flexShrink: 0,
      borderLeftWidth: half, borderRightWidth: half,
      borderLeftColor: 'transparent', borderRightColor: 'transparent',
      ...(direction === 'up'
        ? { borderBottomWidth: depth, borderBottomColor: color }
        : { borderTopWidth: depth, borderTopColor: color }),
    }} />
  );
}
