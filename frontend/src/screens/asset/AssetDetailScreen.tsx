import { useQuery } from '@tanstack/react-query';
import { getAssetDetail } from '../../features/asset/api';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { useLearningAccess } from '../../features/quest/useLearningAccess';
import QuestTarget from '../../features/quest/QuestTarget';
import { questGuideTarget } from '../../features/quest/questGuideBridge';
import { useTradingGuideFacts } from '../../features/quest/useTradingGuideFacts';
import { semantic } from '../../theme/tokens';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from '../../theme/native';
import { SafeAreaView, useSafeAreaInsets } from '../../theme/safeArea';
import type { AssetDetailScreenProps } from '../../app/navigation/types';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import { TEST_IDS } from '../../constants/testIds';
import CTAButton from '../../components/common/CTAButton';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import { AssetMarketChart } from './AssetChartScreen';
import OrderAssetSheet from '../order/OrderAssetSheet';
import { useIsFocused } from '@react-navigation/native';

export default function AssetDetailScreen(props: AssetDetailScreenProps) {
  const { assetId } = props.route.params;
  const focused = useIsFocused();
  // The order screen's asset sheet, opened the way the order screen opens it
  // (every market with its market choice, from any asset): another asset is
  // picked over this screen and the detail is rebuilt for it in place.
  const [assetSheetOpen, setAssetSheetOpen] = useState(false);
  // The sheet never stays over another screen.
  useEffect(() => {
    if (!focused) setAssetSheetOpen(false);
  }, [focused]);
  const selectAsset = (nextAssetId: string) => {
    setAssetSheetOpen(false);
    if (nextAssetId !== assetId) props.navigation.setParams({ assetId: nextAssetId });
  };
  return (
    <>
      {/* Recreate the chart subscription and timeframe state when the pair changes. */}
      <AssetDetailContent key={assetId} {...props} onOpenAssetSheet={() => setAssetSheetOpen(true)} />
      <OrderAssetSheet visible={assetSheetOpen && focused} onClose={() => setAssetSheetOpen(false)} onSelect={selectAsset} />
    </>
  );
}

export function AssetDetailContent({
  route,
  navigation,
  onOpenAssetSheet,
}: AssetDetailScreenProps & { onOpenAssetSheet?: () => void }) {
  const { assetId } = route.params;
  const focused = useIsFocused();
  const { selectedAccountId, selectedAccount, isLoading } = useTradingAccount();
  const accountId =
    selectedAccount?.id === selectedAccountId ? selectedAccountId : null;
  const detail = useQuery({ queryKey: QUERY_KEYS.asset.detail(assetId), queryFn: () => getAssetDetail(assetId) });
  const learning = useLearningAccess(accountId);
  const insets = useSafeAreaInsets();
  // 매수하기 leads to every BUY of this market: open while any of them is (a
  // crypto limit BUY at QUEST 06, a stock market BUY at its own quest).
  const assetType = detail.data?.asset.assetType;
  const buyGate = learning.gate(assetType === 'crypto' ? ['cryptoMarketBuy', 'cryptoLimitBuy']
    : assetType === 'domestic_stock' ? 'krStockMarketBuy' : assetType === 'us_stock' ? 'usStockMarketBuy' : 'allTrading');
  useTradingGuideFacts({ screen: 'asset', accountId: accountId ?? '', assetId, assetType: detail.data?.asset.assetType }, focused);
  const openOrder = (side: 'buy' | 'sell') => {
    if (!accountId) return;
    navigation.navigate('Order', { assetId, accountId, side });
  };

  return (
    // The tab bar is hidden on this screen (MainTabs), so the order bar is the
    // screen's bottom edge: it pads itself by the bottom inset from the same
    // provider the tab bar uses, instead of the native SafeAreaView bottom edge
    // (left Android's buttons under the system navigation bar).
    <SafeAreaView edges={['left', 'right']} style={styles.screen}>
      <View ref={questGuideTarget('asset-viewport')} collapsable={false} style={{ flex: 1 }}>
      <View style={styles.content}>
        <AssetMarketChart
          assetId={assetId}
          variant="detail"
          onChangePair={onOpenAssetSheet}
          // Holdings, TP/SL and limit review live under the order screen (one place).
          footerContent={!isLoading && !accountId ? (
            <InlineEmptyState title="계정이 없습니다." message="계정을 개설하면 주문할 수 있습니다." />
          ) : null}
        />
      </View>
      <View style={{ ...styles.footer, paddingBottom: styles.footer.paddingBottom + insets.bottom }} testID="asset-order-actions">
        <QuestTarget id="asset-sell" style={styles.actionSlot}><CTAButton
          testID={TEST_IDS.assetDetail.openSellOrder}
          label="매도하기"
          state={accountId ? 'enabled' : 'disabled'}
          onPress={() => openOrder('sell')}
          style={{ ...styles.action, backgroundColor: SELL_COLOR }}
        /></QuestTarget>
        <QuestTarget id="asset-buy" style={styles.actionSlot}><CTAButton
          testID={TEST_IDS.assetDetail.openBuyOrder}
          label="매수하기"
          state={accountId ? 'enabled' : 'disabled'}
          learningHint={buyGate.locked ? buyGate.message : null}
          onPress={() => buyGate.guard(() => openOrder('buy'))}
          style={{ ...styles.action, backgroundColor: BUY_COLOR }}
        /></QuestTarget>
      </View>
    </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, minHeight: 0, backgroundColor: semantic.screen },
  content: { flex: 1, minHeight: 0 },
  footer: {
    flexShrink: 0,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: semantic.border,
    backgroundColor: semantic.surface,
  },
  // Only the row's slots flex (horizontally). A flex: 1 button inside the
  // column-shaped QuestTarget gets a zero vertical basis in native Yoga:
  // the footer measures less than the button's actual minimum/text height.
  // Let the button (or its learning caption group) set the slot's height.
  actionSlot: { flex: 1, minWidth: 0 },
  action: { minWidth: 0, minHeight: 50, paddingHorizontal: 8 },
});
