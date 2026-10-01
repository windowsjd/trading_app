import React from 'react';
import { View, Text, StyleSheet } from '../../theme/native';
import ActionPressable from '../common/ActionPressable';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import type { PositionItemDto } from '../../features/position/api';
import { getPositionAssetDisplay } from '../../features/position/assetDisplay';

type Props = { position: PositionItemDto; onPress: () => void; testID?: string };

export default function PositionAssetRow({ position, onPress, testID }: Props) {
  const display = getPositionAssetDisplay(position);
  return (
    <ActionPressable testID={testID} style={styles.row} onPress={onPress} accessibilityRole="button">
      <View style={styles.columns}>
        <Text
          testID={testID ? `${testID}-name` : undefined}
          accessibilityLabel={display.name}
          numberOfLines={3}
          ellipsizeMode="tail"
          style={styles.name}
        >
          {display.name}
        </Text>
        <View testID={testID ? `${testID}-values` : undefined} style={styles.values}>
          <Text testID={testID ? `${testID}-value` : undefined} style={styles.value}>{display.value}</Text>
          <Text testID={testID ? `${testID}-quantity` : undefined} style={styles.quantity}>{display.quantity}</Text>
          <Text
            testID={testID ? `${testID}-return` : undefined}
            accessibilityLabel={`매입가 대비 미실현 수익률 ${display.returnRate}`}
            style={[styles.returnRate, directionStyles[display.direction]]}
          >
            {display.returnRate}
          </Text>
        </View>
      </View>
      {display.notice ? <Text testID={testID ? `${testID}-notice` : undefined} style={styles.notice}>{display.notice}</Text> : null}
    </ActionPressable>
  );
}

const directionStyles = StyleSheet.create({
  rise: { color: financial.rise },
  fall: { color: financial.fall },
  neutral: { color: semantic.secondary },
});
const styles = StyleSheet.create({
  row: { minWidth: 0, paddingVertical: 12, gap: 4 },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, minWidth: 0 },
  name: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 24, fontWeight: '600' },
  // Preserve both columns at large font scales. Full values can wrap inside
  // the right track, without truncation or shrinking accessibility text.
  values: { minWidth: 0, maxWidth: '70%', flexShrink: 1, alignItems: 'stretch', gap: 2 },
  value: { minWidth: 0, textAlign: 'right', fontSize: 18, lineHeight: 27, fontWeight: '500', fontVariant: ['tabular-nums'] },
  quantity: { minWidth: 0, textAlign: 'right', fontSize: 12, lineHeight: 18, fontWeight: '400', color: semantic.secondary, fontVariant: ['tabular-nums'] },
  returnRate: { minWidth: 0, textAlign: 'right', fontSize: 14, lineHeight: 21, fontVariant: ['tabular-nums'] },
  notice: { fontSize: 12, lineHeight: 18, color: semantic.warning, textAlign: 'right' },
});
