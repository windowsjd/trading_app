import React from 'react';
import { useWindowDimensions } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import TabBarIcon from '../../components/navigation/TabBarIcon';
import TabBarButton from '../../components/navigation/TabBarButton';
import FullPageLoading from '../../components/states/FullPageLoading';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import type { MainTabParamList } from './types';
import HomeStack from './HomeStack';
import MarketStack from './MarketStack';
import GuideStack from './GuideStack';
import RankingStack from './RankingStack';
import RecordStack from './RecordStack';
import MyStack from './MyStack';

const Tab = createBottomTabNavigator<MainTabParamList>();

export default function MainTabs() {
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { selectedAccount, isLoading } = useTradingAccount();

  // The entry flow normally resolves the account before MainTabs mounts. Keep
  // tabs hidden during provider refreshes as well, so neither mode briefly
  // exposes the other mode's third tab.
  if (isLoading || !selectedAccount) {
    return <FullPageLoading message="계정 정보를 불러오는 중입니다." />;
  }

  const mode = selectedAccount.mode;

  return (
    <Tab.Navigator
      key={mode}
      id="MainTabs"
      initialRouteName="HomeTab"
      screenOptions={{
        headerShown: false,
        tabBarButton: (props) => <TabBarButton {...props} />,
        tabBarLabelPosition: 'below-icon',
        // Keep the default 49pt bar at normal font sizes. Extra label space
        // grows with accessibility text; Navigation still pads the safe area.
        tabBarStyle: fontScale > 1
          ? { height: 49 + Math.ceil(14 * (fontScale - 1)) + insets.bottom }
          : undefined,
      }}
    >
      <Tab.Screen
        name="HomeTab"
        component={HomeStack}
        options={{
          title: '홈',
          tabBarIcon: ({ color, size }) => (
            <TabBarIcon name="home" color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="MarketTab"
        component={MarketStack}
        options={{
          title: '마켓',
          tabBarIcon: ({ color, size }) => (
            <TabBarIcon name="market" color={color} size={size} />
          ),
        }}
      />
      {mode === 'general' ? (
        <Tab.Screen
          name="GuideTab"
          component={GuideStack}
          options={{
            title: '가이드',
            tabBarIcon: ({ color, size }) => (
              <TabBarIcon name="guide" color={color} size={size} />
            ),
          }}
        />
      ) : (
        <Tab.Screen
          name="RankingTab"
          component={RankingStack}
          options={{
            title: '랭킹',
            tabBarIcon: ({ color, size }) => (
              <TabBarIcon name="ranking" color={color} size={size} />
            ),
          }}
        />
      )}
      <Tab.Screen
        name="RecordTab"
        component={RecordStack}
        options={{
          title: '전적',
          tabBarIcon: ({ color, size }) => (
            <TabBarIcon name="record" color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="MyTab"
        component={MyStack}
        options={{
          title: 'MY',
          tabBarIcon: ({ color, size }) => (
            <TabBarIcon name="profile" color={color} size={size} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}
