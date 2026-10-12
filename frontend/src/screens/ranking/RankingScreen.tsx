import { usePullToRefresh } from '../../hooks/usePullToRefresh';
import { semantic } from '../../theme/tokens';
import { getScreenContentStyle } from '../../theme/screenLayout';
import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
  ScrollView,
  Platform,
  useWindowDimensions,
} from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';

import type { RankingScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import { getCurrentSeason } from '../../features/season/api';
import {
  getRankingTier,
  getRankings,
  type MyRankingDto,
  type RankingItemDto,
  type RankingRankType,
  type RankingScope,
} from '../../features/ranking/api';
import { ERROR_CODE } from '../../models/enums/errorCode';
import { getApiErrorCode } from '../../services/api/errorMapper';
import { formatKrw } from '../../utils/format';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import EmptyState from '../../components/states/EmptyState';
import CTAButton from '../../components/common/CTAButton';
import ProfileAvatar from '../../components/common/ProfileAvatar';
import SegmentedControl from '../../components/common/SegmentedControl';
import { getMe, type MeDto } from '../../features/me/api';
import WhaleLoader from '../../components/states/WhaleLoader';
import { getRecordFinancialDisplay } from '../../features/record/financialDisplay';
import { useAppearance, type AppearanceMode } from '../../theme/appearance';
import { getHomeTier } from '../home/tierPresentation';
import TierCard, { tierForeground, type TierPresentation } from '../home/TierCard';
import RankingTierRowBackground, { RANKING_ROW_RADIUS } from './RankingTierRowBackground';
import { getFinancialColors } from '../../theme/financialColors';

type Props = RankingScreenProps;

const TABS: Array<{ key: RankingScope; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'friends', label: '친구' },
  { key: 'top10', label: 'TOP10' },
];

function getRankingItemKey(item: RankingItemDto) {
  return item.seasonParticipantId;
}

