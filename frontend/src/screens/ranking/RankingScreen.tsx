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
import { useIsFocused } from '@react-navigation/native';
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
import { useRankingInsights } from '../../features/ranking/useRankingInsights';
import { ERROR_CODE } from '../../models/enums/errorCode';
import { getApiErrorCode } from '../../services/api/errorMapper';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import AdminDiagnosticPanel from '../../components/states/AdminDiagnosticPanel';
import EmptyState from '../../components/states/EmptyState';
import CTAButton from '../../components/common/CTAButton';
import ProfileAvatar from '../../components/common/ProfileAvatar';
import SegmentedControl from '../../components/common/SegmentedControl';
import { getMe, type MeDto } from '../../features/me/api';
import WhaleLoader from '../../components/states/WhaleLoader';
import { useAppearance } from '../../theme/appearance';
import { getHomeTier, type HomeTier } from '../home/tierPresentation';
import TierEmblem, { tierEmblemWidth } from '../home/TierEmblem';
import RankingInsightSlot from './RankingInsightSlot';
import StandingCard, { rankingFigureText } from './StandingCard';

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
  const isFocused = useIsFocused();
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
  // 순위 안내: always the whole daily ranking of this publication, whatever tab.
  const insights = useRankingInsights({ publication, season: seasonQuery.data });
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
              seasonId={seasonId}
              focused={isFocused}
              viewState={viewState}
              onJoin={() => rootNavigation.navigate('SeasonJoin')}
            />

            <RankingInsightSlot messages={insights} paused={!isFocused} />

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
            mine={myRanking?.state === 'available' && item.seasonParticipantId === myRanking.seasonParticipantId}
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
  seasonId,
  focused,
  viewState,
  onJoin,
}: {
  me?: MeDto;
  myRanking: MyRankingDto | null;
  rankType?: RankingRankType;
  seasonId?: string;
  focused: boolean;
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
  return <MyStandingCard me={me} ranking={availableRanking} rankType={rankType} seasonId={seasonId} focused={focused} />;
}

/**
 * 내 순위 on the season tier card (StandingCard, shared with 내 뱃지): the
 * profile, 내 순위 with the rank, then the return rate and total assets of my
 * ranking row, as the list shows them.
 */
function MyStandingCard({ me, ranking, rankType, seasonId, focused }: {
  me?: MeDto; ranking: Extract<MyRankingDto, { state: 'available' }> | null; rankType?: RankingRankType; seasonId?: string; focused: boolean;
}) {
  return (
    <StandingCard testIDPrefix="ranking-my" tier={getRankingTier(ranking, rankType)} rankLabel="내 순위" rank={ranking?.rank}
      settled={rankType === 'final'} figures={ranking}
      header={(foreground) => me ? (
        <View style={styles.profile}>
          <ProfileAvatar profileImageUrl={me.profileImageUrl} size={36} testID="ranking-my-avatar" />
          <Text style={[styles.myName, foreground]}>{me.nickname}</Text>
        </View>
      ) : null}
      // The tier is read from this publication's season and rank type for me: a tier change within them
      // replays the emblem's entrance; another season, daily → final or another account only re-anchors it.
      spotlight={{ context: `${seasonId}|${rankType}|${ranking?.seasonParticipantId}`, paused: !focused }} />
  );
}

/**
 * Return rate and total assets on the plain row card, in the app's financial
 * colors. The label also names my row and the tier.
 */
function RankingFigures({ item, tierName, mine }: { item: RankingItemDto; tierName?: string; mine: boolean }) {
  const { rate, total } = rankingFigureText(item);
  return (
    <View testID={`ranking-figures-${item.userId}`} style={styles.figures}
      accessible accessibilityLabel={`${mine ? '내 순위, ' : ''}${tierName ? `${tierName} 티어, ` : ''}수익률 ${rate.text}, 총자산 ${total}`}>
      <Text testID={`ranking-return-${item.userId}`} style={[styles.returnValue, { color: rate.color }]}>{rate.text}</Text>
      <Text testID={`ranking-total-${item.userId}`} style={styles.totalAsset}>{total}</Text>
    </View>
  );
}

const HIDDEN = {
  accessible: false, accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants', 'aria-hidden': true,
} as const;
const ROW_BORDER = 1;
const ROW_RADIUS = 14;
const NAME_LINE = 22;
const ROW_EMBLEM = 18;
// One emblem slot for every tier: the widest emblem at this size, a little
// taller than the tallest (Whale, about 19.3), so each tier line has the same
// height and the tier names start at the same x.
const ROW_EMBLEM_SLOT = {
  width: Math.ceil(Math.max(...(['bronze', 'silver', 'gold', 'platinum', 'diamond', 'whale'] satisfies HomeTier[])
    .map((tier) => tierEmblemWidth(tier, ROW_EMBLEM)))),
  height: 20,
};
// My row's ring sits on the screen, 3 outside the card's border. Absolute
// offsets start inside that border, so it is added back.
const ME_RING = { width: 2, gap: 3, color: { light: '#B8860B', dark: '#F2C14E' } } as const;
const ME_RING_OUTSET = ME_RING.gap + ME_RING.width + ROW_BORDER;

/**
 * Every row is the same plain card, whatever the tier: a small emblem and the
 * tier name under the nickname say the tier; the card-size emblem (and Home's
 * emblem ids) stays on 내 순위 only. Unknown tiers have no tier line. My row
 * shows a 나 chip in the slot every row keeps, and a ring around the card;
 * neither moves any row.
 */
