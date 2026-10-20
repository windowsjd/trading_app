import { semantic } from '../../theme/tokens';
import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';

import { TEST_IDS } from '../../constants/testIds';
import {
  getAssetNameSubline,
  getAssetNameDisplay,
  getAssetPriceText,
  getAssetSymbolMarketDisplay,
} from '../../utils/format';
import type { AssetTickerMessage } from '../asset/assetTickerPolicy';
import { getMarketChangeDisplay, getMarketException } from './marketPresentation';
import { getLastSessionCloseLabel } from '../asset/lastSessionClose';
import type { AssetPriceErrorDto, MarketAssetItemDto } from './api';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import { mergeMarketAssetTicker } from './mergeMarketAssetTicker';
import AssetLogo from './AssetLogo';

type Props = {
  /** REST baseline row — never rebuilt when some other asset ticks. */
  item: MarketAssetItemDto;
  /** This asset's latest realtime ticker, or null. */
  ticker?: AssetTickerMessage | null;
  /** True when this row's realtime price is past the freshness threshold. */
  isStale?: boolean;
  priceError?: AssetPriceErrorDto;
  onPress: (assetId: string) => void;
  /** A picker's current asset (the detail it was opened over): outlined, checked and announced as selected. */
  selected?: boolean;
  /** Defaults to the Spot list ids; other lists keep their own ids. */
  testID?: string;
  changeTestID?: string;
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
  testID,
  changeTestID,
  selected = false,
}: Props) {
  const displayItem = useMemo(
    () => mergeMarketAssetTicker(item, ticker ?? undefined),
    [item, ticker],
  );
  const nameDisplay = getAssetNameDisplay(displayItem);
  // A US stock shown by its Korean name keeps its English name under it:
  // `(Apple Inc.) · AAPL`. Every other row keeps `symbol · market`.
  const secondLine = getAssetNameSubline(nameDisplay) ?? getAssetSymbolMarketDisplay(displayItem);
  const change = getMarketChangeDisplay(displayItem);
  const exception = getMarketException(displayItem);
  // A closed US market's last confirmed close is named 종가 (no date), never "live".
  const lastClose =
    displayItem.price?.state === 'available'
      ? getLastSessionCloseLabel(displayItem.price)
      : null;

  return (
    <View>
      <ActionPressable
        testID={testID ?? TEST_IDS.market.item(item.id)}
        style={[styles.itemRow, selected && styles.itemRowSelected]}
        accessibilityState={selected ? { selected } : undefined}
        aria-selected={selected || undefined}
        onPress={() => onPress(item.id)}
      >
        <View style={styles.leading}>
          <AssetLogo testID={`market-logo-${item.id}`} assetType={displayItem.assetType} market={displayItem.market}
            symbol={displayItem.symbol} name={nameDisplay.primary} />
          <View style={styles.identity}>
            <Text testID={`market-name-${item.id}`} style={styles.itemSymbol}>
              {/* The mark follows the name (and wraps with it), as in the futures contract picker. */}
              {selected ? [nameDisplay.primary, <Text key="selected" testID={`market-selected-${item.id}`} style={styles.selectedMark}> ✓</Text>]
                : nameDisplay.primary}
            </Text>
            {secondLine ? (
              <Text testID={`market-subtitle-${item.id}`} style={styles.helper}>{secondLine}</Text>
            ) : null}
          </View>
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
          <Text testID={changeTestID ?? `market-change-${item.id}`} style={[styles.helper, { color: change.color }]}>{change.text}</Text>
          {lastClose ? (
            <Text testID={`market-last-close-${item.id}`} style={styles.lastClose}>{lastClose}</Text>
          ) : null}
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
    previous.onPress === next.onPress &&
    previous.testID === next.testID &&
    previous.changeTestID === next.changeTestID &&
    previous.selected === next.selected,
);

const styles = StyleSheet.create({
  // The logo's fixed circle and the names; below this width the price column
  // wraps under them (the names alone kept 110 before the logo's 40 + 10).
  leading: { flexDirection: 'row', alignItems: 'center', gap: 10, flexGrow: 1, flexShrink: 1, flexBasis: 160, minWidth: 0 },
  identity: { flex: 1, minWidth: 0 },
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
  // Same box as itemRow (no layout shift): only the outline and ground change.
  itemRowSelected: { borderColor: semantic.info, backgroundColor: semantic.raised },
  itemSymbol: { fontSize: 16, fontWeight: '700' },
  selectedMark: { color: semantic.info },
  itemPrice: { maxWidth: '100%', textAlign: 'right', fontSize: 15, fontWeight: '600' },
  itemPriceStale: { color: semantic.warning },
  alignEnd: { alignItems: 'flex-end', flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: '100%' },
  helper: { fontSize: 14, color: semantic.secondary },
  lastClose: { fontSize: 12, color: semantic.secondary, textAlign: 'right' },
  exception: { fontSize: 12, color: semantic.warning, textAlign: 'right' },
});

export default MarketAssetRow;
