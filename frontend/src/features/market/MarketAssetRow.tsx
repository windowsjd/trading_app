import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';

import { TEST_IDS } from '../../constants/testIds';
import {
  formatPercent,
  getAssetNameDisplay,
  getAssetPriceText,
} from '../../utils/format';
import type { MarketAssetItemDto } from './api';

type Props = {
  item: MarketAssetItemDto;
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
 * One market list row, split out and memoized so a ticker for BTCUSDT only
 * re-renders the BTCUSDT row: the merge helper returns the SAME item object for
 * untouched rows, so the props comparison below short-circuits everything else.
 */
function MarketAssetRowComponent({ item, isStale, onPress }: Props) {
  const nameDisplay = getAssetNameDisplay(item);

  return (
    <Pressable
      testID={TEST_IDS.market.item(item.id)}
      style={styles.itemRow}
      onPress={() => onPress(item.id)}
    >
      <View>
        <Text style={styles.itemSymbol}>{nameDisplay.primary}</Text>
        <Text style={styles.helper}>
          {item.symbol} · {item.market}
        </Text>
      </View>

      <View style={styles.alignEnd}>
        <Text style={[styles.itemPrice, isStale && styles.itemPriceStale]}>
          {getAssetPriceText(item)}
        </Text>
        <Text style={styles.helper}>{getChangeRateText(item)}</Text>
        <Text style={styles.helper}>
          {item.marketStatus} · {item.tradable ? '거래 가능' : '거래 제한'}
        </Text>
      </View>
    </Pressable>
  );
}

export const MarketAssetRow = React.memo(
  MarketAssetRowComponent,
  (previous, next) =>
    previous.item === next.item &&
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
