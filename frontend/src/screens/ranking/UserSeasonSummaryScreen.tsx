import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import ProfileAvatar from '../../components/common/ProfileAvatar';
import { semantic } from '../../theme/tokens';
import React, { useCallback, useEffect } from 'react';
import SeasonTitle from '../../components/tradingAccount/SeasonTitle';
import {
  AppState,
  View,
  Text,
  StyleSheet,
  ScrollView,
} from '../../theme/native';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UserSeasonSummaryDto } from '../../features/ranking/api';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';
import {
  getRankingTier,
  getUserSeasonSummary,
} from '../../features/ranking/api';
import { getFriendRelationship } from '../../features/friends/api';
import type { MeDto } from '../../features/me/api';
import { formatKrw, formatKstDateTime, formatPercent } from '../../utils/format';
import { getCompletedTradeDisplay } from '../../features/friends/completedTradeDisplay';
import { financial } from '../../theme/financialColors';
import { getApiErrorCode } from '../../services/api/errorMapper';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import InlineEmptyState from '../../components/states/InlineEmptyState';
import PositionAssetRow from '../../components/tradingAccount/PositionAssetRow';
import FuturesPositionRow from '../../components/tradingAccount/FuturesPositionRow';
import FuturesDirectionBadge from '../../components/tradingAccount/FuturesDirectionBadge';
import StandingCard from './StandingCard';
import UserFriendAction from './UserFriendAction';

/** The summary card's own entrance memory: viewing someone else never decides 내 순위's (tierStage). */
const SUMMARY_SPOTLIGHT_MEMORY = 'userSummary';