function RankingRow({
  item,
  rankType,
  mine,
  onPress,
}: {
  item: RankingItemDto;
  rankType?: RankingRankType;
  mine: boolean;
  onPress: () => void;
}) {
  const { mode } = useAppearance();
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > 1.3;
  const tier = getHomeTier(getRankingTier(item, rankType), mode);
  return (
    <ActionPressable testID={TEST_IDS.ranking.item(item.userId)} style={styles.rankRow} onPress={onPress}>
      {mine ? (
        <View testID="ranking-me-ring" pointerEvents="none" {...HIDDEN} style={[styles.meRing, { borderColor: ME_RING.color[mode] }]} />
      ) : null}
      <View style={[styles.rankLeft, stacked && styles.rankLeftStacked]}>
        <Text style={styles.rankNumber}>#{item.rank}</Text>
        <View style={[styles.profile, stacked && styles.rowProfileStacked]}>
          <ProfileAvatar profileImageUrl={item.profileImageUrl} size={40} testID={`ranking-avatar-${item.userId}`} />
          <View style={styles.identity}>
            <View style={styles.nameLine}>
              <Text style={styles.name}>{item.nickname}</Text>
              {/* Every row keeps the chip's slot (invisible unless mine), so marking my row never
                  reflows its nickname; the slot is one nickname line tall, so the chip stays on the
                  first line. 내 순위 itself is in the figures' label. */}
              <View style={[styles.meChipLine, { height: NAME_LINE * fontScale }]}>
                <View testID={mine ? 'ranking-me-chip' : undefined} {...HIDDEN}
                  style={[styles.meChip, mine ? styles.meChipMine : styles.meChipSlot]}>
                  <Text maxFontSizeMultiplier={1.3} style={[styles.meChipText, mine && styles.meChipTextMine]}>나</Text>
                </View>
              </View>
            </View>
            {tier ? (
              // RankingFigures' label already names the tier.
              <View testID={`ranking-row-tier-${item.userId}`} style={styles.tierLine} {...HIDDEN}>
                <View style={styles.rowEmblemSlot}>
                  <TierEmblem tier={tier.id} size={ROW_EMBLEM} testID={`ranking-row-emblem-${item.userId}`}
                    imageTestID={`ranking-row-emblem-image-${item.userId}`} />
                </View>
                <Text style={styles.tierName}>{tier.name}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </View>

      <RankingFigures item={item} tierName={tier?.name} mine={mine} />
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
  myName: { flex: 1, minWidth: 0, fontSize: 18, lineHeight: 26, fontWeight: '700' },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0, flexShrink: 1 },
  // Only when the figures cannot fit beside the name (narrow screens at large
  // text) do they wrap under it; long values remain fully visible.
  figures: { marginLeft: 'auto', flexShrink: 1, minWidth: 0, maxWidth: '100%', alignItems: 'stretch', gap: 2 },
  // The app's percent figures: system font and tabular digits, at the
  // ranking's size (18). Bold, so the direction color reads at full strength
  // in every row (a regular stroke is thin enough to look faded).
  returnValue: { fontSize: 18, lineHeight: 26, fontWeight: '700', textAlign: 'right', fontVariant: ['tabular-nums'] },
  totalAsset: { fontSize: 15, lineHeight: 22, fontWeight: '600', textAlign: 'right', fontVariant: ['tabular-nums'] },
  title: { fontSize: 22, fontWeight: '700' },
  label: { fontSize: 13, color: semantic.secondary },
  helper: { fontSize: 14, color: semantic.secondary },
  // Every tier: the plain card's surface, border and radius (as styles.card).
  rankRow: {
    borderWidth: ROW_BORDER,
    borderColor: semantic.border,
    borderRadius: ROW_RADIUS,
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
    // Rank, avatar, a readable name and the 나 chip's slot; below this the figures wrap instead.
    flexBasis: 176,
    minWidth: 0,
  },
  rankNumber: { minWidth: 28, flexShrink: 0, fontSize: 20, lineHeight: 28, fontWeight: '800', textAlign: 'center', fontVariant: ['tabular-nums'] },
  rankLeftStacked: { flexBasis: '100%', flexDirection: 'column', alignItems: 'flex-start', gap: 6 },
  rowProfileStacked: { alignSelf: 'stretch', alignItems: 'flex-start' },
  identity: { flex: 1, minWidth: 0, gap: 3 },
  nameLine: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, minWidth: 0 },
  name: { flexShrink: 1, minWidth: 0, fontSize: 15, lineHeight: NAME_LINE, fontWeight: '700' },
  meChipLine: { flexShrink: 0, justifyContent: 'center' },
  meChip: { borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1 },
  // Inverted text colors: a solid pill on the card in both modes.
  meChipMine: { backgroundColor: semantic.text },
  meChipSlot: { opacity: 0 },
  meChipText: { fontSize: 11, lineHeight: 14, fontWeight: '700' },
  meChipTextMine: { color: semantic.surface },
  tierLine: { flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: 0 },
  rowEmblemSlot: { ...ROW_EMBLEM_SLOT, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  tierName: { flexShrink: 1, minWidth: 0, fontSize: 12, lineHeight: 16, fontWeight: '600', color: semantic.secondary },
  meRing: {
    position: 'absolute', top: -ME_RING_OUTSET, right: -ME_RING_OUTSET, bottom: -ME_RING_OUTSET, left: -ME_RING_OUTSET,
    borderWidth: ME_RING.width, borderRadius: ROW_RADIUS + ME_RING.gap + ME_RING.width,
  },
  footerLoader: { paddingVertical: 16 },
});
