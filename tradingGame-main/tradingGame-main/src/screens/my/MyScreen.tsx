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
import { useRootNavigation } from '../../app/navigation/navigationHooks';
import { QUERY_KEYS } from '../../constants/queryKeys';
import { TEST_IDS } from '../../constants/testIds';

import { getMe } from '../../features/me/api';
import { getHomeDashboard } from '../../features/home/api';
import { getMySeasonRecords } from '../../features/record/api';
import { clearTokens } from '../../services/storage/tokenStorage';

import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';

type Props = MyScreenProps;

export default function MyScreen({ navigation }: Props) {
  const rootNavigation = useRootNavigation();

  const meQuery = useQuery({
    queryKey: QUERY_KEYS.me,
    queryFn: getMe,
  });

  const homeQuery = useQuery({
    queryKey: QUERY_KEYS.home.dashboard,
    queryFn: getHomeDashboard,
  });

  const recordsQuery = useQuery({
    queryKey: QUERY_KEYS.record.seasons(null),
    queryFn: () => getMySeasonRecords(null, 20),
  });

  const viewState = useMemo(() => {
    if (meQuery.isLoading || homeQuery.isLoading || recordsQuery.isLoading) {
      return 'my_loading';
    }
    if (!meQuery.data || !homeQuery.data || !recordsQuery.data) {
      return 'my_error';
    }
    return 'my_ready';
  }, [
    meQuery.isLoading,
    homeQuery.isLoading,
    recordsQuery.isLoading,
    meQuery.data,
    homeQuery.data,
    recordsQuery.data,
  ]);

  const onLogout = async () => {
    await clearTokens();

    rootNavigation.reset({
      index: 0,
      routes: [
        {
          name: 'AuthStack',
          params: { screen: 'Login' },
        },
      ],
    });
  };

  if (viewState === 'my_loading') {
    return <FullPageLoading message="내 정보를 불러오는 중입니다." />;
  }

  if (viewState === 'my_error' || !meQuery.data || !homeQuery.data || !recordsQuery.data) {
    return (
      <ErrorState
        title="내 정보를 불러오지 못했습니다."
        message="잠시 후 다시 시도해주세요."
        onRetry={() => {
          meQuery.refetch();
          homeQuery.refetch();
          recordsQuery.refetch();
        }}
      />
    );
  }

  const me = meQuery.data;
  const home = homeQuery.data;
  const seasonCount = recordsQuery.data.items.length;

  return (
    <SafeAreaView style={styles.container}>
      <View testID={TEST_IDS.my.screen} style={styles.content}>
        <View style={styles.card}>
          <Text style={styles.title}>{me.nickname}</Text>
          <Text style={styles.helper}>이메일 {me.email}</Text>
          <Text style={styles.helper}>현재 등급 {home.ranking.tier}</Text>
          <Text style={styles.helper}>현재 순위 #{home.ranking.rank}</Text>
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
            onPress={onLogout}
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
  title: { fontSize: 22, fontWeight: '700' },
  helper: { fontSize: 14, color: '#444' },
  menuRow: {
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  menuText: { fontSize: 16, fontWeight: '600' },
  logoutText: { fontSize: 16, fontWeight: '700', color: '#c62828' },
});