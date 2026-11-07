import React from 'react';
import { mainTabHeaderTitle } from '../../components/navigation/MainTabHeaderTitle';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';
import { stackScreenLayout } from './stackScreenLayout';

import type { CommunityStackParamList } from './types';
import CommunityScreen from '../../screens/community/CommunityScreen';
import PostDetailScreen from '../../screens/community/PostDetailScreen';
import PostComposeScreen from '../../screens/community/PostComposeScreen';
import UserSeasonSummaryScreen from '../../screens/ranking/UserSeasonSummaryScreen';

const Stack = createNativeStackNavigator<CommunityStackParamList>();

/**
 * 커뮤니티 (초보·일반 모드). The post screens and 유저 시즌 요약 are the same
 * components and titles as in the 리그 tab's stack; 유저 시즌 요약 pops back
 * to the community screen it was opened from, never to the ranking.
 */
export default function CommunityStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="CommunityStack" screenOptions={stackTransition(reducedMotion, Platform.OS)} screenLayout={stackScreenLayout}>
      <Stack.Screen
        name="Community"
        component={CommunityScreen}
        options={{ title: '커뮤니티', headerTitle: mainTabHeaderTitle('community') }}
      />
      <Stack.Screen name="PostDetail" component={PostDetailScreen} options={{ title: '커뮤니티' }} />
      <Stack.Screen name="PostCompose" component={PostComposeScreen} options={{ title: '글쓰기' }} />
      <Stack.Screen
        name="UserSeasonSummary"
        component={UserSeasonSummaryScreen}
        options={{ title: '유저 시즌 요약' }}
      />
    </Stack.Navigator>
  );
}
