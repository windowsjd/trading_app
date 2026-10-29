import React from 'react';
import { Text, View } from '../../theme/native';
import { primaryGradient } from '../../theme/tokens';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import type { Direction } from '../../features/futures/api';

/**
 * A futures position's side wherever a position is summarized (the futures
 * screen's cards and sheets, Home, Wallet, a friend's season): a small filled
 * box, L for long and S for short, in the buy / sell color. Screen readers
 * hear the side itself, never the letter.
 */
export default function FuturesDirectionBadge({ direction, testID }: { direction: Direction; testID?: string }) {
  const long = direction === 'long';
  return (
    <View testID={testID} accessible accessibilityLabel={long ? '롱(Long)' : '숏(Short)'}
      style={[styles.box, { backgroundColor: long ? BUY_COLOR : SELL_COLOR }]}>
      <Text style={styles.letter}>{long ? 'L' : 'S'}</Text>
    </View>
  );
}

// Plain objects: holding rows load with minimal native mocks. The box grows
// with the letter at large font sizes instead of clipping it.
const styles = {
  box: { minWidth: 20, minHeight: 20, paddingHorizontal: 4, borderRadius: 4, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  letter: { fontSize: 12, lineHeight: 16, fontWeight: '800', color: primaryGradient.foreground, textAlign: 'center' },
} as const;
