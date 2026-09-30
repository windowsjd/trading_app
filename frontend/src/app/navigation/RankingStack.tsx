import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';

import type { RankingStackParamList } from './types';
import RankingScreen from '../../screens/ranking/RankingScreen';
import UserSeasonSummaryScreen from '../../screens/ranking/UserSeasonSummaryScreen';

const Stack = createNativeStackNavigator<RankingStackParamList>();

export default function RankingStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="RankingStack" screenOptions={stackTransition(reducedMotion, Platform.OS)}>
      <Stack.Screen
        name="Ranking"
        component={RankingScreen}
        options={{ title: '랭킹' }}
      />
      <Stack.Screen
        name="UserSeasonSummary"
        component={UserSeasonSummaryScreen}
        options={{ title: '유저 시즌 요약' }}
      />
    </Stack.Navigator>
  );
}
