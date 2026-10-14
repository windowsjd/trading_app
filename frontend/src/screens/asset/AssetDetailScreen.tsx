import { useQuery } from '@tanstack/react-query';
import { getAssetDetail } from '../../features/asset/api';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { useLearningAccess } from '../../features/quest/useLearningAccess';
import QuestTarget from '../../features/quest/QuestTarget';
import { questGuideTarget } from '../../features/quest/questGuideBridge';
import { useTradingGuideFacts } from '../../features/quest/useTradingGuideFacts';
import { semantic } from '../../theme/tokens';
import React from 'react';
import { StyleSheet, View } from '../../theme/native';
import { SafeAreaView, useSafeAreaInsets } from '../../theme/safeArea';
import type { AssetDetailScreenProps } from '../../app/navigation/types';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import { TEST_IDS } from '../../constants/testIds';
import CTAButton from '../../components/common/CTAButton';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import { AssetMarketChart } from './AssetChartScreen';
import { useIsFocused } from '@react-navigation/native';

export default function AssetDetailScreen(props: AssetDetailScreenProps) {
  // Recreate the chart subscription and timeframe state when the pair changes.
  return <AssetDetailContent key={props.route.params.assetId} {...props} />;
}

export function AssetDetailContent({
  route,
  navigation,
}: AssetDetailScreenProps) {
  const { assetId } = route.params;
  const focused = useIsFocused();
  const { selectedAccountId, selectedAccount, isLoading } = useTradingAccount();
  const accountId =
    selectedAccount?.id === selectedAccountId ? selectedAccountId : null;
  const detail = useQuery({ queryKey: QUERY_KEYS.asset.detail(assetId), queryFn: () => getAssetDetail(assetId) });
  const learning = useLearningAccess(accountId);
  const insets = useSafeAreaInsets();
  const buyGate = learning.gate(detail.data?.asset.assetType === 'crypto' ? 'cryptoMarketBuy' : 'allTrading');
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
          onChangePair={() =>
            navigation.navigate('MarketSearch', { returnToAsset: true })
          }
          // Holdings, TP/SL and limit review live under the order screen (one place).
          footerContent={!isLoading && !accountId ? (
            <InlineEmptyState title="계정이 없습니다." message="계정을 개설하면 주문할 수 있습니다." />
          ) : null}
        />
      </View>
      <View style={{ ...styles.footer, paddingBottom: styles.footer.paddingBottom + insets.bottom }} testID="asset-order-actions">
        <QuestTarget id="asset-sell" style={{ flex: 1 }}><CTAButton
          testID={TEST_IDS.assetDetail.openSellOrder}
          label="판매하기"
          state={accountId ? 'enabled' : 'disabled'}
          onPress={() => openOrder('sell')}
          style={{ ...styles.action, backgroundColor: SELL_COLOR }}
        /></QuestTarget>
        <QuestTarget id="asset-buy" style={{ flex: 1 }}><CTAButton
          testID={TEST_IDS.assetDetail.openBuyOrder}
          label="구매하기"
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
  action: { flex: 1, minWidth: 0, minHeight: 50, paddingHorizontal: 8 },
});
