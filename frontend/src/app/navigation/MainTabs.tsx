import React from 'react';
import { useWindowDimensions } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { getFocusedRouteNameFromRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppearance } from '../../theme/appearance';
import { primaryGradient } from '../../theme/tokens';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { tabTransition } from './transitionPolicy';

import TabBarIcon from '../../components/navigation/TabBarIcon';
import TabBarButton from '../../components/navigation/TabBarButton';
import FullPageLoading from '../../components/states/FullPageLoading';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { ScreenSheetHost } from '../../components/common/ScreenSheetHost';
import { QuestGuideProvider } from '../../features/quest/QuestGuideProvider';
import { questNavigationRouter } from '../../features/quest/questNavigationGuard';
import { isGuestBrowsing } from '../../features/auth/guestBrowsing';
import { GuestExitContext } from '../../components/guest/guestExit';
import { leaveGuestBrowsing } from './seasonRouting';
import type { MainTabParamList, MainTabsScreenProps } from './types';
import HomeStack, { GuestHomeStack } from './HomeStack';
import MarketStack from './MarketStack';
import GuideStack, { QuestStack } from './GuideStack';
import RankingStack from './RankingStack';
import WalletStack, { GuestWalletStack } from './WalletStack';
import MyStack from './MyStack';
import ModesStack from './ModesStack';

const Tab = createBottomTabNavigator<MainTabParamList>();

export default function MainTabs(props: MainTabsScreenProps) {
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { colors } = useAppearance();
  const reducedMotion = useReducedMotion();
  const { selectedAccount, isLoading } = useTradingAccount();
  // 「로그인 없이 둘러보기」: no account at all, so nothing to wait for. A
  // signed-in user never reaches here as a guest (a session ends browsing).
  const guest = isGuestBrowsing();
  const account = guest ? null : selectedAccount;

  // The entry flow normally resolves the account before MainTabs mounts. Keep
  // tabs hidden during provider refreshes as well, so neither mode briefly
  // exposes the other mode's third tab.
  if (!guest && (isLoading || !account)) {
    return <FullPageLoading message="계정 정보를 불러오는 중입니다." />;
  }

  const mode = account?.mode ?? 'guest';

  const tabs = (
    <Tab.Navigator
      key={account?.id ?? 'guest'}
      id="MainTabs"
      initialRouteName="HomeTab"
      // An active beginner quest holds tab switches outside its practice.
      UNSTABLE_router={questNavigationRouter}
      screenOptions={{
        headerShown: false,
        tabBarButton: (props) => <TabBarButton {...props} reducedMotion={reducedMotion} />,
        tabBarLabelPosition: 'below-icon',
        tabBarActiveTintColor: primaryGradient.colors[0],
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
        component={mode === 'guest' ? GuestHomeStack : HomeStack}
        options={{
          title: '홈',
          tabBarIcon: ({ color, size, focused }) => (
            <TabBarIcon focused={focused} name="home"
              color={focused ? color : colors.navigationHomeInactive} size={size} />
          ),
        }}
      />
      <Tab.Screen
        name="MarketTab"
        component={MarketStack}
        options={({ route }) => ({
          title: '마켓',
          // A detail (spot or futures) owns the bottom safe area and its persistent order actions.
          ...(['AssetDetail', 'FuturesDetail'].includes(getFocusedRouteNameFromRoute(route) ?? '')
            ? { tabBarStyle: { display: 'none' } }
            : {}),
          tabBarIcon: ({ color, size, focused }) => (
            <TabBarIcon focused={focused} name="market" color={color} size={size} />
          ),
        })}
      />
      {mode === 'beginner' ? (
        <Tab.Screen name="QuestTab" component={QuestStack} options={{
          title: '퀘스트',
          // Reserve room for the three-character label at larger text sizes.
          tabBarItemStyle: fontScale > 1 ? { flex: 1.4 } : undefined,
          tabBarIcon: ({ color, size, focused }) => <TabBarIcon focused={focused} name="quest" color={color} size={size} />,
        }} />
      ) : mode === 'general' || mode === 'guest' ? (
        <Tab.Screen
          name="GuideTab"
          component={GuideStack}
          options={{
            title: '가이드',
            // Beside the guest's four-character 투자모드, the three-character
            // label needs Quest's allowance at larger text sizes too.
            tabBarItemStyle: mode === 'guest' && fontScale > 1 ? { flex: 1.4 } : undefined,
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
        component={mode === 'guest' ? GuestWalletStack : WalletStack}
        options={{
          title: '지갑',
          tabBarIcon: ({ color, size, focused }) => (
            <TabBarIcon focused={focused} name="wallet" color={color} size={size} />
          ),
        }}
      />
      {mode === 'guest' ? (
        // No account to show under MY: the investment modes instead.
        <Tab.Screen name="ModesTab" component={ModesStack} options={{
          title: '투자모드',
          // Room for the four-character label at larger text sizes: with
          // 가이드's 1.4, every label keeps ~8% spare at 320 pt and 2x text.
          tabBarItemStyle: fontScale > 1 ? { flex: 1.8 } : undefined,
          tabBarIcon: ({ color, size, focused }) => <TabBarIcon focused={focused} name="modes" color={color} size={size} />,
        }} />
      ) : (
        <Tab.Screen
          name="MyTab"
          component={MyStack}
          options={{
            title: 'MY',
            tabBarIcon: ({ color, size, focused }) => (
              <TabBarIcon focused={focused} name="menu" color={color} size={size} />
            ),
          }}
        />
      )}
    </Tab.Navigator>
  );

  // The quest guide spans the Quest and Wallet tabs of ONE beginner account;
  // keyed like the navigator, a switch or logout discards it with the tabs.
  // Bottom sheets of tab screens cover headers and the tab bar but stay below
  // the quest overlay, which the provider draws after its children.
  const hosted = <ScreenSheetHost>{tabs}</ScreenSheetHost>;
  if (mode === 'guest') {
    // A guest's 로그인 / 회원가입, from any tab or sheet: this root route's
    // own navigation resets to the auth stack.
    const exit = {
      signIn: () => leaveGuestBrowsing(props.navigation, 'Login'),
      signUp: () => leaveGuestBrowsing(props.navigation, 'Signup'),
    };
    return <GuestExitContext.Provider value={exit}>{hosted}</GuestExitContext.Provider>;
  }
  return mode === 'beginner' && account ? (
    <QuestGuideProvider key={account.id} accountId={account.id}>{hosted}</QuestGuideProvider>
  ) : hosted;
}
