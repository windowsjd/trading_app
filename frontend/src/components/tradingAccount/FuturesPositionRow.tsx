import React from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import type { FuturesHolding } from '../../features/futures/api';
import { getFuturesPositionDisplay } from '../../features/futures/positionDisplay';
import ActionPressable from '../common/ActionPressable';

type Props = { position: FuturesHolding; evaluatedAt: string; now: number; testID?: string; onPress?: () => void };
export default function FuturesPositionRow({ position, evaluatedAt, now, testID, onPress }: Props) {
  const display = getFuturesPositionDisplay(position, evaluatedAt, now);
  const { width, fontScale } = useWindowDimensions();
  const stacked = width / fontScale < 300;
  const content = <>
    <View style={[styles.columns, stacked && styles.stacked]}>
      <View style={styles.identity}>
        <View style={styles.heading}>
          <Text testID={`${testID}-direction`} style={[styles.direction, { color: position.direction === 'long' ? BUY_COLOR : SELL_COLOR }]}>{display.direction}</Text>
          <Text testID={`${testID}-name`} style={styles.name}>{display.name}</Text>
        </View>
        <Text testID={`${testID}-margin`} style={styles.muted}>{display.margin}</Text>
      </View>
      <View style={[styles.values, stacked && styles.stackedValues]}>
        <Text testID={`${testID}-notional`} accessibilityLabel={`포지션 규모 ${display.notional}`} style={styles.value}>{display.notional}</Text>
        <Text testID={`${testID}-performance`} accessibilityLabel={`미실현 손익 ${display.pnl}, ROI ${display.roi}`}
          style={[styles.performance, { color: display.pnlDirection === 'neutral' ? semantic.secondary : financial[display.pnlDirection] }]}>{display.performance}</Text>
      </View>
    </View>
    {display.notice ? <Text style={styles.notice}>{display.notice}</Text> : null}
  </>;
  return onPress ? <ActionPressable testID={testID} accessibilityRole="button" onPress={onPress} style={styles.row}>{content}</ActionPressable>
    : <View testID={testID} style={styles.row}>{content}</View>;
}
const styles = StyleSheet.create({
  row: { minWidth: 0, paddingVertical: 8, gap: 4 },
  columns: { minWidth: 0, flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  identity: { flex: 1, minWidth: 0, gap: 3 },
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: 5 },
  direction: { fontSize: 12, lineHeight: 18, fontWeight: '700', flexShrink: 1 },
  name: { minWidth: 0, maxWidth: '100%', flexShrink: 1, fontSize: 18, lineHeight: 27, fontWeight: '700' },
  muted: { fontSize: 12, lineHeight: 18, color: semantic.secondary },
  values: { minWidth: 0, maxWidth: '60%', flexShrink: 1, gap: 2 },
  value: { minWidth: 0, textAlign: 'right', fontSize: 18, lineHeight: 27, fontVariant: ['tabular-nums'] },
  performance: { minWidth: 0, textAlign: 'right', fontSize: 14, lineHeight: 21, fontVariant: ['tabular-nums'] },
  stacked: { flexDirection: 'column', alignItems: 'stretch', gap: 6 },
  stackedValues: { maxWidth: '100%', width: '100%' },
  notice: { fontSize: 12, lineHeight: 18, color: semantic.warning, textAlign: 'right' },
});
