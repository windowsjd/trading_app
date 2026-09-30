import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';

import type { MyStackParamList } from './types';
import OverallScreen from '../../screens/my/OverallScreen';
import NoticesScreen from '../../screens/my/NoticesScreen';
import FriendsScreen from '../../screens/friends/FriendsScreen';
import UserSeasonSummaryScreen from '../../screens/ranking/UserSeasonSummaryScreen';
import MyScreen from '../../screens/my/MyScreen';
import RewardScreen from '../../screens/reward/RewardScreen';
import SettingsScreen from '../../screens/my/SettingsScreen';

const Stack = createNativeStackNavigator<MyStackParamList>();

export default function MyStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="MyStack" initialRouteName="Overall" screenOptions={stackTransition(reducedMotion, Platform.OS)}>
      <Stack.Screen
        name="Overall"
        component={OverallScreen}
        options={{ title: '전체' }}
      />
      <Stack.Screen
        name="Friends"
        component={FriendsScreen}
        options={{ title: '친구' }}
      />
      <Stack.Screen
        name="Notices"
        component={NoticesScreen}
        options={{ title: '공지사항' }}
      />
      <Stack.Screen
        name="UserSeasonSummary"
        component={UserSeasonSummaryScreen}
        options={{ title: '시즌 포트폴리오' }}
      />
      <Stack.Screen name="My" component={MyScreen} options={{ title: 'MY' }} />
      <Stack.Screen
        name="Reward"
        component={RewardScreen}
        options={{ title: '보상 / 뱃지' }}
      />
      <Stack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: '설정' }}
      />
    </Stack.Navigator>
  );
}