type Props = { route: { params: { userId: string } } };
export default function UserSeasonSummaryScreen({ route }: Props) {
  const { userId } = route.params;
  const focused = useIsFocused();
  const client = useQueryClient();
  // The member's own summary (a ranking row of mine) offers no friend action;
  // the signed-in member is known before any summary opens.
  const self = client.getQueryData<MeDto>(QUERY_KEYS.me)?.id === userId;
  // No polling: a friend's portfolio is read on entry, on return (screen or
  // app), on pull to refresh and on an invalidation. Each read re-checks the
  // server's friendship/privacy/season gates; the shown values are that read's.
  const query = useQuery({
    queryKey: QUERY_KEYS.ranking.userSeasonSummary(userId),
    queryFn: ({ signal }) => getUserSeasonSummary(userId, signal),
    staleTime: 0,
    refetchOnMount: 'always',
    enabled: focused,
    gcTime: 0,
  });
  // The friend action's relationship with this user id, read alongside the summary.
  const relationship = useQuery({
    queryKey: QUERY_KEYS.friends.relationship(userId),
    queryFn: ({ signal }) => getFriendRelationship(userId, signal),
    staleTime: 0,
    refetchOnMount: 'always',
    enabled: focused && !self,
  });
  const refresh = usePullToRefresh([query, { ...relationship, enabled: !self }]);
  useEffect(() => {
    if (!focused || query.isError) client.setQueryData<UserSeasonSummaryDto>(
      QUERY_KEYS.ranking.userSeasonSummary(userId),
      data => data?.portfolio ? { ...data, portfolio: null } : data,
    );
  }, [client, focused, query.data, query.isError, userId]);

  const { refetch } = query;
  const { refetch: refetchRelationship } = relationship;
  const clearFinancialCache = useCallback(() => client.setQueryData<UserSeasonSummaryDto>(
    QUERY_KEYS.ranking.userSeasonSummary(userId),
    data => data ? { ...data, portfolio: null } : data,
  ), [client, userId]);
  useFocusEffect(
    useCallback(() => {
      clearFinancialCache();
      void refetch();
      if (!self) void refetchRelationship({ cancelRefetch: false });
      return () => { clearFinancialCache(); };
    }, [clearFinancialCache, refetch, refetchRelationship, self]),
  );
  // Back from the background is a return too: the old answer is not shown
  // again before the server has re-checked the friend's permission.
  useEffect(() => {
    if (!focused) return;
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (previous !== 'active' && next === 'active') {
        clearFinancialCache();
        void refetch();
        if (!self) void refetchRelationship({ cancelRefetch: false });
      }
      previous = next;
    });
    return () => subscription.remove();
  }, [clearFinancialCache, focused, refetch, refetchRelationship, self]);
  if (query.isLoading)
    return <FullPageLoading message="유저 정보를 불러오는 중입니다." />;
  const code = getApiErrorCode(query.error);
  if (code === 'USER_NOT_FOUND' || code === 'NOT_FOUND')
    return (
      <View style={styles.content}>
        <Text testID={TEST_IDS.userSummary.notFound}>
          해당 유저 정보를 찾을 수 없습니다.
        </Text>
      </View>
    );
  if (!query.data)
    return (
      <ErrorState error={query.error}
        title="유저 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => void refetch()}
      />
    );
  const { user, season, portfolioAccess, reason } = query.data;
  // Never paint cached sensitive sections while a fresh permission check runs.
  const portfolio =
    focused && !query.isFetching && !query.isError && portfolioAccess === 'available'
      ? query.data.portfolio
      : null;
  const lockedMessage =
    query.isError ? '공개 상태를 확인하지 못했습니다. 아래로 끌어 다시 시도해주세요.' :
    portfolioAccess === 'private'
      ? '이 사용자는 포트폴리오를 비공개로 설정했습니다.'
      : portfolioAccess === 'not_friend'
        ? '친구 요청을 수락한 사용자만 포트폴리오를 볼 수 있습니다.'
        : !season
          ? '현재 시즌 정보가 없습니다.'
          : query.data.state === 'not_joined'
            ? '친구가 현재 시즌에 참가하지 않았습니다.'
            : reason === 'RANKING_HIDDEN' ||
                reason === 'PARTICIPANT_EXCLUDED'
              ? '이 사용자의 시즌 정보를 공개할 수 없습니다.'
              : '현재 시즌 포트폴리오를 이용할 수 없습니다.';
  return (
    <ScrollView
      refreshControl={refresh.refreshControl}
      testID={TEST_IDS.userSummary.screen}
      style={styles.screen}
      contentContainerStyle={styles.content}
    >
      <SeasonTitle style={styles.helper} name={season?.name ?? '현재 시즌 정보가 없습니다.'} displayBadge={season?.displayBadge} />
      {/* 내 순위's tier card (StandingCard) for THIS user: every figure is this
          read's — never the member's own; without a known tier, the plain card. */}
      <View style={self ? styles.cardOnly : undefined}>
        <StandingCard testIDPrefix="user-summary" tier={getRankingTier(season)} rankLabel="시즌 순위" rank={season?.rank}
          settled={!!season?.finalTier} figures={season}
          header={(foreground) => (
            // Same profile order as the ranking list: photo left, name right.
            <View style={styles.profile}>
              <ProfileAvatar profileImageUrl={user.profileImageUrl} size={36} testID="user-summary-avatar" />
              <Text testID="user-summary-nickname" style={[styles.nickname, foreground]}>{user.nickname}</Text>
            </View>
          )}
          spotlight={{ context: `${season?.id}|${season?.finalTier ? 'final' : 'daily'}|${user.id}`, paused: !focused, memory: SUMMARY_SPOTLIGHT_MEMORY }} />
        {self ? null : <UserFriendAction user={user} relationship={relationship} />}
      </View>
      {portfolio ? (
        <>
          <View style={styles.card}>
            <Text style={styles.label}>자산 배분</Text>
            {portfolio.allocation ? (
              <>
                <Text style={styles.helper}>
                  현금 {formatKrw(portfolio.allocation.cashKrwValue)}원
                </Text>
                <Text style={styles.helper}>
                  국내주식{' '}
                  {formatKrw(portfolio.allocation.domesticStockValueKrw)}원
                </Text>
                <Text style={styles.helper}>
                  미국주식 {formatKrw(portfolio.allocation.usStockValueKrw)}원
                </Text>
                <Text style={styles.helper}>
                  암호화폐 {formatKrw(portfolio.allocation.cryptoValueKrw)}원
                </Text>
              </>
            ) : (
              <Text style={styles.helper}>
                일부 시세를 확인할 수 없어 자산 배분과 비중을 표시할 수
                없습니다.
              </Text>
            )}
          </View>
          <View style={styles.card}>
            <Text style={styles.label}>보유종목</Text>
            {portfolio.holdings.length ? (
              portfolio.holdings.map((item) => (
                <View key={item.assetId} style={styles.row}>
                  <PositionAssetRow position={item} testID={`friend-spot-${item.assetId}`} />
                  <Text style={styles.helper}>
                    {item.weight === null
                      ? '비중 확인 불가'
                      : `자산 비중 ${formatPercent(item.weight)}%`}
                  </Text>
                </View>
              ))
            ) : (
              <Text style={styles.helper}>보유 중인 종목이 없습니다.</Text>
            )}
          </View>
          <View style={styles.card}>
            <Text style={styles.label}>포지션</Text>
            {/* A snapshot of this read, judged and labelled at the server's own
                evaluation time (no device clock): never a live value. */}
            {portfolio.futures.positions.length ? (
              <Text testID="friend-futures-read-at" style={styles.helper}>
                {formatKstDateTime(portfolio.futures.evaluatedAt)} 조회 시점 기준 평가입니다.
              </Text>
            ) : null}
            {portfolio.futures.positions.length ? portfolio.futures.positions.map(position => (
              <FuturesPositionRow key={`${position.assetId}:${position.direction}`} position={position} testID={`friend-futures-${position.assetId}`}
                evaluatedAt={portfolio.futures.evaluatedAt} now={Date.parse(portfolio.futures.evaluatedAt)} />
            )) : <Text style={styles.helper}>포지션이 없습니다.</Text>}
          </View>
          {/* 거래 완료 종목: the server's aggregates of fully closed trades (a
              server before 2026-10-20 sends none, and nothing is shown). */}
          {portfolio.completedTrades ? (
            <View style={styles.card} testID="friend-completed-trades">
              <Text style={styles.label}>거래 완료 종목</Text>
              <Text style={styles.helper}>
                모두 정리한 종목과 종료된 선물 포지션의 확정 결과예요. 실현 손익과 수익률에는 수수료가 반영돼요.
              </Text>
              {portfolio.completedTrades.items.length ? (
                portfolio.completedTrades.items.map((item, index) => {
                  const display = getCompletedTradeDisplay(item);
                  return (
                    <View key={`${item.kind}-${item.assetId}-${index}`} testID={`friend-completed-${index}`} style={styles.completedRow}>
                      <View style={styles.completedHeading}>
                        {display.direction ? (
                          <FuturesDirectionBadge testID={`friend-completed-${index}-direction`} direction={display.direction} />
                        ) : null}
                        <Text testID={`friend-completed-${index}-kind`} style={styles.completedKind}>{display.kind}</Text>
                        <Text testID={`friend-completed-${index}-name`} style={styles.completedName}>{display.name}</Text>
                      </View>
                      {display.subline ? <Text style={styles.helper}>{display.subline}</Text> : null}
                      <Text testID={`friend-completed-${index}-basis`} style={styles.helper}>{`${display.basisLabel} ${display.basis}`}</Text>
                      <Text testID={`friend-completed-${index}-result`}
                        style={[styles.completedResult, { color: display.pnlDirection === 'neutral' ? semantic.text : financial[display.pnlDirection] }]}>
                        {`실현 손익 ${display.pnl} · 수익률 ${display.returnRate}`}
                      </Text>
                    </View>
                  );
                })
              ) : (
                <Text style={styles.helper}>아직 모두 정리한 종목이 없어요.</Text>
              )}
              {portfolio.completedTrades.hasMore ? (
                <Text testID="friend-completed-more" style={styles.helper}>
                  최근 {portfolio.completedTrades.items.length}개만 보여드려요.
                </Text>
              ) : null}
            </View>
          ) : null}
        </>
      ) : (
        <InlineEmptyState
          title={query.isFetching ? '공개 상태 확인 중' : '포트폴리오'}
          message={
            query.isFetching
              ? '최신 공개 설정을 확인하고 있습니다.'
              : lockedMessage
          }
        />
      )}
      {query.isError ? <AdminDiagnosticPanel error={query.error} /> : null}
    </ScrollView>
  );
}
const styles = StyleSheet.create({
  // The ranking tab's 내 순위 profile: 36 photo, 18/26 bold name.
  profile: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1 },
  nickname: { flex: 1, minWidth: 0, fontSize: 18, lineHeight: 26, fontWeight: '700' },
  // StandingCard keeps 12 below itself; without the friend action the screen's gap already does.
  cardOnly: { marginBottom: -12 },
  screen: { flex: 1, backgroundColor: semantic.screen },
  content: { padding: 16, paddingBottom: 32, gap: 12 },
  card: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    padding: 16,
    backgroundColor: semantic.surface,
    gap: 10,
  },
  label: { fontSize: 17, fontWeight: '700' },
  helper: { fontSize: 14, color: semantic.secondary, flexShrink: 1 },
  row: {
    gap: 4,
    paddingVertical: 10,
  },
  completedRow: { gap: 3, paddingVertical: 10, borderTopWidth: 1, borderTopColor: semantic.border },
  completedHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 6, rowGap: 2 },
  completedKind: { fontSize: 12, lineHeight: 18, fontWeight: '700', color: semantic.secondary },
  completedName: { minWidth: 0, flexShrink: 1, fontSize: 16, lineHeight: 24, fontWeight: '700' },
  completedResult: { fontSize: 14, lineHeight: 21, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
