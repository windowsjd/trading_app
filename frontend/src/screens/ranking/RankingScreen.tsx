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
import type { FlatList as NativeFlatList, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import Svg, { Path } from 'react-native-svg';
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
import { podiumEntries } from '../../features/ranking/podium';
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
import RankingPodium from './RankingPodium';
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

/**
 * Where the loaded stretch of the 전체 list starts: my own row (entry), the
 * first row (맨위로) or the last page (맨아래로). Rows outside it load page by
 * page as the list reaches them, so a jump never downloads what lies between.
 */
type AllWindow = 'me' | 'top' | 'bottom';
type RankingPageParam = {
  offset: number;
  limit: number;
  anchor?: 'me';
  rankType?: RankingRankType;
  rankingDate: string | null;
  capturedAt: string | null;
};
const CONTENT_PADDING = 16;
// My row's ring sits 6 outside its card; this keeps it in view when my row opens the list.
const ROW_LEAD = 8;
// 36 visible (48 to touch), tucked toward the edge so rows' figures stay readable as they pass.
const JUMP_SIZE = 36;
const JUMP_GAP = 8;
const JUMP_INSET = 16;
const JUMP_RIGHT = 6;
// The 전체 list ends this far above the bottom, so its last row clears the buttons.
const JUMP_CLEARANCE = JUMP_INSET + JUMP_SIZE * 2 + JUMP_GAP + 8;
const FOLLOW_END_MS = 1500;

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
  const myRanking = publication?.myRanking ?? null;
  // TOP 3 시상대: the publication's own first three rows (scope all), on every tab.
  const podium = podiumEntries(publication, myRanking);

  // 전체 opens at my row when I have one; otherwise (not joined, hidden, not
  // qualified, no row yet) at the top as before. Friends and TOP10 never move.
  const isAll = selectedTab === 'all';
  const [allWindow, setAllWindow] = React.useState<{ start: AllWindow; nonce: number }>({ start: 'me', nonce: 0 });
  const windowStart: AllWindow = !isAll ? 'top'
    : allWindow.start === 'me' && myRanking?.state !== 'available' ? 'top' : allWindow.start;
  const publicationTotal = publication?.pagination?.total ?? 0;
  const firstOffset = windowStart === 'bottom' ? Math.max(0, publicationTotal - rankingLimit) : 0;
  const rankingQueryKey = useMemo(
    () => QUERY_KEYS.ranking.infiniteList({
      scope: selectedTab, limit: rankingLimit, offset: 0,
      seasonId, rankType, rankingDate, capturedAt,
    }, isAll ? `${windowStart}:${allWindow.nonce}` : undefined),
    [selectedTab, rankingLimit, seasonId, rankType, rankingDate, capturedAt, isAll, windowStart, allWindow.nonce],
  );

  const firstPageParam: RankingPageParam = {
    offset: firstOffset,
    limit: rankingLimit,
    ...(windowStart === 'me' ? { anchor: 'me' as const } : {}),
    rankType,
    rankingDate: rankingDate ?? null,
    capturedAt: capturedAt ?? null,
  };
  const rankingQuery = useInfiniteQuery({
    queryKey: rankingQueryKey,
    enabled: publication?.state === 'available',
    queryFn: ({ pageParam }) =>
      getRankings({
        scope: selectedTab,
        seasonId,
        limit: pageParam.limit,
        offset: pageParam.offset,
        ...(pageParam.anchor ? { anchor: pageParam.anchor } : {}),
        rankType: pageParam.rankType,
        rankingDate: pageParam.rankingDate,
        capturedAt: pageParam.capturedAt,
      }),
    getNextPageParam: (lastPage): RankingPageParam | undefined => {
      const nextOffset = lastPage.pagination.nextOffset;
      if (nextOffset === null || nextOffset === undefined) return undefined;

      return {
        offset: nextOffset,
        limit: rankingLimit,
        rankType: lastPage.rankType,
        rankingDate: lastPage.rankingDate ?? null,
        capturedAt: lastPage.capturedAt ?? null,
      };
    },
    // Only a 전체 stretch can start below the first row: the rows above it,
    // one page at a time, pinned to the same set.
    getPreviousPageParam: (firstPage): RankingPageParam | undefined => {
      const offset = firstPage.pagination.offset;
      if (!offset || offset <= 0) return undefined;
      const start = Math.max(0, offset - rankingLimit);

      return {
        offset: start,
        limit: offset - start,
        rankType: firstPage.rankType,
        rankingDate: firstPage.rankingDate ?? null,
        capturedAt: firstPage.capturedAt ?? null,
      };
    },
    initialPageParam: firstPageParam,
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

  // The loaded stretch and the whole list's real edges: a page's own first or
  // last row is never taken for the top or the bottom of the ranking.
  const pages = rankingQuery.data?.pages;
  const loadedStart = pages?.[0]?.pagination.offset ?? 0;
  const lastLoaded = pages?.[pages.length - 1];
  const loadedEnd = lastLoaded ? lastLoaded.pagination.offset + lastLoaded.pagination.returned : 0;
  const listTotal = lastLoaded?.pagination.total ?? publicationTotal;
  const listRef = React.useRef<NativeFlatList<RankingItemDto>>(null);
  const scrollState = React.useRef({ y: 0, height: 0, content: 0 });
  const headerHeight = React.useRef(0);
  // Where a new 전체 stretch opens, applied once its rows are laid out.
  const pendingScroll = React.useRef<AllWindow | null>('me');
  // 맨아래로 lands on the last row while the rows near it are still being laid
  // out (and re-measured): the end is followed briefly, until a drag.
  const followEndUntil = React.useRef(0);
  const [edges, setEdges] = React.useState({ top: true, bottom: true });

  React.useEffect(() => {
    pendingScroll.current = isAll ? windowStart : null;
  }, [rankingQueryKey, isAll, windowStart]);

  const updateEdges = React.useCallback(() => {
    const { y, height, content } = scrollState.current;
    const top = loadedStart === 0 && y <= 2;
    const bottom = loadedEnd >= listTotal && y + height >= content - 2;
    setEdges((current) => (current.top === top && current.bottom === bottom ? current : { top, bottom }));
  }, [loadedStart, loadedEnd, listTotal]);
  React.useEffect(() => { updateEdges(); }, [updateEdges]);

  const { hasPreviousPage, isFetching: listFetching, fetchPreviousPage } = rankingQuery;
  const previousInFlight = React.useRef(false);
  // After rows were added above, the next page waits for the list to be
  // scrolled up again: where the rows in view cannot be kept in place (web),
  // the list would otherwise keep reading upward on its own.
  const awaitUpScroll = React.useRef<{ lowest: number | null } | null>(null);
  const loadPrevious = React.useCallback(() => {
    // Never before the stretch is placed (rows would land above a list not yet
    // at my row), and one page at a time.
    if (!isAll || !hasPreviousPage || listFetching || pendingScroll.current || previousInFlight.current || awaitUpScroll.current) return;
    previousInFlight.current = true;
    void fetchPreviousPage().finally(() => {
      previousInFlight.current = false;
      awaitUpScroll.current = { lowest: null };
    });
  }, [isAll, hasPreviousPage, listFetching, fetchPreviousPage]);

  // Scrolls made here are recorded at once. The end is the measured content
  // end (a list's own scrollToEnd estimates unrendered rows and can fall short).
  const scrollListTo = (target: number | 'end', animated = false) => {
    const list = listRef.current;
    if (!list) return;
    const { content, height } = scrollState.current;
    if (target === 'end' && !(content > 0 && height > 0)) {
      list.scrollToEnd({ animated });
      return;
    }
    const offset = target === 'end' ? Math.max(0, content - height) : target;
    list.scrollToOffset({ offset, animated });
    scrollState.current.y = offset;
  };

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

  const applyPendingScroll = () => {
    const target = pendingScroll.current;
    if (!target || !isAll || !listRef.current || !pages?.length) return;
    if (target === 'bottom') {
      scrollListTo('end');
      followEndUntil.current = Date.now() + FOLLOW_END_MS;
    } else if (target === 'me' && loadedStart > 0) {
      // My row opens the list; the header above it comes back on the way up.
      if (headerHeight.current <= 0) return;
      scrollListTo(CONTENT_PADDING + headerHeight.current - ROW_LEAD);
    } else {
      scrollListTo(0);
    }
    pendingScroll.current = null;
    // The rows just above load at once, so scrolling up shows them, not the
    // header. Native lists keep the rows in view in place while they arrive
    // (maintainVisibleContentPosition); the web list cannot, so there they
    // wait for the list to be scrolled up toward them.
    if (Platform.OS === 'web') {
      awaitUpScroll.current = { lowest: null };
    } else {
      awaitUpScroll.current = null;
      loadPrevious();
    }
  };

  const onListScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
    scrollState.current = { y: contentOffset.y, height: layoutMeasurement.height, content: contentSize.height };
    if (Date.now() < followEndUntil.current && contentOffset.y < contentSize.height - layoutMeasurement.height - 2) {
      scrollListTo('end');
    }
    const waiting = awaitUpScroll.current;
    if (waiting) {
      // Scrolled up since the last page above arrived (from the lowest point seen since).
      if (waiting.lowest === null || contentOffset.y > waiting.lowest) waiting.lowest = contentOffset.y;
      else if (contentOffset.y < waiting.lowest - 1) awaitUpScroll.current = null;
    }
    // Within two screens of the top of the loaded rows: the page above.
    if (contentOffset.y < layoutMeasurement.height * 2) loadPrevious();
    updateEdges();
  };

  const onListContentSize = (_width: number, height: number) => {
    scrollState.current.content = height;
    if (Date.now() < followEndUntil.current) scrollListTo('end');
    applyPendingScroll();
    updateEdges();
  };

  // 맨위로 / 맨아래로: within the loaded stretch just scroll; otherwise read only
  // that end of the list (a new stretch), never everything in between.
  const jumpTo = (target: 'top' | 'bottom') => {
    if (target === 'top' ? edges.top : edges.bottom) return;
    if (target === 'top' && loadedStart === 0) {
      scrollListTo(0, true);
    } else if (target === 'bottom' && loadedEnd >= listTotal) {
      scrollListTo('end', true);
    } else {
      setAllWindow((current) => ({ start: target, nonce: current.nonce + 1 }));
      if (target === 'top') scrollListTo(0);
    }
  };

  const selectTab = (tab: RankingScope) => {
    // Back on 전체: it opens at my row again, as on entry.
    if (tab === 'all') setAllWindow((current) => ({ start: 'me', nonce: current.nonce + 1 }));
    setSelectedTab(tab);
  };

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
        ref={listRef}
        refreshControl={refresh.refreshControl}
        testID={TEST_IDS.ranking.screen}
        data={rankingErrorCode === ERROR_CODE.RANKING_SNAPSHOT_CHANGED ? [] : items}
        keyExtractor={getRankingItemKey}
        contentContainerStyle={isAll ? [styles.content, styles.contentWithJumps] : styles.content}
        onEndReached={() => {
          if (rankingQuery.hasNextPage && !rankingQuery.isFetching) {
            void rankingQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        // 전체 only: rows above the loaded stretch load as the list nears them
        // (onListScroll), and the rows in view stay where they are when they arrive.
        maintainVisibleContentPosition={isAll ? KEEP_VISIBLE_ROWS : undefined}
        onScroll={isAll ? onListScroll : undefined}
        onScrollBeginDrag={isAll ? () => { followEndUntil.current = 0; } : undefined}
        scrollEventThrottle={isAll ? 32 : undefined}
        onLayout={isAll ? (event) => { scrollState.current.height = event.nativeEvent.layout.height; updateEdges(); } : undefined}
        onContentSizeChange={isAll ? onListContentSize : undefined}
        ListHeaderComponent={
          <View onLayout={isAll ? (event: LayoutChangeEvent) => {
            headerHeight.current = event.nativeEvent.layout.height;
            applyPendingScroll();
          } : undefined}>
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

            {podium ? <RankingPodium entries={podium} rankType={rankType} style={styles.podium} /> : null}

            <SegmentedControl testID="ranking-tabs" accessibilityLabel="랭킹 범위" value={selectedTab} onChange={selectTab}
              style={styles.tabs}
              options={TABS.map(tab => ({ key: tab.key, label: tab.label, testID: tab.key === 'all' ? TEST_IDS.ranking.tabAll
                : tab.key === 'friends' ? TEST_IDS.ranking.tabFriends : TEST_IDS.ranking.tabTop10 }))} />
          </View>
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
      {isAll && items.length > 0 && rankingErrorCode !== ERROR_CODE.RANKING_SNAPSHOT_CHANGED ? (
        <View style={styles.jumps} pointerEvents="box-none">
          <JumpButton direction="up" disabled={edges.top} onPress={() => jumpTo('top')} />
          <JumpButton direction="down" disabled={edges.bottom} onPress={() => jumpTo('bottom')} />
        </View>
      ) : null}
    </SafeAreaView>
  );
}

/**
 * 맨위로 / 맨아래로 on the 전체 list: a small round icon button (no text), its
 * name for screen readers only. Disabled at the ranking's real top or bottom.
 */
function JumpButton({ direction, disabled, onPress }: { direction: 'up' | 'down'; disabled: boolean; onPress: () => void }) {
  const { colors } = useAppearance();
  const label = direction === 'up' ? '맨위로' : '맨아래로';
  return (
    <ActionPressable testID={direction === 'up' ? 'ranking-jump-top' : 'ranking-jump-bottom'}
      style={[styles.jump, disabled && styles.jumpDisabled]} hitSlop={6} disabled={disabled} onPress={disabled ? undefined : onPress}
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} aria-disabled={disabled}>
      <View {...HIDDEN}>
        <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={colors.secondary}
          strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" focusable={false}>
          <Path d={direction === 'up' ? 'M7 11l5-5 5 5M7 17l5-5 5 5' : 'M7 7l5 5 5-5M7 13l5 5 5-5'} />
        </Svg>
      </View>
    </ActionPressable>
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
// Rows added above the visible ones keep the visible ones in place (index 0 = first row; the header is counted by the list).
const KEEP_VISIBLE_ROWS = { minIndexForVisible: 0 };
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
  // 16 between the 순위 안내 row (or 내 순위, which keep 12 below them) and the podium, 16 to the tabs.
  podium: { marginTop: 4, marginBottom: 16 },
  contentWithJumps: { paddingBottom: JUMP_CLEARANCE },
  jumps: { position: 'absolute', right: JUMP_RIGHT, bottom: JUMP_INSET, gap: JUMP_GAP },
  jump: {
    width: JUMP_SIZE,
    height: JUMP_SIZE,
    borderRadius: JUMP_SIZE / 2,
    borderWidth: 1,
    borderColor: semantic.border,
    backgroundColor: semantic.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  jumpDisabled: { opacity: 0.4 },
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
