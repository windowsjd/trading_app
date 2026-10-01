import { semantic } from '../../theme/tokens';
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';

import { TEST_IDS } from '../../constants/testIds';
import {
  getAssetNameDisplay,
  getAssetPriceText,
  getAssetSymbolMarketDisplay,
} from '../../utils/format';
import type { AssetTickerMessage } from '../asset/assetTickerPolicy';
import { getMarketChangeDisplay, getMarketException } from './marketPresentation';
import type { AssetPriceErrorDto, MarketAssetItemDto } from './api';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import { mergeMarketAssetTicker } from './mergeMarketAssetTicker';

type Props = {
  /** REST baseline row — never rebuilt when some other asset ticks. */
  item: MarketAssetItemDto;
  /** This asset's latest realtime ticker, or null. */
  ticker?: AssetTickerMessage | null;
  /** True when this row's realtime price is past the freshness threshold. */
  isStale?: boolean;
  priceError?: AssetPriceErrorDto;
  onPress: (assetId: string) => void;
};

/**
 * One market list row.
 *
 * The REST item and this asset's ticker arrive as SEPARATE props and are
 * merged here, inside the row: a BTC tick changes only the BTC row's `ticker`
 * prop, so the memo comparator below short-circuits every other row instead of
 * the screen rebuilding a merged object per row on every tick.
 */
function MarketAssetRowComponent({
  item,
  ticker,
  isStale,
  priceError,
  onPress,
}: Props) {
  const displayItem = useMemo(
    () => mergeMarketAssetTicker(item, ticker ?? undefined),
    [item, ticker],
  );
  const nameDisplay = getAssetNameDisplay(displayItem);
  const symbolMarketDisplay = getAssetSymbolMarketDisplay(displayItem);
  const change = getMarketChangeDisplay(displayItem);
  const exception = getMarketException(displayItem);

  return (
    <View>
      <ActionPressable
        testID={TEST_IDS.market.item(item.id)}
        style={styles.itemRow}
        onPress={() => onPress(item.id)}
      >
        <View style={styles.identity}>
          <Text style={styles.itemSymbol}>{nameDisplay.primary}</Text>
          {symbolMarketDisplay ? (
            <Text style={styles.helper}>{symbolMarketDisplay}</Text>
          ) : null}
        </View>

        <View style={styles.alignEnd}>
          <Text
            style={[
              styles.itemPrice,
              isStale &&
                displayItem.marketStatus !== 'closed' &&
                styles.itemPriceStale,
            ]}
          >
            {getAssetPriceText(displayItem)}
          </Text>
          <Text testID={`market-change-${item.id}`} style={[styles.helper, { color: change.color }]}>{change.text}</Text>
          {exception ? <Text style={styles.exception}>{exception}</Text> : null}
        </View>
      </ActionPressable>
      {priceError && displayItem.price?.state !== 'available' ? (
        <AdminDiagnosticPanel diagnostic={priceError.diagnostic} />
      ) : null}
    </View>
  );
}

export const MarketAssetRow = React.memo(
  MarketAssetRowComponent,
  (previous, next) =>
    previous.item === next.item &&
    // Identity comparison: the store hands out the same ticker object until
    // that asset actually receives a newer accepted ticker.
    (previous.ticker ?? null) === (next.ticker ?? null) &&
    previous.isStale === next.isStale &&
    previous.priceError === next.priceError &&
    previous.onPress === next.onPress,
);

const styles = StyleSheet.create({
  identity: { flexGrow: 1, flexShrink: 1, flexBasis: 110, minWidth: 0 },
  itemRow: {
    paddingHorizontal: 12, marginBottom: 8, borderRadius: 12,
    backgroundColor: semantic.surface,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: semantic.border,
  },
  itemSymbol: { fontSize: 16, fontWeight: '700' },
  itemPrice: { maxWidth: '100%', textAlign: 'right', fontSize: 15, fontWeight: '600' },
  itemPriceStale: { color: semantic.warning },
  alignEnd: { alignItems: 'flex-end', flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: '100%' },
  helper: { fontSize: 14, color: semantic.secondary },
  exception: { fontSize: 12, color: semantic.warning, textAlign: 'right' },
});

export default MarketAssetRow;
