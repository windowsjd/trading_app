import React, { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { ScrollView, StyleSheet, Text, View } from '../../theme/native';
import { SafeAreaView } from '../../theme/safeArea';
import { semantic } from '../../theme/tokens';
import type { RootStackParamList } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { getOrderFailure } from '../../features/notifications/api';
import { describeOrderFailure } from '../../features/notifications/orderFailure';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { getAccountDisplay } from '../../features/tradingAccount/accountDisplay';
import { getApiErrorInfo } from '../../services/api/errorMapper';
import { formatKstDateTime } from '../../utils/format';
import CTAButton from '../../components/common/CTAButton';
import EmptyState from '../../components/states/EmptyState';
import ErrorState from '../../components/states/ErrorState';
import FullPageLoading from '../../components/states/FullPageLoading';

type Props = NativeStackScreenProps<RootStackParamList, 'OrderFailure'>;

const notFound = (error: unknown) => getApiErrorInfo(error).status === 404;

/**
 * 주문 실패·만료 — where an `order_failure` push tap lands. It reads the one
 * failure row the push names, inside the route's own account (never the
 * selected one), and words the server's stored state: a failure only when
 * the server says the row ended that way. Read-only: nothing is executed,
 * retried or canceled from here. Another user's or account's row, or one
 * that is gone, reads as not found.
 */
export default function OrderFailureScreen({ route, navigation }: Props) {
  const { accountId, kind, failureId, pushAt } = route.params;
  const { accounts, isLoading: accountsLoading } = useTradingAccount();
  const account = accounts.find((item) => item.id === accountId) ?? null;
  const query = useQuery({
    queryKey: QUERY_KEYS.tradingAccount.orderFailure(accountId, kind, failureId),
    queryFn: ({ signal }) => getOrderFailure(accountId, kind, failureId, signal),
    enabled: !!account,
    retry: (count, error) => !notFound(error) && count < 1,
  });
  const { refetch } = query;
  // A repeated tap on the same push reads the row again.
  useEffect(() => {
    if (pushAt && account) void refetch();
  }, [pushAt, account, refetch]);

  if (accountsLoading || (account && query.isLoading)) return <FullPageLoading />;
  if (!account || (query.isError && notFound(query.error))) {
    return (
      <EmptyState
        title="해당 기록을 찾을 수 없어요."
        message="이 계정에서 볼 수 없거나 더 이상 남아 있지 않은 기록이에요."
      />
    );
  }
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title="주문 결과를 불러오지 못했어요."
        message="잠시 후 다시 시도해 주세요."
        error={query.error}
        onRetry={() => void refetch()}
      />
    );
  }
  const failure = query.data;
  const accountLabel = getAccountDisplay(account).title;
  if (!failure.final) {
    return (
      <EmptyState
        title="실패로 확정된 주문이 아니에요."
        message="아직 진행 중이거나 다른 결과로 끝난 기록이에요. 주문 화면의 대기 목록에서 현재 상태를 확인해 주세요."
      />
    );
  }
  const view = describeOrderFailure(failure);
  return (
    // Below the native header; Android draws the screen under the navigation bar.
    <SafeAreaView edges={['bottom', 'left', 'right']} style={styles.screen}>
    <ScrollView testID="order-failure-screen" style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.card} accessibilityLiveRegion="polite">
        <Text style={styles.badge}>{view.status}</Text>
        <Text accessibilityRole="header" style={styles.title}>{view.title}</Text>
        <Text style={styles.meta}>
          {accountLabel} · {failure.market === 'futures' ? '선물' : '현물'}
        </Text>
        <View style={styles.section}>
          <Text style={styles.label}>사유</Text>
          <Text testID="order-failure-reason" style={styles.body}>{view.reason}</Text>
        </View>
        {view.consequence ? (
          <View style={styles.section}>
            <Text style={styles.label}>결과</Text>
            <Text style={styles.body}>{view.consequence}</Text>
          </View>
        ) : null}
        <View style={styles.section}>
          <Text style={styles.label}>종료 시각</Text>
          <Text style={styles.body}>{formatKstDateTime(failure.endedAt)}</Text>
        </View>
      </View>
      <Text style={styles.caption}>{view.where}</Text>
      {view.tradeHistory ? (
        <CTAButton
          testID="order-failure-trade-history"
          variant="neutral"
          label="거래 내역 보기"
          onPress={() => navigation.navigate('TradeHistory', { accountId, market: 'spot' })}
        />
      ) : null}
    </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: { padding: 16, gap: 12 },
  card: { padding: 16, borderRadius: 14, borderWidth: 1, borderColor: semantic.border, backgroundColor: semantic.surface, gap: 8 },
  badge: { alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, overflow: 'hidden', fontSize: 13, lineHeight: 18, fontWeight: '700', color: semantic.warning, backgroundColor: semantic.raised },
  title: { fontSize: 18, lineHeight: 26, fontWeight: '700', color: semantic.text },
  meta: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
  section: { gap: 2, marginTop: 4 },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '600', color: semantic.secondary },
  body: { fontSize: 15, lineHeight: 22, color: semantic.text },
  caption: { fontSize: 13, lineHeight: 20, color: semantic.secondary },
});
