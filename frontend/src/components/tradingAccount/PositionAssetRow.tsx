import React from 'react';
import AdminDiagnosticPanel from '../states/AdminDiagnosticPanel';
import { View, Text, StyleSheet, useWindowDimensions, type StyleProp, type ViewStyle } from '../../theme/native';
import ActionPressable from '../common/ActionPressable';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import { getPositionAssetDisplay, type SpotHoldingDisplay } from '../../features/position/assetDisplay';
import AssetLogo from '../../features/market/AssetLogo';

type Props = { position: SpotHoldingDisplay; onPress?: () => void; testID?: string; style?: StyleProp<ViewStyle>; accessibilityHint?: string };

export default function PositionAssetRow({ position, onPress, testID, style, accessibilityHint }: Props) {
  const display = getPositionAssetDisplay(position);
  const { width, fontScale } = useWindowDimensions();
  const stacked = width / fontScale < 300;
  const content = <>
    <View style={[styles.columns, stacked && styles.stacked]}>
      {/* The market list's logo, beside the same name it shows. */}
      <View style={styles.leading}>
        <AssetLogo testID={testID ? `${testID}-logo` : undefined} assetType={position.assetType} market={position.market}
          symbol={position.symbol} name={display.name} />
        <View style={styles.identity}>
          <Text testID={testID ? `${testID}-name` : undefined} style={styles.name}>{display.name}</Text>
          {display.englishName ? (
            <Text testID={testID ? `${testID}-english-name` : undefined} style={styles.quantity}>{display.englishName}</Text>
          ) : null}
          <Text testID={testID ? `${testID}-quantity` : undefined} style={styles.quantity}>{display.quantity}</Text>
        </View>
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
      {onPress ? <ActionPressable testID={testID} style={[styles.row, style]} onPress={onPress} accessibilityRole="button" accessibilityHint={accessibilityHint}>{content}</ActionPressable>
        : <View testID={testID} style={[styles.row, style]}>{content}</View>}
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
  leading: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
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
