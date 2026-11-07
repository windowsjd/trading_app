import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';
import { stackScreenLayout } from './stackScreenLayout';

import type { RankingStackParamList } from './types';
import LeagueSectionTabs from '../../components/navigation/LeagueSectionTabs';
import LeagueScreen from '../../screens/ranking/LeagueScreen';
import UserSeasonSummaryScreen from '../../screens/ranking/UserSeasonSummaryScreen';
import PostDetailScreen from '../../screens/community/PostDetailScreen';
import PostComposeScreen from '../../screens/community/PostComposeScreen';

const Stack = createNativeStackNavigator<RankingStackParamList>();

/**
 * 리그 (season mode). The root's header shows the 랭킹 | 커뮤니티 text tabs at
 * the left (both platforms) instead of a title; the section is a route param,
 * so a pushed post, composer or 유저 시즌 요약 returns to the same section, and
 * Home's community card opens `section: 'community'` directly.
 */
export default function RankingStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="RankingStack" screenOptions={stackTransition(reducedMotion, Platform.OS)} screenLayout={stackScreenLayout}>
      <Stack.Screen
        name="Ranking"
        component={LeagueScreen}
        options={({ route, navigation }) => ({
          title: '리그',
          headerTitle: () => null,
          headerLeft: () => (
            <LeagueSectionTabs section={route.params?.section ?? 'ranking'}
              onChange={(section) => navigation.setParams({ section })} />
          ),
        })}
      />
      <Stack.Screen
        name="UserSeasonSummary"
        component={UserSeasonSummaryScreen}
        options={{ title: '유저 시즌 요약' }}
      />
      <Stack.Screen name="PostDetail" component={PostDetailScreen} options={{ title: '커뮤니티' }} />
      <Stack.Screen name="PostCompose" component={PostComposeScreen} options={{ title: '글쓰기' }} />
    </Stack.Navigator>
  );
}
