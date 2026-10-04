import React from 'react';
import { useWindowDimensions } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { getFocusedRouteNameFromRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppearance } from '../../theme/appearance';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { tabTransition } from './transitionPolicy';

import TabBarIcon from '../../components/navigation/TabBarIcon';
import TabBarButton from '../../components/navigation/TabBarButton';
import FullPageLoading from '../../components/states/FullPageLoading';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import type { MainTabParamList } from './types';
import HomeStack from './HomeStack';
import MarketStack from './MarketStack';
import GuideStack from './GuideStack';
import RankingStack from './RankingStack';
import WalletStack from './WalletStack';
import MyStack from './MyStack';

const Tab = createBottomTabNavigator<MainTabParamList>();

export default function MainTabs() {
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { colors } = useAppearance();
  const reducedMotion = useReducedMotion();
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
        tabBarButton: (props) => <TabBarButton {...props} reducedMotion={reducedMotion} />,
        tabBarLabelPosition: 'below-icon',
        tabBarActiveTintColor: colors.secondaryActionForeground,
        tabBarInactiveTintColor: colors.navigationInactive,
        ...tabTransition(reducedMotion),
        tabBarStyle: {
          backgroundColor: colors.navigation,
          borderTopColor: colors.border,
          ...(fontScale > 1 ? { height: 49 + Math.ceil(14 * (fontScale - 1)) + insets.bottom } : {}),
        },
        // Navigation keeps the safe area; enlarged labels grow the bar.
      }}
    >
      <Tab.Screen
        name="HomeTab"
        component={HomeStack}
        options={{
          title: '홈',
          tabBarIcon: ({ color, size, focused }) => (
            <TabBarIcon focused={focused} name="home" color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="MarketTab"
        component={MarketStack}
        options={({ route }) => ({
          title: '마켓',
          // Detail owns the bottom safe area and its persistent order actions.
          ...(getFocusedRouteNameFromRoute(route) === 'AssetDetail'
            ? { tabBarStyle: { display: 'none' } }
            : {}),
          tabBarIcon: ({ color, size, focused }) => (
            <TabBarIcon focused={focused} name="market" color={color} size={size} />
          ),
        })}
      />
      {mode === 'general' ? (
        <Tab.Screen
          name="GuideTab"
          component={GuideStack}
          options={{
            title: '가이드',
            tabBarIcon: ({ color, size, focused }) => (
              <TabBarIcon focused={focused} name="guide" color={color} size={size} />
            ),
          }}
        />
      ) : (
        <Tab.Screen
          name="RankingTab"
          component={RankingStack}
          options={{
            title: '랭킹',
            tabBarIcon: ({ color, size, focused }) => (
              <TabBarIcon focused={focused} name="ranking" color={color} size={size} />
            ),
          }}
        />
      )}
      <Tab.Screen
        name="WalletTab"
        component={WalletStack}
        options={{
          title: '지갑',
          tabBarIcon: ({ color, size, focused }) => (
            <TabBarIcon focused={focused} name="wallet" color={color} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="MyTab"
        component={MyStack}
        options={{
          title: '전체',
          tabBarIcon: ({ color, size, focused }) => (
            <TabBarIcon focused={focused} name="menu" color={color} size={size} />
          ),
        }}
      />
    </Tab.Navigator>
  );
}
