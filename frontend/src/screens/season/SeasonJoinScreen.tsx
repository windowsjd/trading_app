import React, { useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Pressable,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { SeasonJoinScreenProps } from '../../app/navigation/types';
import { getCurrentSeason, joinSeason } from '../../features/season/api';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import BlockedState from '../../components/states/BlockedState';
import CTAButton from '../../components/common/CTAButton';

type Props = SeasonJoinScreenProps;

export default function SeasonJoinScreen({ navigation }: Props) {
  const queryClient = useQueryClient();

  const seasonQuery = useQuery({
    queryKey: QUERY_KEYS.season.current,
    queryFn: getCurrentSeason,
  });

  const joinMutation = useMutation({
    mutationFn: (seasonId: string) => joinSeason(seasonId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.season.current }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.home.dashboard }),
        queryClient.invalidateQueries({ queryKey: QUERY_KEYS.wallet.balances }),
      ]);

      navigation.reset({
        index: 0,
        routes: [
          {
            name: 'MainTabs',
            params: {
              screen: 'HomeTab',
              params: { screen: 'Home' },
            },
          },
        ],
      });
    },
  });

  const viewState = useMemo(() => {
    if (seasonQuery.isLoading) return 'season_info_loading';
    if (!seasonQuery.data) return 'season_join_failed';
    if (joinMutation.isPending) return 'season_join_submitting';
    if (seasonQuery.data.status === 'upcoming') return 'season_upcoming_view';
    if (seasonQuery.data.status === 'active' && !seasonQuery.data.joined) {
      return 'season_active_not_joined_view';
    }
    if (seasonQuery.data.status === 'active' && seasonQuery.data.joined) {
      return 'season_join_success';
    }
    return 'season_settled_view';
  }, [seasonQuery.isLoading, seasonQuery.data, joinMutation.isPending]);

  if (viewState === 'season_info_loading') {
    return <FullPageLoading message="현재 시즌 정보를 불러오는 중입니다." />;
  }

  if (viewState === 'season_join_failed' || !seasonQuery.data) {
    return (
      <ErrorState
        title="시즌 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => seasonQuery.refetch()}
      />
    );
  }

  const season = seasonQuery.data;

  if (viewState === 'season_upcoming_view') {
    return (
      <BlockedState
        title={season.name}
        message="시즌 시작 전입니다. 시작 시점이 되면 거래가 열립니다."
        actionLabel="홈으로 이동"
        onAction={() =>
          navigation.reset({
            index: 0,
            routes: [
              {
                name: 'MainTabs',
                params: {
                  screen: 'HomeTab',
                  params: { screen: 'Home' },
                },
              },
            ],
          })
        }
      />
    );
  }

  if (viewState === 'season_settled_view') {
    return (
      <BlockedState
        title={season.name}
        message="현재 시즌은 종료되었습니다. 홈으로 이동해주세요."
        actionLabel="홈으로 이동"
        onAction={() =>
          navigation.reset({
            index: 0,
            routes: [
              {
                name: 'MainTabs',
                params: {
                  screen: 'HomeTab',
                  params: { screen: 'Home' },
                },
              },
            ],
          })
        }
      />
    );
  }

  if (viewState === 'season_join_success') {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.content}>
          <View style={styles.card}>
            <Text style={styles.title}>이미 이번 시즌에 참가한 상태입니다.</Text>
            <Text style={styles.helper}>홈으로 이동해 포트폴리오와 랭킹을 확인하세요.</Text>
          </View>

          <CTAButton
            label="홈으로 이동"
            onPress={() =>
              navigation.reset({
                index: 0,
                routes: [
                  {
                    name: 'MainTabs',
                    params: {
                      screen: 'HomeTab',
                      params: { screen: 'Home' },
                    },
                  },
                ],
              })
            }
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View testID={TEST_IDS.season.joinScreen} style={styles.content}>
        <View style={styles.card}>
          <Text style={styles.title}>{season.name}</Text>
          <Text style={styles.helper}>
            시즌 기간: {season.startAt} ~ {season.endAt}
          </Text>
          <Text style={styles.helper}>
            시작 자산: {season.initialCapitalKrw} KRW
          </Text>
          <Text style={styles.helper}>거래 수수료: {season.tradeFeeRate}</Text>
          <Text style={styles.helper}>환전 수수료: {season.fxFeeRate}</Text>
          <Text style={styles.helper}>지원 자산: 국내 주식 / 미국 주식 / 암호화폐</Text>
          <Text style={styles.helper}>랭킹 기준: KRW 기준 총자산 수익률</Text>
        </View>

        <CTAButton
          label={joinMutation.isPending ? '참가 처리 중...' : '시즌 참가하기'}
          state={joinMutation.isPending ? 'loading' : 'enabled'}
          onPress={() => joinMutation.mutate(season.id)}
        />

        <Pressable
          style={styles.secondaryButton}
          onPress={() =>
            navigation.reset({
              index: 0,
              routes: [
                {
                  name: 'MainTabs',
                  params: {
                    screen: 'HomeTab',
                    params: { screen: 'Home' },
                  },
                },
              ],
            })
          }
        >
          <Text style={styles.secondaryButtonText}>지금은 둘러보기</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { flex: 1, padding: 20, gap: 12 },
  card: {
    borderWidth: 1,
    borderColor: '#e5e5e5',
    borderRadius: 12,
    padding: 16,
    backgroundColor: '#fafafa',
    gap: 8,
  },
  title: { fontSize: 24, fontWeight: '700' },
  helper: { fontSize: 14, lineHeight: 22, color: '#444' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#111',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryButtonText: { color: '#111', fontSize: 16, fontWeight: '700' },
});