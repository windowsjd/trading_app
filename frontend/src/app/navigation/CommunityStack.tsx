import React from 'react';
import { mainTabHeaderTitle } from '../../components/navigation/MainTabHeaderTitle';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';
import { stackScreenLayout } from './stackScreenLayout';
import { returnToEntryTab } from './marketTabEntry';
import { postDetailId, postDetailOptions } from './communityPostEntry';

import type { CommunityStackParamList } from './types';
import CommunityScreen from '../../screens/community/CommunityScreen';
import PostDetailScreen from '../../screens/community/PostDetailScreen';
import PostComposeScreen from '../../screens/community/PostComposeScreen';
import UserSeasonSummaryScreen from '../../screens/ranking/UserSeasonSummaryScreen';

const Stack = createNativeStackNavigator<CommunityStackParamList>();

/**
 * 커뮤니티 (초보·일반 모드). The post screens and 유저 시즌 요약 are the same
 * components and titles as in the 리그 tab's stack; 유저 시즌 요약 pops back
 * to the community screen it was opened from, never to the ranking. A post
 * Home's card opened (`returnTab`) goes back to Home, its back button the
 * arrow alone (2026-11-07 (3), as the Market tab's cross-tab details).
 */
export default function CommunityStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="CommunityStack" screenOptions={stackTransition(reducedMotion, Platform.OS)} screenLayout={stackScreenLayout}
      screenListeners={returnToEntryTab}>
      <Stack.Screen
        name="Community"
        component={CommunityScreen}
        options={{ title: '커뮤니티', headerTitle: mainTabHeaderTitle('community') }}
      />
      <Stack.Screen name="PostDetail" component={PostDetailScreen} getId={postDetailId}
        options={({ route }) => postDetailOptions(route.params)} />
      {/* 글쓰기 takes the heavy theme font (bolder, same size); its left is the native back. */}
      <Stack.Screen name="PostCompose" component={PostComposeScreen}
        options={({ theme }) => ({ title: '글쓰기', headerTitleStyle: theme.fonts.heavy })} />
      <Stack.Screen
        name="UserSeasonSummary"
        component={UserSeasonSummaryScreen}
        options={{ title: '유저 시즌 요약' }}
      />
    </Stack.Navigator>
  );
}
