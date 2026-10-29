import React from 'react';
import { Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import type { FuturesPosition } from '../../features/futures/api';
import { formatAssetPrice, getAssetNameDisplay } from '../../utils/format';
import FuturesDirectionBadge from './FuturesDirectionBadge';

/**
 * The top of a futures position's bottom sheets (포지션 종료, 손절가/익절가),
 * laid out like an exchange's close sheet: the contract with 무기한, its side
 * and margin mode with leverage, then 진입가 and Mark Price as label–value
 * rows over a divider. Mark shows only while it is fresh, as on the card.
 */
export default function FuturesPositionSheetSummary({ position, markFresh, testID = 'futures-sheet-summary' }: {
  position: FuturesPosition;
  markFresh: boolean;
  testID?: string;
}) {
  const decimals = position.instrument.underlying.displayPriceDecimals;
  const price = (value: string | null) => value == null ? '-' : formatAssetPrice(value, 'USD', decimals);
  return (
    <View testID={testID} style={styles.summary}>
      <View style={styles.row}>
        <Text style={styles.label}>종목</Text>
        <View style={styles.contract}>
          <Text testID={`${testID}-name`} style={styles.name}>{getAssetNameDisplay(position.instrument.underlying).primary}</Text>
          <Text style={styles.chip}>무기한</Text>
          <FuturesDirectionBadge testID={`${testID}-direction`} direction={position.direction} />
          <Text style={styles.chip}>{position.marginMode === 'cross' ? '교차' : '격리'} {position.leverage}x</Text>
        </View>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>진입가 (USD)</Text>
        <Text testID={`${testID}-entry`} selectable style={styles.value}>{price(position.averageEntryPrice)}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>Mark Price (USD)</Text>
        <Text testID={`${testID}-mark`} selectable style={styles.value}>{markFresh ? price(position.markPrice) : '-'}</Text>
      </View>
      <View style={styles.divider} />
    </View>
  );
}

// Plain objects: sheets load with minimal native mocks. Rows wrap (the value
// under its label) at narrow widths and large fonts, and a value too long for
// one line (minWidth 0) breaks inside it instead of running past the sheet.
const styles = {
  summary: { gap: 8, minWidth: 0 },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', columnGap: 12, rowGap: 2, minWidth: 0 },
  label: { flexShrink: 1, fontSize: 13, lineHeight: 20, color: semantic.secondary },
  value: { flexShrink: 1, minWidth: 0, marginLeft: 'auto', fontSize: 14, lineHeight: 21, fontWeight: '600', color: semantic.text, textAlign: 'right', fontVariant: ['tabular-nums'] as 'tabular-nums'[] },
  contract: { flexShrink: 1, marginLeft: 'auto', minWidth: 0, flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center', columnGap: 6, rowGap: 4 },
  name: { flexShrink: 1, minWidth: 0, fontSize: 15, lineHeight: 22, fontWeight: '700', color: semantic.text },
  chip: { fontSize: 11, lineHeight: 15, fontWeight: '600', color: semantic.secondary, paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5, backgroundColor: semantic.raised, overflow: 'hidden' },
  divider: { height: 1, marginTop: 4, backgroundColor: semantic.border },
} as const;
