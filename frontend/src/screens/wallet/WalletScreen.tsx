import { portfolioReadPolicy } from '../../features/tradingAccount/portfolioReadPolicy';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Svg, { Path } from 'react-native-svg';
import { ScrollView, View, Text, StyleSheet, Platform } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { primaryGradient, semantic } from '../../theme/tokens';
import { getHeaderScreenContentStyle } from '../../theme/screenLayout';
import type { WalletScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import {
  getTradingAccountPortfolio, getTradingAccountWallets, getTradingAccountPositions,
  getTradingAccountEquity,
  type TradingAccountDto,
} from '../../features/tradingAccount/api';
import { getAccountHoldings } from '../../features/tradingAccount/holdings';
import { ACCOUNT_INTEGRITY_TITLE, findAccountIntegrityFailure } from '../../features/tradingAccount/accountIntegrityGate';
import { getCapabilityBlockMessage, type TradingAccountCapabilities } from '../../features/tradingAccount/capabilities';
import { getPortfolioNotice } from '../../features/tradingAccount/portfolioMessage';
import { getWalletByIdentity } from '../../features/wallet/mapper';
import { WALLET_GROUPS, WALLET_SCOPE_LABELS } from '../../features/wallet/walletIdentity';
import { formatMoney } from '../../utils/format';
import PositionAssetRow from '../../components/tradingAccount/PositionAssetRow';
import ActionPressable from '../../components/common/ActionPressable';
import PrimaryButtonBackground from '../../components/common/PrimaryButtonBackground';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import HomeAssetHero from '../home/HomeAssetHero';
import HomeAssetTrend, { type HomeEquityRange } from '../home/HomeAssetTrend';

export default function WalletScreen({ navigation }: WalletScreenProps) {
  const { selectedAccount, capabilities, isLoading, isError, error, refetchAccounts } = useTradingAccount();
  if (isLoading) return <FullPageLoading message="지갑 정보를 불러오는 중입니다." />;
  if (isError || !selectedAccount) {
    return <ErrorState error={isError ? error : undefined} title="계정 정보를 불러오지 못했습니다." message="요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요." onRetry={() => void refetchAccounts()} />;
  }
  return (
    <SafeAreaView edges={['left', 'right']} style={styles.screen}>
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
  const [trendExpanded, setTrendExpanded] = useState(false);
  const [equityRange, setEquityRange] = useState<HomeEquityRange>('30d');
  const portfolioQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolio(accountId),
    queryFn: () => getTradingAccountPortfolio(accountId),
    ...portfolioReadPolicy,
  });
  const walletsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.wallets(accountId),
    queryFn: () => getTradingAccountWallets(accountId),
  });
  const positionsQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.holdings(accountId),
    queryFn: () => getAccountHoldings(accountId, getTradingAccountPositions),
  });
  const equityQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.portfolioEquity(accountId, equityRange, 'daily'),
    queryFn: () => getTradingAccountEquity(accountId, equityRange, 'daily'),
    enabled: trendExpanded,
  });
  const refresh = usePullToRefresh([
    portfolioQuery, walletsQuery, positionsQuery,
    { ...equityQuery, enabled: trendExpanded },
  ]);

  const integrityFailure = findAccountIntegrityFailure([
    { section: '총 자산', isError: portfolioQuery.isError, error: portfolioQuery.error, retry: () => void portfolioQuery.refetch() },
    { section: '현금', isError: walletsQuery.isError, error: walletsQuery.error, retry: () => void walletsQuery.refetch() },
    { section: '보유 종목', isError: positionsQuery.isError, error: positionsQuery.error, retry: () => void positionsQuery.refetch() },
    { section: '자산 추이', isError: equityQuery.isError, error: equityQuery.error, retry: () => void equityQuery.refetch() },
  ]);
  const portfolio = portfolioQuery.data;
  const notice = portfolio ? getPortfolioNotice(portfolio) : null;
  const blockMessage = capabilities?.canExchange ? null
    : getCapabilityBlockMessage(capabilities, capabilities?.exchangeBlockReason);
  const positions = positionsQuery.data?.positions;
  const quickActions = [
    {
      testID: 'wallet-transfer',
      label: '이체하기',
      iconPath: 'M4 7h16m-4-4 4 4-4 4 M20 17H4m4-4-4 4 4 4',
      disabled: !capabilities?.canExchange,
      hidden: !!integrityFailure,
      onPress: () => navigation.navigate('WalletTransfer'),
    },
    {
      testID: 'wallet-exchange',
      label: '환전하기',
      iconPath: 'M4 7h16m-4-4 4 4-4 4 M20 17H4m4-4-4 4 4 4',
      disabled: !capabilities?.canExchange,
      hidden: !!integrityFailure,
      onPress: () => navigation.navigate('WalletFx'),
    },
    {
      testID: 'wallet-ledger',
      label: '원장 보기',
      iconPath: 'M6 3h14v18H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M8 3v18 M11 8h6 M11 12h6 M11 16h4',
      disabled: false,
      hidden: false,
      onPress: () => navigation.navigate('WalletTransactions'),
    },
    {
      testID: 'wallet-orders',
      label: '주문 내역',
      iconPath: 'M5 3h14v18l-3-2-4 2-4-2-3 2V3Z M8 7h8 M8 11h8 M8 15l2 2 5-4',
      disabled: false,
      hidden: false,
      onPress: () => rootNavigation.navigate('TradeHistory', { accountId }),
    },
  ];

  return (
    <ScrollView refreshControl={refresh.refreshControl} testID="wallet-screen" contentContainerStyle={styles.content}>
      {integrityFailure ? (
        <View testID={TEST_IDS.tradingAccount.integrityError}>
          <ErrorState error={integrityFailure.error} title={ACCOUNT_INTEGRITY_TITLE} message={integrityFailure.message} onRetry={integrityFailure.retry} />
        </View>
      ) : (
        <>
          {portfolioQuery.isLoading ? <SectionSkeleton lines={3} />
            : !portfolio ? (
              <ErrorState error={portfolioQuery.error} title="총 자산을 불러오지 못했습니다." message="요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요." onRetry={() => void portfolioQuery.refetch()} />
            ) : (
              <HomeAssetHero compactTop compactBottom summary={portfolio.summary} settled={account.season?.seasonStatus === 'settled'} unavailableMessage={notice?.message} />
            )}
          {notice ? <View>
            <Text style={styles.notice}>{notice.message}</Text>
            {portfolio?.sectionErrors.map((failure, index) => (
              <AdminDiagnosticPanel key={index} diagnostic={failure.diagnostic} />
            ))}
          </View> : null}
          <HomeAssetTrend
            expanded={trendExpanded}
            onToggle={() => setTrendExpanded(value => !value)}
            range={equityRange}
            onRangeChange={setEquityRange}
            equity={equityQuery.data}
            loading={equityQuery.isLoading}
            failed={equityQuery.isError}
            error={equityQuery.error}
            general={account.mode === 'general'}
          />
        </>
      )}
      <View testID="wallet-quick-actions" style={styles.quickActions}>
        {quickActions.filter((action) => !action.hidden).map((action) => (
          <View key={action.testID} testID={`${action.testID}-item`} style={styles.quickActionItem}>
            <ActionPressable
              testID={action.testID}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              accessibilityState={{ disabled: action.disabled }}
              disabled={action.disabled}
              style={styles.quickActionTarget}
              feedbackStyle={[styles.quickAction, styles.quickActionFeedback]}
              onPress={action.onPress}
            >
              <View
                testID={`${action.testID}-surface`}
                style={[styles.quickAction, action.disabled && styles.quickActionDisabled]}
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                aria-hidden
                pointerEvents="none"
              >
                <PrimaryButtonBackground shape={{ borderRadius: styles.quickAction.borderRadius }} />
                <Svg
                  style={styles.quickActionIcon}
                  width={24}
                  height={24}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={primaryGradient.foreground}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  focusable={false}
                  aria-hidden
                >
                  <Path d={action.iconPath} />
                </Svg>
              </View>
              <Text
                testID={`${action.testID}-label`}
                accessible={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                aria-hidden
                style={[styles.quickActionLabel, action.disabled && styles.quickActionDisabled]}
              >
                {action.label}
              </Text>
            </ActionPressable>
          </View>
        ))}
      </View>
      {!integrityFailure && blockMessage ? <Text testID={TEST_IDS.tradingAccount.capabilityNotice} style={styles.notice}>{blockMessage}</Text> : null}
      {!integrityFailure ? (
        <View testID="wallet-composition" style={styles.card}>
          <Text style={styles.title}>지갑 구성</Text>
          {walletsQuery.isLoading ? <SectionSkeleton lines={2} />
            : walletsQuery.isError && !walletsQuery.data ? (
              <ErrorState error={walletsQuery.error} title="현금 잔액을 불러오지 못했습니다." message="요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요." onRetry={() => void walletsQuery.refetch()} />
            ) : (
              WALLET_GROUPS.map(({ scope, currencies }) => (
                <View key={scope} testID={`wallet-group-${scope}`} style={styles.walletGroup}>
                  <Text testID={`wallet-group-${scope}-title`} style={styles.groupTitle}>{WALLET_SCOPE_LABELS[scope]}</Text>
                  {currencies.map((currency) => (
                    <View key={currency} testID={scope === 'securities' ? `wallet-cash-${currency}` : `wallet-cash-${scope}-${currency}`} style={styles.cashRow}>
                      <Text style={styles.cashLabel}>{currency}</Text>
                      <Text style={styles.cashValue}>{formatMoney(getWalletByIdentity(walletsQuery.data, scope, currency)?.balanceAmount ?? null, currency)}</Text>
                    </View>
                  ))}
                </View>
              ))
            )}
          <View style={styles.holdings}>
            <Text testID="wallet-holdings-title" style={styles.groupTitle}>보유 종목</Text>
            {positionsQuery.isLoading ? <SectionSkeleton lines={3} />
              : positionsQuery.isError && !positionsQuery.data ? (
                <ErrorState error={positionsQuery.error} title="보유 종목을 불러오지 못했습니다." message="요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요." onRetry={() => void positionsQuery.refetch()} />
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
            {positions ? positionsQuery.data?.valuationErrors?.map((failure, index) => (
              <AdminDiagnosticPanel key={index} diagnostic={failure.diagnostic} />
            )) : null}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: getHeaderScreenContentStyle(Platform.OS),
  card: { padding: 16, borderWidth: 1, borderColor: semantic.border, borderRadius: 14, backgroundColor: semantic.surface },
  title: { fontSize: 14, fontWeight: '600', lineHeight: 21, color: semantic.secondary, marginBottom: 8 },
  walletGroup: { marginTop: 8 },
  groupTitle: { fontSize: 15, fontWeight: '600', lineHeight: 23 },
  cashRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 12, rowGap: 4, paddingVertical: 12 },
  cashLabel: { fontSize: 14, lineHeight: 21, color: semantic.secondary },
  cashValue: { flexGrow: 1, flexShrink: 1, minWidth: 0, textAlign: 'right', fontSize: 16, lineHeight: 24, fontVariant: ['tabular-nums'] },
  holdings: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: semantic.border },
  notice: { fontSize: 13, lineHeight: 20, color: semantic.warning },
  quickActions: { width: '100%', maxWidth: 440, alignSelf: 'center', flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  quickActionItem: { flex: 1, minWidth: 0, alignItems: 'center', gap: 8 },
  quickActionTarget: { alignSelf: 'stretch', alignItems: 'center', gap: 8 },
  quickAction: { width: 52, height: 52, borderRadius: 12, backgroundColor: primaryGradient.colors[0], alignItems: 'center', justifyContent: 'center' },
  quickActionIcon: { position: 'relative' },
  quickActionFeedback: { top: 0, alignSelf: 'center', zIndex: 1 },
  quickActionDisabled: { opacity: 0.45 },
  quickActionLabel: { alignSelf: 'stretch', fontSize: 13, fontWeight: '600', lineHeight: 20, color: semantic.secondary, textAlign: 'center' },
});
