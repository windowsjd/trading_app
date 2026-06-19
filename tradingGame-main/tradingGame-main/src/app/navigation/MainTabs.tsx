import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import type { MainTabParamList } from './types';
import HomeStack from './HomeStack';
import MarketStack from './MarketStack';
import RankingStack from './RankingStack';
import RecordStack from './RecordStack';
import MyStack from './MyStack';

const Tab = createBottomTabNavigator<MainTabParamList>();

export default function MainTabs() {
  return (
    <Tab.Navigator screenOptions={{ headerShown: false }}>
      <Tab.Screen
        name="HomeTab"
        component={HomeStack}
        options={{ title: '홈' }}
      />
      <Tab.Screen
        name="MarketTab"
        component={MarketStack}
        options={{ title: '마켓' }}
      />
      <Tab.Screen
        name="RankingTab"
        component={RankingStack}
        options={{ title: '랭킹' }}
      />
      <Tab.Screen
        name="RecordTab"
        component={RecordStack}
        options={{ title: '전적' }}
      />
      <Tab.Screen
        name="MyTab"
        component={MyStack}
        options={{ title: 'MY' }}
      />
    </Tab.Navigator>
  );
}