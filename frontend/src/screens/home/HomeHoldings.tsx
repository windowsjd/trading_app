import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { View, Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { getTradingAccountPositions } from '../../features/tradingAccount/api';
import { getAccountHoldings } from '../../features/tradingAccount/holdings';
import { orderHomeHoldings, usdKrwRefetchDelay } from '../../features/tradingAccount/homePortfolio';
import { getCurrentFxRate } from '../../features/wallet/api';
import PositionAssetRow from '../../components/tradingAccount/PositionAssetRow';
import FuturesPositionRow from '../../components/tradingAccount/FuturesPositionRow';
import ActionPressable from '../../components/common/ActionPressable';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import ErrorState from '../../components/states/ErrorState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { useFuturesHoldings } from '../../features/futures/useFuturesHoldings';
import { futuresHolding } from '../../features/futures/positionDisplay';

// The wallet's USD/KRW read, so both screens share one cached rate.
const USD_KRW = { baseCurrency: 'USD', quoteCurrency: 'KRW', refresh: false } as const;

export function useHomeHoldings(accountId: string) {
  const [expanded, setExpanded] = useState(false);
  const previewQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.positions(accountId, { limit: 1 }),
    queryFn: () => getTradingAccountPositions(accountId, { limit: 1, offset: 0 }),
  });
  const fullQuery = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.holdings(accountId),
    queryFn: () => getAccountHoldings(accountId, getTradingAccountPositions),
    enabled: expanded,
  });
  const futures = useFuturesHoldings(accountId);
  // Only a list holding both spot (KRW value) and futures (USD notional) needs the rate.
  const spotHeld = previewQuery.data?.tradingAccountId === accountId && previewQuery.data.pagination?.total > 0;
  const usdKrwNeeded = spotHeld && (futures.data?.positions.length ?? 0) > 0;
  const usdKrwQuery = useQuery({
    queryKey: QUERY_KEYS.wallet.fxRate(USD_KRW),
    queryFn: () => getCurrentFxRate(USD_KRW.baseCurrency, USD_KRW.quoteCurrency, USD_KRW.refresh),
    enabled: usdKrwNeeded,
    refetchInterval: query => usdKrwRefetchDelay(query.state.data?.validUntil, Date.now()),
  });
  return { accountId, expanded, setExpanded, previewQuery, fullQuery, futures, usdKrwQuery, usdKrwNeeded };
}

/**
 * Spot holdings and futures positions as one list, largest amount first
 * (orderHomeHoldings). Collapsed shows the largest of both: the server's top
 * spot row (`limit: 1` is ordered by KRW value) against every futures row.
 */