export default function RankingScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();
  const queryClient = useQueryClient();
  const meQuery = useQuery({ queryKey: QUERY_KEYS.me, queryFn: getMe, staleTime: 60_000 });
  const [selectedTab, setSelectedTab] = React.useState<RankingScope>('all');
  const snapshotResetAttemptRef = React.useRef(0);
  const rankingLimit = selectedTab === 'top10' ? 10 : 50;
  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });
  // The API defaults to daily, including settled seasons. Select final explicitly
  // after settlement, then pin every scope to this canonical publication. Its
  // rows are no longer drawn (the list shows the top rankers); it supplies the
  // publication and my ranking.
  const publicationRankType: RankingRankType = seasonQuery.data?.status === 'settled' ? 'final' : 'daily';
  const publicationParams = { scope: 'all' as const, seasonId: seasonQuery.data?.id, rankType: publicationRankType, limit: 3, offset: 0 };
  const topQuery = useQuery({
    queryKey: QUERY_KEYS.ranking.list(publicationParams),
    queryFn: () => getRankings(publicationParams),
    enabled: !!seasonQuery.data,
    refetchInterval: (query) =>
      query.state.data?.rankType === 'final' || seasonQuery.data?.status === 'settled'
        ? false : 60_000,
  });
  const publication = topQuery.data;
  const rankType = publication?.rankType;
  const seasonId = publication?.season?.id;
  const rankingDate = publication?.rankingDate;
  const capturedAt = publication?.capturedAt;
  const rankingQueryKey = useMemo(
    () => QUERY_KEYS.ranking.infiniteList({
      scope: selectedTab, limit: rankingLimit, offset: 0,
      seasonId, rankType, rankingDate, capturedAt,
    }),
    [selectedTab, rankingLimit, seasonId, rankType, rankingDate, capturedAt],
  );

  const rankingQuery = useInfiniteQuery({
    queryKey: rankingQueryKey,
    enabled: publication?.state === 'available',
    queryFn: ({ pageParam }) =>
      getRankings({
        scope: selectedTab,
        seasonId,
        limit: rankingLimit,
        offset: pageParam.offset,
        rankType: pageParam.rankType,
        rankingDate: pageParam.rankingDate,
        capturedAt: pageParam.capturedAt,
      }),
    getNextPageParam: (lastPage) => {
      const nextOffset = lastPage.pagination.nextOffset;
      if (nextOffset === null || nextOffset === undefined) return undefined;

      return {
        offset: nextOffset,
        rankType: lastPage.rankType,
        rankingDate: lastPage.rankingDate ?? null,
        capturedAt: lastPage.capturedAt ?? null,
      };
    },
    initialPageParam: {
      offset: 0,
      rankType,
      rankingDate: rankingDate ?? null,
      capturedAt: capturedAt ?? null,
    },
  });
  const refresh = usePullToRefresh([seasonQuery, meQuery, {
    isFetching: topQuery.isFetching || rankingQuery.isFetching,
    refetch: async () => {
      const latest = await topQuery.refetch();
      if (latest.data?.season?.id === seasonId && latest.data?.rankType === rankType &&
          latest.data?.rankingDate === rankingDate && latest.data?.capturedAt === capturedAt) {
        await rankingQuery.refetch();
      }
      // A new publication changes the list key and loads its first page.
    },
  }]);

  const items = useMemo(() => {
    const byKey = new Map<string, RankingItemDto>();

    rankingQuery.data?.pages.forEach((page) => {
      page.rankings.forEach((item) => {
        byKey.set(getRankingItemKey(item), item);
      });
    });

    return Array.from(byKey.values());
  }, [rankingQuery.data]);

  const myRanking = publication?.myRanking ?? null;
  const hasNotJoined = myRanking?.state === 'not_joined' || seasonQuery.data?.joined === false;
  const rankingErrorCode = getApiErrorCode(rankingQuery.error);
  const seasonNotConfigured = getApiErrorCode(seasonQuery.error) === ERROR_CODE.SEASON_NOT_FOUND;

  React.useEffect(() => {
    snapshotResetAttemptRef.current = 0;
  }, [selectedTab]);

  React.useEffect(() => {
    if (rankingQuery.isSuccess) {
      snapshotResetAttemptRef.current = 0;
    }
  }, [
    rankingQuery.isSuccess,
    rankingQueryKey,
  ]);

  const refetchRankings = topQuery.refetch;
  React.useEffect(() => {
    if (rankingErrorCode !== ERROR_CODE.RANKING_SNAPSHOT_CHANGED) return;
    if (snapshotResetAttemptRef.current > 0) return;

    snapshotResetAttemptRef.current += 1;
    void refetchRankings().then(() =>
      queryClient.resetQueries({ queryKey: rankingQueryKey, exact: true }),
    );
  }, [queryClient, rankingErrorCode, refetchRankings, rankingQueryKey]);

  const viewState = useMemo(() => {
    if (seasonQuery.isLoading || topQuery.isLoading) {
      return 'ranking_loading';
    }

    if (seasonNotConfigured) return topQuery.isError ? 'ranking_error' : 'ranking_unavailable';

    if (!seasonQuery.data || !topQuery.data) {
      return 'ranking_error';
    }

    if (publication?.state === 'unavailable') return 'ranking_unavailable';
    if (!items.length) return 'ranking_empty';
    if (rankingQuery.isFetchingNextPage) return 'ranking_paginating';
    if (rankType === 'final' || seasonQuery.data.status === 'settled') {
      return 'ranking_settled';
    }
    if (myRanking?.state === 'not_joined' || !seasonQuery.data.joined) {
      return 'ranking_partial_unjoined';
    }

    return 'ranking_ready';
  }, [
    seasonQuery.isLoading,
    seasonQuery.data,
    seasonNotConfigured,
    topQuery.isLoading,
    topQuery.isError,
    topQuery.data,
    rankingQuery.isError,
    rankingQuery.data,
    rankingQuery.isFetchingNextPage,
    rankingErrorCode,
    publication?.state,
    items.length,
    rankType,
    myRanking?.state,
  ]);

  if (viewState === 'ranking_loading') {
    return <FullPageLoading message="랭킹을 불러오는 중입니다." />;
  }

  if (viewState === 'ranking_error') {
    return (
      <ErrorState error={seasonQuery.isError && !seasonNotConfigured ? seasonQuery.error : topQuery.error}
        title="랭킹을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => {
          void seasonQuery.refetch();
          void topQuery.refetch();
        }}
      >
        {seasonQuery.isError && !seasonNotConfigured && topQuery.isError ? <AdminDiagnosticPanel error={topQuery.error} /> : null}
      </ErrorState>
    );
  }

  if (viewState === 'ranking_unavailable') {
    return (
      <ScrollView refreshControl={refresh.refreshControl} style={styles.container} contentContainerStyle={styles.content}>
        <EmptyState
          title={seasonNotConfigured ? '현재 진행 중인 시즌이 없습니다.' : '랭킹 생성 대기 중입니다.'}
          message={seasonNotConfigured ? '시즌이 열리고 랭킹이 생성되면 이곳에 표시됩니다.' : '랭킹 스냅샷이 생성되면 이곳에 표시됩니다.'}
          actionLabel={hasNotJoined && !seasonNotConfigured ? '시즌 참가하기' : undefined}
          onAction={hasNotJoined && !seasonNotConfigured ? () => rootNavigation.navigate('SeasonJoin') : undefined}
        />
      </ScrollView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        refreshControl={refresh.refreshControl}
        testID={TEST_IDS.ranking.screen}
        data={rankingErrorCode === ERROR_CODE.RANKING_SNAPSHOT_CHANGED ? [] : items}
        keyExtractor={getRankingItemKey}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (rankingQuery.hasNextPage && !rankingQuery.isFetching) {
            void rankingQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <>
            <MyRankingCard
              me={meQuery.data}
              myRanking={myRanking}
              rankType={rankType}
              viewState={viewState}
              onJoin={() => rootNavigation.navigate('SeasonJoin')}
            />

            <SegmentedControl testID="ranking-tabs" accessibilityLabel="랭킹 범위" value={selectedTab} onChange={setSelectedTab}
              style={styles.tabs}
              options={TABS.map(tab => ({ key: tab.key, label: tab.label, testID: tab.key === 'all' ? TEST_IDS.ranking.tabAll
                : tab.key === 'friends' ? TEST_IDS.ranking.tabFriends : TEST_IDS.ranking.tabTop10 }))} />
          </>
        }
        ListEmptyComponent={
          rankingQuery.isLoading ? <WhaleLoader size={28} accessibilityLabel="목록을 불러오는 중입니다." /> :
          rankingQuery.isError ? <ErrorState error={rankingQuery.error} title="목록을 불러오지 못했습니다."
            onRetry={() => {
              void topQuery.refetch().then(() => queryClient.resetQueries({ queryKey: rankingQueryKey, exact: true }));
            }} /> : selectedTab === 'friends' ? (
            <EmptyState
              title="현재 시즌 랭킹에 표시할 친구가 없습니다."
              message="친구를 추가하거나 친구의 시즌 참가를 기다려주세요."
              actionLabel="친구 찾기"
              onAction={() => navigation.navigate('MyTab', { screen: 'Friends' })}
            />
          ) : (
            <EmptyState
              title="아직 랭킹 데이터가 없습니다."
              message="참가자가 쌓이면 랭킹이 표시됩니다."
            />
          )
        }
        renderItem={({ item }) => (
          <RankingRow
            item={item}
            rankType={rankType}
            onPress={() =>
              navigation.navigate('UserSeasonSummary', {
                userId: item.userId,
              })
            }
          />
        )}
        ListFooterComponent={
          rankingQuery.isFetchingNextPage ? (
            <View style={styles.footerLoader}>
              <WhaleLoader size={28} />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

function MyRankingCard({
  me,
  myRanking,
  rankType,
  viewState,
  onJoin,
}: {
  me?: MeDto;
  myRanking: MyRankingDto | null;
  rankType?: RankingRankType;
  viewState: string;
  onJoin: () => void;
}) {
  if (myRanking?.state === 'not_joined' || viewState === 'ranking_partial_unjoined') {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>아직 이번 시즌에 참가하지 않았습니다.</Text>
        <Text style={styles.helper}>
          랭킹은 볼 수 있지만 내 순위는 참가 후 반영됩니다.
        </Text>

        <CTAButton label="시즌 참가하기" onPress={onJoin} />
      </View>
    );
  }

  if (myRanking?.state === 'unavailable') {
    return (
      <View style={styles.card}>
        <Text style={styles.label}>내 순위</Text>
        <Text style={styles.helper}>내 랭킹 생성 대기 중입니다.</Text>
      </View>
    );
  }

  const availableRanking = myRanking?.state === 'available' ? myRanking : null;
  return <MyStandingCard me={me} ranking={availableRanking} rankType={rankType} />;
}

/**
 * 내 순위 in the season tier card's design (Home's former card), without the
 * account change action or season name: profile, rank and tier. The return
 * rate stays in the list rows. Without a known tier it keeps the same
 * information on a plain card.
 */
function MyStandingCard({ me, ranking, rankType }: { me?: MeDto; ranking: Extract<MyRankingDto, { state: 'available' }> | null; rankType?: RankingRankType }) {
  const { mode } = useAppearance();
  const { width } = useWindowDimensions();
  const tier = getHomeTier(getRankingTier(ranking, rankType), mode);
  const foreground = tier ? tierForeground(tier, mode) : undefined;
  const content = (
    <>
      <Text style={[styles.label, foreground && styles.onArtLabel, foreground]}>내 순위</Text>
      {me ? (
        <View style={styles.profile}>
          <ProfileAvatar profileImageUrl={me.profileImageUrl} size={36} testID="ranking-my-avatar" />
          <Text style={[styles.myName, foreground]}>{me.nickname}</Text>
        </View>
      ) : null}
      <Text testID="ranking-my-rank" style={[styles.myRank, foreground]}>{ranking ? `#${ranking.rank}` : '-'}</Text>
      {rankType === 'final' ? <Text style={[styles.settledText, foreground && styles.onArtSettled]}>최종 랭킹 확정</Text> : null}
    </>
  );
  if (!tier) {
    return <View testID="ranking-my-card" style={styles.card}>{content}</View>;
  }
  return (
    <View style={styles.myCard}>
      <TierCard testID="ranking-my-card" tier={tier} mode={mode} emblemSize={width < 360 ? 104 : 124}
        caption={<Text testID="ranking-my-tier" style={[styles.tierCaption, foreground]}>{tier.name}</Text>}>
        {content}
      </TierCard>
    </View>
  );
}

/**
 * Figures sit directly on the metal. Choose direction colors for the actual
 * surface (Whale is dark even in Light), keeping the user's financial palette.
 */
function RankingFigures({ item, tier, mode }: { item: RankingItemDto; tier: TierPresentation | null; mode: AppearanceMode }) {
  const { financialPreference } = useAppearance();
  const rate = getRecordFinancialDisplay(item.returnRate, 'rate');
  const total = `${formatKrw(item.totalAssetKrw)}원`;
  const foreground = tier ? tierForeground(tier, mode) : undefined;
  const darkSurface = mode === 'dark' || tier?.id === 'whale';
  const direction = getFinancialColors(darkSurface ? 'dark' : 'light', financialPreference);
  const sign = Number(item.returnRate);
  const directional = rate.text !== '-' && sign !== 0;
  // Tint/shade the existing hue only on artwork, whose luminance differs from
  // the screen. Neutral and unavailable rates use the tier's normal foreground.
  const ink = directional ? (sign > 0 ? direction.rise : direction.fall) : foreground?.color;
  const color = tier && ink && directional
    ? shadeFinancialInk(String(ink), darkSurface, tier.id === 'diamond') : ink ?? rate.color;
  return (
    <View testID={`ranking-figures-${item.userId}`} style={styles.figures}
      accessible accessibilityLabel={`${tier ? `${tier.name} 티어, ` : ''}수익률 ${rate.text}, 총자산 ${total}`}>
      <Text testID={`ranking-return-${item.userId}`} style={[styles.returnValue, foreground, { color }]}>{rate.text}</Text>
      <Text testID={`ranking-total-${item.userId}`} style={[styles.totalAsset, foreground]}>{total}</Text>
    </View>
  );
}

function shadeFinancialInk(hex: string, dark: boolean, diamond: boolean) {
  const amount = dark ? .55 : diamond ? .6 : .55;
  const target = dark ? 255 : 0;
  return `#${[1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount) + target * amount)
    .toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Each row is drawn as its tier's card, redrawn for the row's wide, short
 * shape (RankingTierRowBackground); the emblem stays on 내 순위 only. Unknown
 * tiers keep the plain card.
 */
function RankingRow({
  item,
  rankType,
  onPress,
}: {
  item: RankingItemDto;
  rankType?: RankingRankType;
  onPress: () => void;
}) {
  const { mode } = useAppearance();
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > 1.3;
  const tier = getHomeTier(getRankingTier(item, rankType), mode);
  const foreground = tier ? tierForeground(tier, mode) : undefined;
  return (
    <ActionPressable
      testID={TEST_IDS.ranking.item(item.userId)}
      style={[styles.rankRow, tier && { borderWidth: 0, backgroundColor: tier.palette.backgroundColor }]}
      underlay={tier ? <RankingTierRowBackground tier={tier.id} mode={mode} /> : null}
      onPress={onPress}
    >
      <View style={[styles.rankLeft, stacked && styles.rankLeftStacked]}>
        <Text style={[styles.rankNumber, foreground]}>#{item.rank}</Text>
        <View style={[styles.profile, stacked && styles.rowProfileStacked]}>
          <ProfileAvatar profileImageUrl={item.profileImageUrl} size={32} testID={`ranking-avatar-${item.userId}`} />
          <Text style={[styles.name, foreground]}>{item.nickname}</Text>
        </View>
      </View>

      <RankingFigures item={item} tier={tier} mode={mode} />
    </ActionPressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, paddingBottom: 24 },
  card: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    padding: 16,
    backgroundColor: semantic.surface,
    gap: 8,
    marginBottom: 12,
  },
  tabs: { marginBottom: 12 },
  myCard: { marginBottom: 12 },
  onArtLabel: { fontWeight: '700' },
  onArtSettled: { fontWeight: '800' },
  myName: { flex: 1, minWidth: 0, fontSize: 18, lineHeight: 26, fontWeight: '700' },
  myRank: { fontSize: 32, lineHeight: 40, fontWeight: '800', fontVariant: ['tabular-nums'] },
  tierCaption: { fontSize: 15, lineHeight: 22, fontWeight: '800', textAlign: 'center' },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1 },
  // Only when the figures cannot fit beside the name (narrow screens at large
  // text) do they wrap under it; long values remain fully visible.
  figures: { marginLeft: 'auto', flexShrink: 1, minWidth: 0, maxWidth: '100%', alignItems: 'stretch', gap: 2 },
  // The app's percent figures: system font, regular weight, tabular digits.
  // Only the size (18) keeps the ranking's emphasis.
  returnValue: { fontSize: 18, lineHeight: 26, textAlign: 'right', fontVariant: ['tabular-nums'] },
  totalAsset: { fontSize: 15, lineHeight: 22, fontWeight: '600', textAlign: 'right', fontVariant: ['tabular-nums'] },
  title: { fontSize: 22, fontWeight: '700' },
  label: { fontSize: 13, color: semantic.secondary },
  big: { fontSize: 24, fontWeight: '700' },
  helper: { fontSize: 14, color: semantic.secondary },
  settledText: { color: semantic.error, fontWeight: '700' },
  rankRow: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: RANKING_ROW_RADIUS,
    paddingVertical: 12,
    paddingHorizontal: 14,
    backgroundColor: semantic.surface,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  rankLeft: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'center',
    flexGrow: 1,
    flexShrink: 1,
    // Rank, avatar and a readable name; below this the figures wrap instead.
    flexBasis: 106,
    minWidth: 0,
  },
  rankNumber: { minWidth: 28, flexShrink: 0, fontSize: 20, lineHeight: 28, fontWeight: '800', textAlign: 'center', fontVariant: ['tabular-nums'] },
  rankLeftStacked: { flexBasis: '100%', flexDirection: 'column', alignItems: 'flex-start', gap: 6 },
  rowProfileStacked: { alignSelf: 'stretch', alignItems: 'flex-start' },
  name: { flex: 1, minWidth: 0, fontSize: 15, lineHeight: 22, fontWeight: '700' },
  footerLoader: { paddingVertical: 16 },
});
