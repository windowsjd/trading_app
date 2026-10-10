import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { View, Text, StyleSheet } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import { getTradingAccountPositions } from '../../features/tradingAccount/api';
import { getAccountHoldings } from '../../features/tradingAccount/holdings';
import PositionAssetRow from '../../components/tradingAccount/PositionAssetRow';
import ActionPressable from '../../components/common/ActionPressable';
import SectionSkeleton from '../../components/states/SectionSkeleton';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import ErrorState from '../../components/states/ErrorState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { useFuturesHoldings } from '../../features/futures/useFuturesHoldings';
import FuturesPositionsSection from '../../components/tradingAccount/FuturesPositionsSection';

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
  return { accountId, expanded, setExpanded, previewQuery, fullQuery, futures };
}

export default function HomeHoldings({ holdings, onOpenAsset }: {
  holdings: ReturnType<typeof useHomeHoldings>;
  onOpenAsset: (assetId: string) => void;
}) {
  const { accountId, expanded, setExpanded, previewQuery, fullQuery, futures } = holdings;
  const rootNavigation = useRootNavigation();
  // Both responses retain the server's canonical KRW-equivalent ordering.
  // A newer complete Wallet/Home read can also supply the collapsed summary.
  const full = fullQuery.data?.tradingAccountId === accountId ? fullQuery.data : undefined;
  const preview = previewQuery.data?.tradingAccountId === accountId ? previewQuery.data : undefined;
  const useFull = full && (expanded || fullQuery.dataUpdatedAt >= previewQuery.dataUpdatedAt);
  const positions = useFull ? full.positions : preview?.positions;
  const valuationErrors = useFull ? full.valuationErrors : preview?.valuationErrors;
  const total = useFull ? full.positions.length : preview?.pagination.total ?? 0;
  const first = positions?.[0];
  const representative = first?.valuation.state !== 'unavailable' ? first : undefined;
  const rows = expanded && full ? full.positions : first ? [first] : [];
  const empty = !!positions && !previewQuery.isError && !fullQuery.isError && total === 0
    && !!futures.data && futures.data.positions.length === 0;
  return (
    <View testID="home-holdings" style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>보유종목 및 포지션</Text>
      {empty ? <InlineEmptyState title="보유종목 및 포지션이 없습니다." message="아직 보유한 종목이나 선물 포지션이 없습니다." /> : <>
      <Text accessibilityRole="header" style={styles.sectionTitle}>보유종목</Text>
      {positions && previewQuery.isError ? <ErrorState error={previewQuery.error}
        title="보유종목을 새로 불러오지 못했습니다." message="이전 조회 내역입니다. 잠시 후 다시 시도해주세요."
        onRetry={() => void previewQuery.refetch()} /> : null}
      {!positions && previewQuery.isLoading ? <SectionSkeleton lines={2} />
        : !positions && previewQuery.isError ? <ErrorState error={previewQuery.error} title="보유 종목을 불러오지 못했습니다." message="요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요." onRetry={() => void previewQuery.refetch()} />
          : !positions ? <InlineEmptyState message="보유 종목을 확인할 수 없습니다." />
            : total === 0 ? <InlineEmptyState title="보유 종목이 없습니다." message="아직 매수한 종목이 없습니다." /> : <>
              {!representative ? <InlineEmptyState message="평가금액을 확인할 수 없어 대표 보유자산을 결정할 수 없습니다." /> : null}
              {rows.map(position => <PositionAssetRow key={position.positionId} position={position}
                testID={TEST_IDS.home.positionItem(position.assetId)} onPress={() => onOpenAsset(position.assetId)} />)}
            </>}
      {expanded && fullQuery.isLoading ? <View testID="home-holdings-loading"><SectionSkeleton lines={2} /></View> : null}
      {expanded && fullQuery.isError ? <ErrorState title="전체 보유 종목을 불러오지 못했습니다."
        error={fullQuery.error}
        message="요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요."
        onRetry={() => void fullQuery.refetch()} /> : null}
      {positions ? valuationErrors?.map((failure, index) => (
        <AdminDiagnosticPanel key={index} diagnostic={failure.diagnostic} />
      )) : null}
      <FuturesPositionsSection holdings={futures} limit={expanded ? undefined : 1} testID="home-futures"
        onOpen={position => rootNavigation.navigate('MainTabs', { screen: 'MarketTab', params: { screen: 'Futures', params: { accountId, instrumentId: position.instrumentId } } })} />
      </>}
      {total > 1 || (futures.data?.positions.length ?? 0) > 1 ? <ActionPressable testID="home-holdings-toggle" feedback="button" style={styles.toggle}
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
  sectionTitle: { fontSize: 15, lineHeight: 23, fontWeight: '600' },
  toggle: { minHeight: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, backgroundColor: semantic.secondaryActionSurface },
  action: { fontSize: 13, lineHeight: 20, color: semantic.secondaryActionForeground, fontWeight: '600' },
});