export default function HomeHoldings({ holdings, onOpenAsset }: {
  holdings: ReturnType<typeof useHomeHoldings>;
  onOpenAsset: (assetId: string) => void;
}) {
  const { accountId, expanded, setExpanded, previewQuery, fullQuery, futures, usdKrwQuery, usdKrwNeeded } = holdings;
  const rootNavigation = useRootNavigation();
  // Both responses retain the server's canonical KRW-equivalent ordering.
  // A newer complete Wallet/Home read can also supply the collapsed summary.
  const full = fullQuery.data?.tradingAccountId === accountId ? fullQuery.data : undefined;
  const preview = previewQuery.data?.tradingAccountId === accountId ? previewQuery.data : undefined;
  const useFull = full && (expanded || fullQuery.dataUpdatedAt >= previewQuery.dataUpdatedAt);
  const positions = useFull ? full.positions : preview?.positions;
  const valuationErrors = useFull ? full.valuationErrors : preview?.valuationErrors;
  const total = useFull ? full.positions.length : preview?.pagination.total ?? 0;
  const futuresCount = futures.data?.positions.length ?? 0;
  const empty = !!positions && !previewQuery.isError && !fullQuery.isError && total === 0
    && !!futures.data && futuresCount === 0;
  // A partial read is never ordered as the whole list: wait for both domains
  // and, when they mix, for the rate that makes their amounts comparable.
  const settling = (!positions && previewQuery.isLoading) || (!futures.data && !futures.isError)
    || (usdKrwNeeded && usdKrwQuery.isLoading);
  const order = orderHomeHoldings({
    spot: positions ?? [], futures: futures.data?.positions ?? [], futuresEvaluatedAt: futures.data?.evaluatedAt,
    usdKrw: usdKrwQuery.isError ? null : usdKrwQuery.data, now: futures.clock,
  });
  const rows = expanded && full ? order.entries : order.entries.slice(0, 1);
  return (
    <View testID="home-holdings" style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>보유종목 및 포지션</Text>
      {empty ? <InlineEmptyState title="보유종목 및 포지션이 없습니다." message="아직 보유한 종목이나 선물 포지션이 없습니다." /> : <>
      {positions && previewQuery.isError ? <ErrorState error={previewQuery.error}
        title="보유종목을 새로 불러오지 못했습니다." message="이전 조회 내역입니다. 잠시 후 다시 시도해주세요."
        onRetry={() => void previewQuery.refetch()} /> : null}
      {!positions && previewQuery.isError ? <ErrorState error={previewQuery.error} title="보유 종목을 불러오지 못했습니다." message="요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요." onRetry={() => void previewQuery.refetch()} />
        : !positions && !previewQuery.isLoading ? <InlineEmptyState message="보유 종목을 확인할 수 없습니다." /> : null}
      {futures.isError ? <ErrorState error={futures.error} title="포지션을 불러오지 못했습니다." onRetry={() => void futures.refetch()} /> : null}
      {settling ? <SectionSkeleton lines={2} /> : <>
        {order.futuresUncompared ? <Text testID="home-holdings-fx-notice" style={styles.notice}>
          환율을 확인할 수 없어 선물 포지션은 보유종목과 금액을 비교하지 않고 뒤에 표시합니다.</Text>
          : rows.length && !order.topComparable ? <InlineEmptyState message="평가금액을 확인할 수 없어 대표 보유자산을 결정할 수 없습니다." /> : null}
        {rows.map(entry => entry.kind === 'spot'
          ? <PositionAssetRow key={entry.key} position={entry.position}
            testID={TEST_IDS.home.positionItem(entry.position.assetId)} onPress={() => onOpenAsset(entry.position.assetId)} />
          : <FuturesPositionRow key={entry.key} testID={`home-futures-${entry.position.id}`}
            position={futuresHolding(entry.position)} evaluatedAt={futures.data?.evaluatedAt ?? ''} now={futures.clock}
            onPress={() => rootNavigation.navigate('MainTabs', { screen: 'MarketTab', params: { screen: 'Futures',
              params: { accountId, instrumentId: entry.position.instrumentId } } })} />)}
      </>}
      {expanded && fullQuery.isLoading ? <View testID="home-holdings-loading"><SectionSkeleton lines={2} /></View> : null}
      {expanded && fullQuery.isError ? <ErrorState title="전체 보유 종목을 불러오지 못했습니다."
        error={fullQuery.error}
        message="요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요."
        onRetry={() => void fullQuery.refetch()} /> : null}
      {positions ? valuationErrors?.map((failure, index) => (
        <AdminDiagnosticPanel key={index} diagnostic={failure.diagnostic} />
      )) : null}
      </>}
      {total + futuresCount > 1 ? <ActionPressable testID="home-holdings-toggle" feedback="button" style={styles.toggle}
        accessibilityRole="button" accessibilityLabel={expanded ? '보유종목 및 포지션 접기' : '보유종목 및 포지션 자세히 보기'}
        accessibilityState={{ expanded }} aria-expanded={expanded} onPress={() => setExpanded(value => !value)}>
        <Text style={styles.action}>{expanded ? '접기 ▲' : '자세히 보기 ▼'}</Text>
      </ActionPressable> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // No outline: the transparent 1px border keeps the content inset unchanged.
  card: { borderWidth: 1, borderColor: 'transparent', borderRadius: 14, paddingHorizontal: 16,
    paddingVertical: 10, backgroundColor: semantic.surface, gap: 4 },
  title: { fontSize: 18, lineHeight: 27, fontWeight: '700', color: semantic.text },
  notice: { fontSize: 13, lineHeight: 20, color: semantic.warning },
  toggle: { minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, backgroundColor: semantic.secondaryActionSurface },
  action: { fontSize: 13, lineHeight: 20, color: semantic.secondaryActionForeground, fontWeight: '600' },
});
