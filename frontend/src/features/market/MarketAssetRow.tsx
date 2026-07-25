import React, { useMemo } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';

import { TEST_IDS } from '../../constants/testIds';
import {
  formatPercent,
  getAssetNameDisplay,
  getAssetPriceText,
} from '../../utils/format';
import type { AssetTickerMessage } from '../asset/assetTickerPolicy';
import type { MarketAssetItemDto } from './api';
import { mergeMarketAssetTicker } from './mergeMarketAssetTicker';

type Props = {
  /** REST baseline row — never rebuilt when some other asset ticks. */
  item: MarketAssetItemDto;
  /** This asset's latest realtime ticker, or null. */
  ticker?: AssetTickerMessage | null;
  /** True when this row's realtime price is past the freshness threshold. */
  isStale?: boolean;
  onPress: (assetId: string) => void;
};

function getChangeRateText(item: MarketAssetItemDto) {
  if (item.price?.state !== 'available' || !item.price.changeRate) {
    return item.tradeBlockedReason ?? item.marketStatus;
  }

  return `${formatPercent(item.price.changeRate)}%`;
}

/**
 * One market list row.
 *
 * The REST item and this asset's ticker arrive as SEPARATE props and are
 * merged here, inside the row: a BTC tick changes only the BTC row's `ticker`
 * prop, so the memo comparator below short-circuits every other row instead of
 * the screen rebuilding a merged object per row on every tick.
 */
function MarketAssetRowComponent({ item, ticker, isStale, onPress }: Props) {
  const displayItem = useMemo(
    () => mergeMarketAssetTicker(item, ticker ?? undefined),
    [item, ticker],
  );
  const nameDisplay = getAssetNameDisplay(displayItem);

  return (
    <Pressable
      testID={TEST_IDS.market.item(item.id)}
      style={styles.itemRow}
      onPress={() => onPress(item.id)}
    >
      <View>
        <Text style={styles.itemSymbol}>{nameDisplay.primary}</Text>
        <Text style={styles.helper}>
          {displayItem.symbol} · {displayItem.market}
        </Text>
      </View>

      <View style={styles.alignEnd}>
        <Text style={[styles.itemPrice, isStale && styles.itemPriceStale]}>
          {getAssetPriceText(displayItem)}
        </Text>
        <Text style={styles.helper}>{getChangeRateText(displayItem)}</Text>
        <Text style={styles.helper}>
          {displayItem.marketStatus} ·{' '}
          {displayItem.tradable ? '거래 가능' : '거래 제한'}
        </Text>
      </View>
    </Pressable>
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
    previous.onPress === next.onPress,
);

const styles = StyleSheet.create({
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  itemSymbol: { fontSize: 16, fontWeight: '700' },
  itemPrice: { fontSize: 15, fontWeight: '600' },
  itemPriceStale: { color: '#8a6d00' },
  alignEnd: { alignItems: 'flex-end' },
  helper: { fontSize: 14, color: '#444' },
});

export default MarketAssetRow;
