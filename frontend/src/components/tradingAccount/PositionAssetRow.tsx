import React from 'react';
import AdminDiagnosticPanel from '../states/AdminDiagnosticPanel';
import { View, Text, StyleSheet, useWindowDimensions } from '../../theme/native';
import ActionPressable from '../common/ActionPressable';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import { getPositionAssetDisplay, type SpotHoldingDisplay } from '../../features/position/assetDisplay';

type Props = { position: SpotHoldingDisplay; onPress?: () => void; testID?: string };

export default function PositionAssetRow({ position, onPress, testID }: Props) {
  const display = getPositionAssetDisplay(position);
  const { width, fontScale } = useWindowDimensions();
  const stacked = width / fontScale < 300;
  const content = <>
    <View style={[styles.columns, stacked && styles.stacked]}>
      <View style={styles.identity}>
        <Text testID={testID ? `${testID}-name` : undefined} style={styles.name}>{display.name}</Text>
        <Text testID={testID ? `${testID}-quantity` : undefined} style={styles.quantity}>{display.quantity}</Text>
      </View>
      <View testID={testID ? `${testID}-values` : undefined} style={[styles.values, stacked && styles.stackedValues]}>
        <Text testID={testID ? `${testID}-value` : undefined} style={styles.value}>{display.value}</Text>
        <Text testID={testID ? `${testID}-return` : undefined}
          accessibilityLabel={`평가손익 ${display.pnl}, 수익률 ${display.returnRate}`}
          style={[styles.returnRate, directionStyles[display.direction]]}>{display.performance}</Text>
      </View>
    </View>
    {display.notice ? <Text testID={testID ? `${testID}-notice` : undefined} style={styles.notice}>{display.notice}</Text> : null}
  </>;
  return (
    <>
      {onPress ? <ActionPressable testID={testID} style={styles.row} onPress={onPress} accessibilityRole="button">{content}</ActionPressable>
        : <View testID={testID} style={styles.row}>{content}</View>}
      {position.valuation.state === 'stale_cache' && position.valuation.diagnostic ? <AdminDiagnosticPanel diagnostic={position.valuation.diagnostic} /> : null}
    </>
  );
}

const directionStyles = StyleSheet.create({
  rise: { color: financial.rise },
  fall: { color: financial.fall },
  neutral: { color: semantic.secondary },
});
const styles = StyleSheet.create({
  row: { minWidth: 0, paddingVertical: 6, gap: 4 },
  columns: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, minWidth: 0 },
  identity: { flex: 1, minWidth: 0, gap: 2 },
  name: { minWidth: 0, fontSize: 18, lineHeight: 27, fontWeight: '700' },
  quantity: { minWidth: 0, fontSize: 12, lineHeight: 18, color: semantic.secondary },
  // Wrap full financial values, then stack the columns at large font scales.
  values: { minWidth: 0, maxWidth: '60%', flexShrink: 1, alignItems: 'stretch', gap: 2 },
  stacked: { flexDirection: 'column', alignItems: 'stretch', gap: 6 },
  stackedValues: { maxWidth: '100%', width: '100%' },
  value: { minWidth: 0, textAlign: 'right', fontSize: 18, lineHeight: 27, fontWeight: '500', fontVariant: ['tabular-nums'] },
  returnRate: { minWidth: 0, textAlign: 'right', fontSize: 14, lineHeight: 21, fontVariant: ['tabular-nums'] },
  notice: { fontSize: 12, lineHeight: 18, color: semantic.warning, textAlign: 'right' },
});
