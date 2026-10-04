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
} from '../../theme/native';
import ActionPressable from '../../components/common/ActionPressable';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { RecordSeasonListScreenProps } from '../../app/navigation/types';
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import { getCurrentSeason } from '../../features/season/api';
import { toSeasonDomainState } from '../../features/season/mapper';
import { getMySeasonRecords } from '../../features/record/api';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';
import CTAButton from '../../components/common/CTAButton';
import { formatKstDateTime, formatPercent } from '../../utils/format';

type Props = RecordSeasonListScreenProps;

function displayValue(value?: string | number | null) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
}

function getReturnRate(item: { finalReturnRate?: string | null; returnRate?: string | null }) {
  return item.finalReturnRate ?? item.returnRate ?? '-';
}

export default function RecordSeasonListScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();

  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });

  const recordsQuery = useInfiniteQuery({
    queryKey: QUERY_KEYS.record.infiniteSeasons({ limit: 20, offset: 0 }),
    queryFn: ({ pageParam }) =>
      getMySeasonRecords({ limit: 20, offset: pageParam }),
    getNextPageParam: (lastPage) => lastPage.pagination.nextOffset ?? undefined,
    initialPageParam: 0,
  });
  const refresh = usePullToRefresh([seasonQuery, recordsQuery]);

  const items = useMemo(
    () => recordsQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [recordsQuery.data],
  );

  const viewState = useMemo(() => {
    if (recordsQuery.isLoading) return 'record_list_loading';
    if (recordsQuery.isError && !recordsQuery.data) return 'record_list_error';
    if (!items.length) return 'record_list_empty';
    if (recordsQuery.isFetchingNextPage) return 'record_list_paginating';
    return 'record_list_ready';
  }, [
    recordsQuery.isLoading,
    recordsQuery.isError,
    recordsQuery.data,
    recordsQuery.isFetchingNextPage,
    items.length,
  ]);

  const shouldShowJoinSeasonCta = useMemo(() => {
    if (seasonQuery.isLoading || seasonQuery.isError || !seasonQuery.data) {
      return false;
    }

    return toSeasonDomainState(seasonQuery.data) === 'season_active_not_joined';
  }, [seasonQuery.data, seasonQuery.isError, seasonQuery.isLoading]);

  if (viewState === 'record_list_loading') {
    return <FullPageLoading message="전적 목록을 불러오는 중입니다." />;
  }

  if (viewState === 'record_list_error') {
    return (
      <ErrorState
        title="전적 목록을 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => void recordsQuery.refetch()}
      />
    );
  }

  if (viewState === 'record_list_empty') {
    return (
      <ScrollView refreshControl={refresh.refreshControl} style={styles.container} contentContainerStyle={styles.content}>
        <EmptyState
          title="아직 참여한 시즌이 없습니다."
          message="현재 시즌에 참가하면 전적이 쌓이기 시작합니다."
          actionLabel={
            shouldShowJoinSeasonCta ? '현재 시즌 참가하기' : undefined
          }
          onAction={
            shouldShowJoinSeasonCta
              ? () => rootNavigation.navigate('SeasonJoin')
              : undefined
          }
        />
      </ScrollView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        refreshControl={refresh.refreshControl}
        testID={TEST_IDS.record.seasonListScreen}
        data={items}
        keyExtractor={(item) => item.seasonId}
        contentContainerStyle={styles.content}
        onEndReached={() => {
          if (recordsQuery.hasNextPage && !recordsQuery.isFetching) {
            void recordsQuery.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.4}
        renderItem={({ item }) => (
          <ActionPressable
            testID={TEST_IDS.record.seasonItem(item.seasonId)}
            style={styles.rowCard}
            onPress={() =>
              navigation.navigate('RecordSeasonDetail', {
                seasonId: item.seasonId,
              })
            }
          >
            <View style={styles.identity}>
              <Text style={styles.itemTitle}>{item.seasonName}</Text>
              <Text style={styles.helper}>
                참가 시각 {formatKstDateTime(item.joinedAt)}
              </Text>
            </View>

            <View style={styles.alignEnd}>
              <Text style={styles.helper}>
                {item.finalRank ?? item.rank ? `#${item.finalRank ?? item.rank}` : '-'}
              </Text>
              <Text style={styles.helper}>{displayValue(item.finalTier ?? item.tier)}</Text>
              <Text style={styles.itemTitle}>{formatPercent(getReturnRate(item))}%</Text>
            </View>
          </ActionPressable>
        )}
        ListFooterComponent={
          recordsQuery.isFetchingNextPage ? (
            <View style={styles.footerBox}>
              <CTAButton label="불러오는 중..." state="loading" />
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: semantic.screen },
  content: { ...getScreenContentStyle(Platform.OS), padding: 16, paddingBottom: 24 },
  rowCard: {
    borderWidth: 1,
    borderColor: semantic.border,
    borderRadius: 14,
    padding: 16,
    backgroundColor: semantic.surface,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  itemTitle: { fontSize: 15, fontWeight: '700' },
  identity: Platform.OS === 'web' ? { flex: 1, minWidth: 0 } : {},
  helper: { fontSize: 14, color: semantic.secondary },
  alignEnd: { alignItems: 'flex-end',
    ...(Platform.OS === 'web' ? { flex: 1, minWidth: 0 } : {}) },
  footerBox: { marginTop: 12 },
});
