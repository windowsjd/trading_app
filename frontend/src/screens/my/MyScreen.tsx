import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';

import type { MyScreenProps } from '../../app/navigation/types';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import { getMe } from '../../features/me/api';
import { useLogout } from '../../features/auth/useLogout';
import { getRankings, getRankingTier } from '../../features/ranking/api';
import { getMySeasonRecords } from '../../features/record/api';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import {
  ACCOUNT_INTEGRITY_TITLE,
  findAccountIntegrityFailure,
} from '../../features/tradingAccount/accountIntegrityGate';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';

type Props = MyScreenProps;

export default function MyScreen({ navigation }: Props) {
  /**
   * Rank and tier are SEASON facts (작업 10 §A-12). A user whose selected
   * account is their general account has neither, and the season dashboard
   * request is about current-season participation they do not have — so it is
   * not issued, and the two rows are not rendered as "-", which would read as
   * "you are unranked" rather than "this does not apply".
   */
  const { selectedAccount, isLoading: accountsLoading } = useTradingAccount();
  const seasonId = selectedAccount?.season?.seasonId ?? null;
  const showsSeasonUi = selectedAccount?.mode === 'season' && !!seasonId;
  const rankType =
    selectedAccount?.season?.seasonStatus === 'settled' ? 'final' : 'daily';

  const meQuery = useQuery({
    queryKey: QUERY_KEYS.me,
    queryFn: getMe,
  });

  /**
   * The rank shown here belongs to the SELECTED account's season, named
   * explicitly (작업 11 §10.1). The season dashboard would have answered for
   * whichever season is current, which is a different season as soon as the
   * user selects a past one — and a rank under the wrong season is worse than
   * no rank.
   */
  const rankingQuery = useQuery({
    queryKey: QUERY_KEYS.ranking.list({
      scope: 'near_me',
      seasonId,
      rankType,
      limit: 1,
      offset: 0,
    }),
    queryFn: () =>
      getRankings({
        scope: 'near_me',
        seasonId,
        rankType,
        limit: 1,
        offset: 0,
      }),
    enabled: !accountsLoading && showsSeasonUi,
  });

  const recordsQuery = useQuery({
    queryKey: QUERY_KEYS.record.seasons({ limit: 20, offset: 0 }),
    queryFn: () => getMySeasonRecords({ limit: 20, offset: 0 }),
  });

  const viewState = useMemo(() => {
    if (
      accountsLoading ||
      meQuery.isLoading ||
      (showsSeasonUi && rankingQuery.isLoading) ||
      recordsQuery.isLoading
    ) {
      return 'my_loading';
    }
    if (!meQuery.data || !recordsQuery.data) {
      return 'my_error';
    }
    return 'my_ready';
  }, [
    accountsLoading,
    showsSeasonUi,
    meQuery.isLoading,
    rankingQuery.isLoading,
    recordsQuery.isLoading,
    meQuery.data,
    recordsQuery.data,
  ]);

  // One shared implementation (작업 10 §B-12): it clears the WHOLE query cache,
  // not just the account-scoped keys, so no legacy financial entry survives
  // into the next user's session.
  const onLogout = useLogout();

  if (viewState === 'my_loading') {
    return <FullPageLoading message="내 정보를 불러오는 중입니다." />;
  }

  /**
   * A structural fault behind the rank must not become "-" (작업 12 §3).
   *
   * Rank and tier render as "-" whenever `myRanking` is absent, and that is
   * correct for a user who has not been ranked yet. It is badly wrong for
   * SEASON_RANKING_SCOPE_MISMATCH, which means the ranking row the server found
   * belongs to a different account than the one it was asked about.
   */
  const integrityFailure = findAccountIntegrityFailure([
    {
      section: '순위',
      isError: rankingQuery.isError,
      error: rankingQuery.error,
      retry: () => void rankingQuery.refetch(),
    },
    {
      section: '시즌 기록',
      isError: recordsQuery.isError,
      error: recordsQuery.error,
      retry: () => void recordsQuery.refetch(),
    },
  ]);

  if (integrityFailure) {
    return (
      <View
        style={styles.container}
        testID={TEST_IDS.tradingAccount.integrityError}
      >
        <ErrorState
          title={ACCOUNT_INTEGRITY_TITLE}
          message={integrityFailure.message}
          onRetry={integrityFailure.retry}
        />
      </View>
    );
  }

  if (viewState === 'my_error' || !meQuery.data || !recordsQuery.data) {
    return (
      <ErrorState
        title="내 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => {
          void meQuery.refetch();
          if (showsSeasonUi) void rankingQuery.refetch();
          void recordsQuery.refetch();
        }}
      />
    );
  }

  const me = meQuery.data;
  const myRanking = rankingQuery.data?.myRanking ?? null;
  const ranking = showsSeasonUi
    ? {
        rank:
          myRanking?.rank === undefined || myRanking?.rank === null
            ? '-'
            : String(myRanking.rank),
        tier: getRankingTier(myRanking, rankType),
      }
    : null;
  const seasonCount = recordsQuery.data.items.length;

  return (
    <SafeAreaView style={styles.container}>
      <View testID={TEST_IDS.my.screen} style={styles.content}>
        <View style={styles.card}>
          <Text style={styles.title}>{me.nickname}</Text>
          <Text style={styles.helper}>이메일 {me.email}</Text>
          {ranking ? (
            <>
              <Text style={styles.helper}>현재 등급 {ranking.tier}</Text>
              <Text style={styles.helper}>
                현재 순위 {ranking.rank === '-' ? '-' : `#${ranking.rank}`}
              </Text>
            </>
          ) : (
            <Text style={styles.helper}>
              일반 투자 계정에는 시즌 등급과 순위가 없습니다.
            </Text>
          )}
          <Text style={styles.helper}>참여 시즌 수 {seasonCount}</Text>
        </View>

        <View style={styles.card}>
          <Pressable
            testID={TEST_IDS.my.rewardMenu}
            style={styles.menuRow}
            onPress={() => navigation.navigate('Reward')}
          >
            <Text style={styles.menuText}>내 보상 / 뱃지</Text>
          </Pressable>

          <Pressable
            testID={TEST_IDS.my.settingsMenu}
            style={styles.menuRow}
            onPress={() => navigation.navigate('Settings')}
          >
            <Text style={styles.menuText}>설정</Text>
          </Pressable>

          <Pressable
            testID={TEST_IDS.my.logoutMenu}
            style={styles.menuRow}
            onPress={() => void onLogout()}
          >
            <Text style={styles.logoutText}>로그아웃</Text>
          </Pressable>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 12 },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 10,
  },
  // A long nickname or email wraps rather than running off the card.
  title: { fontSize: 22, fontWeight: '700', lineHeight: 30 },
  helper: { fontSize: 14, color: '#444', lineHeight: 21 },
  menuRow: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  menuText: { fontSize: 16, fontWeight: '600' },
  logoutText: { fontSize: 16, fontWeight: '700', color: '#c62828' },
});
