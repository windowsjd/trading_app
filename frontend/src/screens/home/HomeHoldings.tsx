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
  return { expanded, setExpanded, previewQuery, fullQuery };
}

export default function HomeHoldings({ holdings, onOpenAsset }: {
  holdings: ReturnType<typeof useHomeHoldings>;
  onOpenAsset: (assetId: string) => void;
}) {
  const { expanded, setExpanded, previewQuery, fullQuery } = holdings;
  // Both responses retain the server's canonical KRW-equivalent ordering.
  // A newer complete Wallet/Home read can also supply the collapsed summary.
  const useFull = fullQuery.data && (expanded || fullQuery.dataUpdatedAt >= previewQuery.dataUpdatedAt);
  const positions = useFull ? fullQuery.data.positions : previewQuery.data?.positions;
  const total = useFull ? positions.length : previewQuery.data?.pagination.total ?? 0;
  const first = positions?.[0];
  const representative = first?.valuation.state !== 'unavailable' ? first : undefined;
  const rows = expanded && fullQuery.data ? fullQuery.data.positions
    : representative ? [representative] : total === 1 && first ? [first] : [];
  return (
    <View testID="home-holdings" style={styles.card}>
      <Text accessibilityRole="header" style={styles.title}>보유 종목</Text>
      {!positions && previewQuery.isLoading ? <SectionSkeleton lines={2} />
        : !positions && previewQuery.isError ? <ErrorState title="보유 종목을 불러오지 못했습니다." onRetry={() => void previewQuery.refetch()} />
          : !positions ? <InlineEmptyState message="보유 종목을 확인할 수 없습니다." />
            : total === 0 ? <InlineEmptyState title="보유 종목이 없습니다." message="아직 매수한 종목이 없습니다." /> : <>
              {!representative ? <InlineEmptyState message="평가금액을 확인할 수 없어 대표 보유자산을 결정할 수 없습니다." /> : null}
              {rows.map(position => <PositionAssetRow key={position.positionId} position={position}
                testID={TEST_IDS.home.positionItem(position.assetId)} onPress={() => onOpenAsset(position.assetId)} />)}
            </>}
      {expanded && fullQuery.isLoading ? <View testID="home-holdings-loading"><SectionSkeleton lines={2} /></View> : null}
      {expanded && fullQuery.isError ? <ErrorState title="전체 보유 종목을 불러오지 못했습니다."
        onRetry={() => void fullQuery.refetch()} /> : null}
      {total > 1 ? <ActionPressable testID="home-holdings-toggle" style={styles.toggle}
        accessibilityRole="button" accessibilityLabel={expanded ? '보유 종목 접기' : '보유 종목 자세히 보기'}
        accessibilityState={{ expanded }} aria-expanded={expanded} onPress={() => setExpanded(value => !value)}>
        <Text style={styles.action}>{expanded ? '접기 ▲' : '자세히 보기 ▼'}</Text>
      </ActionPressable> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: semantic.border, borderRadius: 14, paddingHorizontal: 16,
    paddingVertical: 10, backgroundColor: semantic.surface, gap: 4 },
  title: { fontSize: 18, lineHeight: 27, fontWeight: '700', color: semantic.text },
  toggle: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, backgroundColor: semantic.secondaryActionSurface },
  action: { fontSize: 13, lineHeight: 20, color: semantic.secondaryActionForeground, fontWeight: '600' },
});
