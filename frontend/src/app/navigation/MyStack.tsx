import React from 'react';
import { mainTabHeaderTitle } from '../../components/navigation/MainTabHeaderTitle';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Platform } from '../../theme/native';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { stackTransition } from './transitionPolicy';
import { stackScreenLayout } from './stackScreenLayout';

import RecordStack from './RecordStack';
import type { MyStackParamList } from './types';
import OverallScreen from '../../screens/my/OverallScreen';
import NoticesScreen from '../../screens/my/NoticesScreen';
import InquiryScreen from '../../screens/my/InquiryScreen';
import InquiryAnswerScreen from '../../screens/my/InquiryAnswerScreen';
import FriendsScreen from '../../screens/friends/FriendsScreen';
import UserSeasonSummaryScreen from '../../screens/ranking/UserSeasonSummaryScreen';
import MyScreen from '../../screens/my/MyScreen';
import RewardScreen from '../../screens/reward/RewardScreen';
import MyBadgesScreen from '../../screens/my/MyBadgesScreen';
import SettingsScreen from '../../screens/my/SettingsScreen';
import MembershipDeletionScreen from '../../screens/my/MembershipDeletionScreen';

const Stack = createNativeStackNavigator<MyStackParamList>();

export default function MyStack() {
  const reducedMotion = useReducedMotion();
  return (
    <Stack.Navigator id="MyStack" initialRouteName="Overall" screenOptions={stackTransition(reducedMotion, Platform.OS)} screenLayout={stackScreenLayout}>
      <Stack.Screen
        name="Overall"
        component={OverallScreen}
        options={{ title: '전체', headerTitle: mainTabHeaderTitle('menu') }}
      />
      <Stack.Screen name="Record" component={RecordStack} options={{ headerShown: false }} />
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
        name="Inquiry"
        component={InquiryScreen}
        options={{ title: '문의하기' }}
      />
      <Stack.Screen
        name="InquiryAnswer"
        component={InquiryAnswerScreen}
        options={{ title: '문의 답변' }}
      />
      <Stack.Screen
        name="UserSeasonSummary"
        component={UserSeasonSummaryScreen}
        options={{ title: '시즌 포트폴리오' }}
      />
      <Stack.Screen name="My" component={MyScreen} options={{ title: 'MY' }} />
      <Stack.Screen
        name="Badges"
        component={MyBadgesScreen}
        options={{ title: '내 뱃지' }}
      />
      <Stack.Screen
        name="Reward"
        component={RewardScreen}
        // The reward payout ledger; season results live on 내 뱃지 (Badges).
        options={{ title: '보상 지급 내역' }}
      />
      <Stack.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: '설정' }}
      />
      <Stack.Screen
        name="MembershipDeletion"
        component={MembershipDeletionScreen}
        options={{ title: '회원탈퇴' }}
      />
    </Stack.Navigator>
  );
}
