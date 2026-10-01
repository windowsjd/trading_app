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
      <Text style={styles.name}>{display.name}</Text>
      <View style={styles.values}>
        <Text testID={testID ? `${testID}-value` : undefined} style={styles.value}>{display.value}</Text>
        <Text
          testID={testID ? `${testID}-return` : undefined}
          accessibilityLabel={`매입가 대비 미실현 수익률 ${display.returnRate}`}
          style={[styles.returnRate, directionStyles[display.direction]]}
        >
          {display.returnRate}
        </Text>
      </View>
      {display.notice ? <Text style={styles.notice}>{display.notice}</Text> : null}
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
  name: { minWidth: 0, fontSize: 14, lineHeight: 21, fontWeight: '600' },
  // Separate lines for identity and money; wrap the rate onto its own line
  // when a large balance or accessibility font size needs the full width.
  values: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 12, rowGap: 4 },
  value: { minWidth: 0, flexShrink: 1, fontSize: 16, lineHeight: 24, fontVariant: ['tabular-nums'] },
  returnRate: { fontSize: 13, lineHeight: 21, fontVariant: ['tabular-nums'] },
  notice: { fontSize: 12, lineHeight: 18, color: semantic.warning },
});
