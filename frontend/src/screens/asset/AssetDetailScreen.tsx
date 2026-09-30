import React from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { AssetDetailScreenProps } from '../../app/navigation/types';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { BUY_COLOR, SELL_COLOR } from '../../features/order/sideColors';
import { TEST_IDS } from '../../constants/testIds';
import CTAButton from '../../components/common/CTAButton';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import { AssetMarketChart } from './AssetChartScreen';

export default function AssetDetailScreen(props: AssetDetailScreenProps) {
  // Recreate the chart subscription and timeframe state when the pair changes.
  return <AssetDetailContent key={props.route.params.assetId} {...props} />;
}

export function AssetDetailContent({
  route,
  navigation,
}: AssetDetailScreenProps) {
  const { assetId } = route.params;
  const { selectedAccountId, selectedAccount, isLoading } = useTradingAccount();
  const accountId =
    selectedAccount?.id === selectedAccountId ? selectedAccountId : null;
  const openOrder = (side: 'buy' | 'sell') => {
    if (!accountId) return;
    navigation.navigate('Order', { assetId, accountId, side });
  };

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.screen}>
      <AssetMarketChart
        assetId={assetId}
        variant="detail"
        onChangePair={() =>
          navigation.navigate('MarketSearch', { returnToAsset: true })
        }
      />
      {!isLoading && !accountId ? (
        <InlineEmptyState
          title="계정이 없습니다."
          message="계정을 개설하면 주문할 수 있습니다."
        />
      ) : null}
      <View style={styles.footer} testID="asset-order-actions">
        <CTAButton
          testID={TEST_IDS.assetDetail.openSellOrder}
          label="판매하기"
          state={accountId ? 'enabled' : 'disabled'}
          onPress={() => openOrder('sell')}
          style={{ ...styles.action, backgroundColor: SELL_COLOR }}
        />
        <CTAButton
          testID={TEST_IDS.assetDetail.openBuyOrder}
          label="구매하기"
          state={accountId ? 'enabled' : 'disabled'}
          onPress={() => openOrder('buy')}
          style={{ ...styles.action, backgroundColor: BUY_COLOR }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#fff' },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: '#edf0f3',
    backgroundColor: '#fff',
  },
  action: { flex: 1, minWidth: 0, minHeight: 50, paddingHorizontal: 8 },
});
