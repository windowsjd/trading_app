import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  FlatList,
} from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import {
  getMyRewards,
  getMyBadges,
  getRewardItemDate,
  isRewardResponseFailed,
  isRewardResponsePending,
} from '../../features/reward/api';
import type { RewardViewState } from '../../models/enums/viewState';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import EmptyState from '../../components/states/EmptyState';

export default function RewardScreen() {
  const rewardsQuery = useQuery({
    queryKey: QUERY_KEYS.reward.rewards,
    queryFn: getMyRewards,
  });

  const badgesQuery = useQuery({
    queryKey: QUERY_KEYS.reward.badges,
    queryFn: getMyBadges,
  });

  const viewState = useMemo<RewardViewState>(() => {
    if (rewardsQuery.isLoading || badgesQuery.isLoading) {
      return 'reward_loading';
    }

    if (rewardsQuery.isError || badgesQuery.isError || !rewardsQuery.data || !badgesQuery.data) {
      return 'reward_error';
    }

    const hasAnyReward =
      rewardsQuery.data.items.length > 0 || badgesQuery.data.items.length > 0;

    if (
      isRewardResponseFailed(rewardsQuery.data) ||
      isRewardResponseFailed(badgesQuery.data)
    ) {
      return 'reward_failed';
    }

    if (
      isRewardResponsePending(rewardsQuery.data) ||
      isRewardResponsePending(badgesQuery.data)
    ) {
      return 'reward_pending';
    }

    if (!hasAnyReward) return 'reward_empty';

    return 'reward_ready';
  }, [
    rewardsQuery.isLoading,
    badgesQuery.isLoading,
    rewardsQuery.isError,
    badgesQuery.isError,
    rewardsQuery.data,
    badgesQuery.data,
  ]);

  const retryAll = () => {
    rewardsQuery.refetch();
    badgesQuery.refetch();
  };

  if (viewState === 'reward_loading') {
    return <FullPageLoading message="보상 정보를 불러오는 중입니다." />;
  }

  if (viewState === 'reward_error') {
    return (
      <ErrorState
        title="보상 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={retryAll}
      />
    );
  }

  if (viewState === 'reward_failed') {
    return (
      <ErrorState
        title="보상 지급 상태를 확인하지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={retryAll}
      />
    );
  }

  if (viewState === 'reward_pending') {
    return (
      <EmptyState
        title="보상 지급 대기 중입니다."
        message="시즌 결과와 지급 상태가 확정되면 보상과 뱃지가 표시됩니다."
      />
    );
  }

  if (
    viewState === 'reward_empty' ||
    !rewardsQuery.data ||
    !badgesQuery.data
  ) {
    return (
      <EmptyState
        title="아직 획득한 보상이 없습니다."
        message="시즌 종료와 정산 후 보상과 뱃지가 여기에 표시됩니다."
      />
    );
  }

  const badgeItems = badgesQuery.data.items;
  const rewardItems = rewardsQuery.data.items;

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        testID={TEST_IDS.reward.screen}
        data={rewardItems}
        keyExtractor={(item) => `${item.seasonId}-${item.rewardCode}`}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <>
            <View style={styles.card}>
              <Text style={styles.sectionTitle}>획득 뱃지</Text>
              {badgeItems.length === 0 ? (
                <Text style={styles.helper}>획득한 뱃지가 없습니다.</Text>
              ) : (
                badgeItems.map((badge) => (
                  <View
                    key={`${badge.seasonId}-${badge.badgeCode}`}
                    testID={TEST_IDS.reward.badgeItem(badge.badgeCode)}
                    style={styles.row}
                  >
                    <View>
                      <Text style={styles.itemTitle}>{badge.badgeName}</Text>
                      <Text style={styles.helper}>시즌 {badge.seasonId}</Text>
                    </View>
                    <Text style={styles.helper}>{getRewardItemDate(badge)}</Text>
                  </View>
                ))
              )}
            </View>

            <View style={styles.card}>
              <Text style={styles.sectionTitle}>시즌 보상 내역</Text>
            </View>
          </>
        }
        renderItem={({ item }) => (
          <View
            testID={TEST_IDS.reward.rewardItem(item.seasonId, item.rewardCode)}
            style={styles.rowCard}
          >
            <View>
              <Text style={styles.itemTitle}>{item.rewardName}</Text>
              <Text style={styles.helper}>시즌 {item.seasonId}</Text>
              <Text style={styles.helper}>유형 {item.rewardType}</Text>
            </View>
            <Text style={styles.helper}>{getRewardItemDate(item)}</Text>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 16, gap: 12, paddingBottom: 24 },
  card: {
    borderWidth: 1,
    borderColor: '#e8e8e8',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 10,
    marginBottom: 12,
  },
  sectionTitle: { fontSize: 18, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  itemTitle: { fontSize: 15, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingVertical: 10,
  },
  rowCard: {
    borderWidth: 1,
    borderColor: '#eee',
    borderRadius: 14,
    padding: 16,
    backgroundColor: '#fff',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
});
