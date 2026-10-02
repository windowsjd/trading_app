import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { SafeAreaView, ScrollView, View, Text, StyleSheet, Platform } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { getScreenContentStyle } from '../../theme/screenLayout';
import type { WalletScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import {
  getTradingAccountPortfolio, getTradingAccountWallets, getTradingAccountPositions,
  type TradingAccountDto,
} from '../../features/tradingAccount/api';
import { getAccountHoldings } from '../../features/tradingAccount/holdings';
import { ACCOUNT_INTEGRITY_TITLE, findAccountIntegrityFailure } from '../../features/tradingAccount/accountIntegrityGate';
import { getCapabilityBlockMessage, type TradingAccountCapabilities } from '../../features/tradingAccount/capabilities';
import { getPortfolioNotice } from '../../features/tradingAccount/portfolioMessage';
import { getKnownWalletBalanceAmount } from '../../features/wallet/mapper';
import { formatMoney } from '../../utils/format';
import AccountSwitcher from '../../components/tradingAccount/AccountSwitcher';
import PositionAssetRow from '../../components/tradingAccount/PositionAssetRow';
import CTAButton from '../../components/common/CTAButton';
import ActionPressable from '../../components/common/ActionPressable';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import HomeAssetHero from '../home/HomeAssetHero';

export default function WalletScreen({ navigation }: WalletScreenProps) {
  const { selectedAccount, capabilities, isLoading, isError, refetchAccounts } = useTradingAccount();
  if (isLoading) return <FullPageLoading message="지갑 정보를 불러오는 중입니다." />;
  if (isError || !selectedAccount) {
    return <ErrorState title="계정 정보를 불러오지 못했습니다." onRetry={() => void refetchAccounts()} />;
  }
  return (
    <SafeAreaView style={styles.screen}>
      <AccountWallet key={selectedAccount.id} account={selectedAccount} capabilities={capabilities} navigation={navigation} />
    </SafeAreaView>
  );
}

type AccountWalletProps = {
  account: TradingAccountDto;
  capabilities: TradingAccountCapabilities | null;
  navigation: WalletScreenProps['navigation'];
};

function AccountWallet({ account, capabilities, navigation }: AccountWalletProps) {
  const accountId = account.id;
  const rootNavigation = useRootNavigation();
  const portfolioQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolio(accountId),
    queryFn: () => getTradingAccountPortfolio(accountId),
  });
  const walletsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.wallets(accountId),
    queryFn: () => getTradingAccountWallets(accountId),
  });
  const positionsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.holdings(accountId),
    queryFn: () => getAccountHoldings(accountId, getTradingAccountPositions),
  });
  const refresh = usePullToRefresh([portfolioQuery, walletsQuery, positionsQuery]);

  const integrityFailure = findAccountIntegrityFailure([
    { section: '총 자산', isError: portfolioQuery.isError, error: portfolioQuery.error, retry: () => void portfolioQuery.refetch() },
    { section: '현금', isError: walletsQuery.isError, error: walletsQuery.error, retry: () => void walletsQuery.refetch() },
    { section: '보유 종목', isError: positionsQuery.isError, error: positionsQuery.error, retry: () => void positionsQuery.refetch() },
  ]);
  const portfolio = portfolioQuery.data;
  const notice = portfolio ? getPortfolioNotice(portfolio) : null;
  const blockMessage = capabilities?.canExchange ? null
    : getCapabilityBlockMessage(capabilities, capabilities?.exchangeBlockReason);
  const positions = positionsQuery.data?.positions;

  return (
    <ScrollView refreshControl={refresh.refreshControl} testID="wallet-screen" contentContainerStyle={styles.content}>
      <AccountSwitcher home />
      {integrityFailure ? (
        <View testID={TEST_IDS.tradingAccount.integrityError}>
          <ErrorState title={ACCOUNT_INTEGRITY_TITLE} message={integrityFailure.message} onRetry={integrityFailure.retry} />
        </View>
      ) : (
        <>
          {portfolioQuery.isLoading ? <SectionSkeleton lines={3} />
            : !portfolio ? (
              <ErrorState title="총 자산을 불러오지 못했습니다." onRetry={() => void portfolioQuery.refetch()} />
            ) : (
              <HomeAssetHero summary={portfolio.summary} settled={account.season?.seasonStatus === 'settled'} unavailableMessage={notice?.message} />
            )}
          <CTAButton testID="wallet-exchange" label="환전하기" state={capabilities?.canExchange ? 'enabled' : 'blocked'} onPress={() => navigation.navigate('WalletFx')} />
          {blockMessage ? <Text testID={TEST_IDS.tradingAccount.capabilityNotice} style={styles.notice}>{blockMessage}</Text> : null}
          {notice ? <Text style={styles.notice}>{notice.message}</Text> : null}

          <View testID="wallet-composition" style={styles.card}>
            <Text style={styles.title}>지갑 구성</Text>
            {walletsQuery.isLoading ? <SectionSkeleton lines={2} />
              : walletsQuery.isError && !walletsQuery.data ? (
                <ErrorState title="현금 잔액을 불러오지 못했습니다." onRetry={() => void walletsQuery.refetch()} />
              ) : (
                (['KRW', 'USD'] as const).map((currency) => (
                  <View key={currency} testID={`wallet-cash-${currency}`} style={styles.cashRow}>
                    <Text style={styles.cashLabel}>{currency}</Text>
                    <Text style={styles.cashValue}>{formatMoney(getKnownWalletBalanceAmount(walletsQuery.data, currency), currency)}</Text>
                  </View>
                ))
              )}
            <View style={styles.holdings}>
              {positionsQuery.isLoading ? <SectionSkeleton lines={3} />
                : positionsQuery.isError && !positionsQuery.data ? (
                  <ErrorState title="보유 종목을 불러오지 못했습니다." onRetry={() => void positionsQuery.refetch()} />
                ) : !positions ? <InlineEmptyState message="보유 종목을 확인할 수 없습니다." />
                  : positions.length === 0 ? <InlineEmptyState message="보유 종목이 없습니다." />
                    : positions.map((position) => (
                      <PositionAssetRow
                        key={position.positionId}
                        testID={`wallet-position-${position.assetId}`}
                        position={position}
                        onPress={() => rootNavigation.navigate('MainTabs', { screen: 'MarketTab', params: { screen: 'AssetDetail', params: { assetId: position.assetId } } })}
                      />
                    ))}
            </View>
          </View>
        </>
      )}
      <View style={styles.history}>
        <ActionPressable testID="wallet-ledger" style={styles.historyAction} onPress={() => navigation.navigate('WalletTransactions')}>
          <Text style={styles.historyLabel}>원장 보기</Text>
        </ActionPressable>
        <ActionPressable testID="wallet-orders" style={styles.historyAction} onPress={() => rootNavigation.navigate('TradeHistory', { accountId })}>
          <Text style={styles.historyLabel}>거래 내역 보기</Text>
        </ActionPressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, paddingBottom: 24, gap: 12 },
  card: { padding: 16, borderWidth: 1, borderColor: semantic.border, borderRadius: 14, backgroundColor: semantic.surface },
  title: { fontSize: 14, fontWeight: '600', lineHeight: 21, color: semantic.secondary, marginBottom: 8 },
  cashRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 12, rowGap: 4, paddingVertical: 12 },
  cashLabel: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
  cashValue: { flexGrow: 1, flexShrink: 1, minWidth: 0, textAlign: 'right', fontSize: 16, lineHeight: 24, fontVariant: ['tabular-nums'] },
  holdings: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: semantic.border },
  notice: { fontSize: 13, lineHeight: 20, color: semantic.warning },
  history: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  historyAction: { flex: 1, minWidth: 0, padding: 12, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  historyLabel: { fontSize: 13, lineHeight: 20, color: semantic.secondary, textAlign: 'center' },
});
