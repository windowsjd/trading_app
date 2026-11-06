import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from '@react-navigation/native';
import { FlatList, Text, View } from '../../theme/native';
import { semantic } from '../../theme/tokens';
import { financial } from '../../theme/financialColors';
import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import ActionPressable from '../../components/common/ActionPressable';
import CTAButton from '../../components/common/CTAButton';
import ErrorNotice from '../../components/states/ErrorNotice';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import FuturesDirectionBadge from '../../components/tradingAccount/FuturesDirectionBadge';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getCompletedTradeDisplay } from '../../features/friends/completedTradeDisplay';
import { getCompletedTrades, type CompletedTrade } from '../../features/tradingAccount/api';
import { getCompletedTradeMeta } from '../../features/share/tradeShareDisplay';
import TradeShareSheet from './TradeShareSheet';

/**
 * 거래 내역 › 거래 완료: the pinned account's confirmed completed trades — a
 * holding sold to zero, a closed futures lifetime — newest first, each with
 * 공유 for its 수익 공유 card. Read from the owner API (backend
 * docs/completed-trades-share-contract.md) for exactly this account; the
 * figures are the same 거래 완료 종목 policy a friend's season shows.
 */
export default function CompletedTrades({ accountId, header }: { accountId: string; header: React.ReactElement }) {
  const focused = useIsFocused();
  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.completedTrades(accountId),
    queryFn: ({ signal }) => getCompletedTrades(accountId, signal),
    enabled: focused,
    retry: false,
  });
  const refresh = usePullToRefresh([query]);
  const [sharing, setSharing] = useState<CompletedTrade | null>(null);
  // A read about another account never reaches this list (the API checks it, the key pins it).
  const data = query.data?.tradingAccountId === accountId ? query.data : null;

  return (
    <View style={styles.fill}>
      <FlatList
        testID="completed-trades-list"
        refreshControl={refresh.refreshControl}
        data={data?.items ?? []}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <View style={styles.header}>
            {header}
            <Text style={styles.helper}>
              모두 정리한 종목과 종료된 선물 포지션의 확정 결과예요. 실현 손익과 수익률에는 수수료가 반영돼요. 공유를 누르면 수익 카드를 만들 수 있어요.
            </Text>
          </View>
        }
        ListEmptyComponent={
          query.isError ? (
            <View style={styles.state}>
              <ErrorNotice testID="completed-trades-error" error={query.error} message="거래 완료 내역을 불러오지 못했습니다." style={styles.error} />
              <CTAButton testID="completed-trades-retry" label="다시 불러오기" variant="secondary" onPress={() => void query.refetch()} />
            </View>
          ) : !data ? (
            <Text testID="completed-trades-loading" style={styles.helper}>거래 완료 내역을 불러오고 있습니다.</Text>
          ) : (
            <InlineEmptyState testID="completed-trades-empty" title="아직 거래를 모두 마친 종목이 없어요."
              message="보유 수량을 모두 매도하거나 선물 포지션을 종료하면 여기에서 결과를 공유할 수 있어요." />
          )
        }
        ListFooterComponent={data?.hasMore ? (
          <Text testID="completed-trades-more" style={styles.helper}>최근 {data.items.length}개만 보여드려요.</Text>
        ) : null}
        renderItem={({ item }) => <CompletedTradeRow trade={item} onShare={() => setSharing(item)} />}
      />
      <TradeShareSheet accountId={accountId} trade={sharing} onClose={() => setSharing(null)} />
    </View>
  );
}

function CompletedTradeRow({ trade, onShare }: { trade: CompletedTrade; onShare: () => void }) {
  const display = getCompletedTradeDisplay(trade);
  const meta = getCompletedTradeMeta(trade);
  const testID = `completed-trade-${trade.key}`;
  return (
    <View testID={testID} style={styles.row}>
      <View style={styles.rowBody}>
        <View style={styles.heading}>
          {display.direction ? <FuturesDirectionBadge testID={`${testID}-direction`} direction={display.direction} /> : null}
          <Text style={styles.kind}>{display.kind}</Text>
          <Text testID={`${testID}-name`} style={styles.name}>{display.name}</Text>
        </View>
        {display.subline ? <Text style={styles.helper}>{display.subline}</Text> : null}
        <Text testID={`${testID}-meta`} style={styles.helper}>
          {[`${meta.completedAt} 완료`, meta.leverage, meta.ended].filter(Boolean).join(' · ')}
        </Text>
        <Text testID={`${testID}-basis`} style={styles.helper}>{`${display.basisLabel} ${display.basis}`}</Text>
        <Text testID={`${testID}-result`}
          style={[styles.result, { color: display.pnlDirection === 'neutral' ? semantic.text : financial[display.pnlDirection] }]}>
          {`실현 손익 ${display.pnl} · 수익률 ${display.returnRate}`}
        </Text>
      </View>
      <ActionPressable testID={`${testID}-share`} accessibilityRole="button" accessibilityLabel={`${display.name} 수익 공유`}
        onPress={onShare} style={styles.share}>
        <Text style={styles.shareText}>공유</Text>
      </ActionPressable>
    </View>
  );
}

// Plain objects: harnesses load history screens with minimal native mocks. A
// long name wraps in its own column; the share button keeps its 44dp target.
const styles = {
  fill: { flex: 1 },
  content: { padding: 16, paddingBottom: 24, gap: 10 },
  header: { gap: 8, marginBottom: 2 },
  state: { gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderColor: semantic.border, borderRadius: 14,
    padding: 14, backgroundColor: semantic.surface },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 2 },
  kind: { fontSize: 12, lineHeight: 18, fontWeight: '700', color: semantic.secondary },
  name: { minWidth: 0, flexShrink: 1, fontSize: 16, lineHeight: 24, fontWeight: '700', color: semantic.text },
  result: { fontSize: 14, lineHeight: 21, fontWeight: '600', fontVariant: ['tabular-nums'] as 'tabular-nums'[] },
  helper: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  error: { fontSize: 13, lineHeight: 20, color: semantic.error },
  share: { minHeight: 44, minWidth: 60, paddingHorizontal: 14, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: semantic.raised, borderWidth: 1, borderColor: semantic.border },
  shareText: { fontSize: 14, lineHeight: 21, fontWeight: '700', color: semantic.text },
} as const;
