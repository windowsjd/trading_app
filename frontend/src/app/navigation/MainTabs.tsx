import React from 'react';
import ModeSelectionScreen from '../../screens/entry/ModeSelectionScreen';
import { useWindowDimensions } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { getFocusedRouteNameFromRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppearance } from '../../theme/appearance';
import { Platform } from '../../theme/native';
import { primaryGradient } from '../../theme/tokens';
import { useReducedMotion } from '../../theme/useReducedMotion';
import { tabTransition } from './transitionPolicy';
import { MAIN_TABS_BACK_BEHAVIOR, mainTabsRouter } from './tabBackPolicy';

import TabBarIcon from '../../components/navigation/TabBarIcon';
import TabBarButton from '../../components/navigation/TabBarButton';
import FullPageLoading from '../../components/states/FullPageLoading';
import ErrorState from '../../components/states/ErrorState';
import { useTradingAccount } from '../../features/tradingAccount/TradingAccountContext';
import { ScreenSheetHost } from '../../components/common/ScreenSheetHost';
import { QuestGuideProvider } from '../../features/quest/QuestGuideProvider';
import AppUpdateNotice from '../../features/appRelease/AppUpdateNotice';
import NoticePopupHost from '../../features/notice/NoticePopupHost';
import SeasonResultAutoOpen from '../../features/season/SeasonResultAutoOpen';
import { EntryOverlayProvider } from '../../features/entryOverlay/EntryOverlaySlot';
import { isGuestBrowsing } from '../../features/auth/guestBrowsing';
import { GuestExitContext } from '../../components/guest/guestExit';
import { leaveGuestBrowsing } from './seasonRouting';
import type { MainTabParamList, MainTabsScreenProps } from './types';
import HomeStack, { GuestHomeStack } from './HomeStack';
import MarketStack from './MarketStack';
import GuideStack, { MemberGuideStack, QuestStack } from './GuideStack';
import RankingStack from './RankingStack';
import CommunityStack from './CommunityStack';
import WalletStack, { GuestWalletStack } from './WalletStack';
import MyStack from './MyStack';
import ModesStack from './ModesStack';

const Tab = createBottomTabNavigator<MainTabParamList>();

/** Community post screens own the bottom edge (the comment bar, the composer's bar). */
const COMMUNITY_FULL_SCREEN_ROUTES = ['PostDetail', 'PostCompose'];

/**
 * A route kept for navigation but left out of the tab bar (2026-11-07: the
 * beginner's 퀘스트 and the general member's 가이드, opened from Home's
 * header). The same pair expo-router uses for `href: null`: no button is
 * rendered and the item takes no room.
 */
const HIDDEN_TAB = { tabBarButton: () => null, tabBarItemStyle: { display: 'none' as const } };

export default function MainTabs(props: MainTabsScreenProps) {
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { colors } = useAppearance();
  const reducedMotion = useReducedMotion();
  const { selectedAccount, isLoading, isEmpty, accountReadError, retryAccountRead } = useTradingAccount();
  // 「로그인 없이 둘러보기」: no account at all, so nothing to wait for. A
  // signed-in user never reaches here as a guest (a session ends browsing).
  const guest = isGuestBrowsing();
  const account = guest ? null : selectedAccount;

  // The entry flow normally resolves the account before MainTabs mounts. Keep
  // tabs hidden during provider refreshes as well, so neither mode briefly
  // exposes the other mode's third tab.
  if (!guest && isLoading) {
    return <FullPageLoading message="계정 정보를 불러오는 중입니다." />;
  }
  // Loaded and still no account: the read failed, or came back without one. Never an
  // endless loader with no tab bar and no way out — say why, retry, or start over.
  if (!guest && !account && isEmpty && !accountReadError) {
    return <ModeSelectionScreen navigation={props.navigation} />;
  }
  if (!guest && !account) {
    return (
      <ErrorState
        error={accountReadError ?? undefined}
        title={accountReadError || !isEmpty ? '계정 정보를 불러오지 못했습니다.' : '사용할 계정이 없습니다.'}
        message={accountReadError || !isEmpty ? '네트워크 연결을 확인한 뒤 다시 시도해주세요.' : '처음 화면에서 투자 모드를 다시 선택해주세요.'}
        onRetry={retryAccountRead}
        secondaryAction={{ label: '처음 화면으로', testID: 'main-tabs-restart', onPress: () => props.navigation.reset({ index: 0, routes: [{ name: 'Splash' }] }) }}
      />
    );
  }

  const mode = account?.mode ?? 'guest';
  // Every mode shows exactly five tabs. Hidden routes come last, so the iOS
  // "n of 5" announcement stays true for the visible ones.
  const position = (title: string, index: number) => Platform.OS === 'ios' ? `${title}, tab, ${index} of 5` : undefined;
  const hideOnPostScreens = (route: Parameters<typeof getFocusedRouteNameFromRoute>[0]) =>
    COMMUNITY_FULL_SCREEN_ROUTES.includes(getFocusedRouteNameFromRoute(route) ?? '') ? { tabBarStyle: { display: 'none' as const } } : {};

  const tabs = (
    <Tab.Navigator
      key={account?.id ?? 'guest'}
      id="MainTabs"
      initialRouteName="HomeTab"
      // Back on a tab's first screen: the tab visited before it, then Home (tabBackPolicy).
      backBehavior={MAIN_TABS_BACK_BEHAVIOR}
      // That Back-to-Home step; an active beginner quest holds tab switches outside its practice.
      UNSTABLE_router={mainTabsRouter}
      screenOptions={{
        headerShown: false,
        tabBarButton: (props) => <TabBarButton {...props} reducedMotion={reducedMotion} />,
        tabBarLabelPosition: 'below-icon',
        tabBarActiveTintColor: primaryGradient.colors[0],
        tabBarInactiveTintColor: colors.navigationInactive,
        ...tabTransition(reducedMotion, Platform.OS),
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
          tabBarAccessibilityLabel: position('홈', 1),
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
          tabBarAccessibilityLabel: position('마켓', 2),
          // A detail (spot or futures) owns the bottom safe area and its persistent order actions.
          ...(['AssetDetail', 'FuturesDetail'].includes(getFocusedRouteNameFromRoute(route) ?? '')
            ? { tabBarStyle: { display: 'none' } }
            : {}),
          tabBarIcon: ({ color, size, focused }) => (
            <TabBarIcon focused={focused} name="market" color={color} size={size} />
          ),
        })}
      />
      {mode === 'beginner' || mode === 'general' ? (
        <Tab.Screen
          name="CommunityTab"
          component={CommunityStack}
          options={({ route }) => ({
            title: '커뮤니티',
            tabBarAccessibilityLabel: position('커뮤니티', 3),
            // Room for the four-character label at larger text sizes (as 투자모드).
            tabBarItemStyle: fontScale > 1 ? { flex: 1.8 } : undefined,
            ...hideOnPostScreens(route),
            tabBarIcon: ({ color, size, focused }) => (
              <TabBarIcon focused={focused} name="community" color={color} size={size} />
            ),
          })}
        />
      ) : mode === 'guest' ? (
        <Tab.Screen
          name="GuideTab"
          component={GuideStack}
          options={{
            title: '가이드',
            tabBarAccessibilityLabel: position('가이드', 3),
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
          options={({ route }) => ({
            // 리그: 랭킹 | 커뮤니티 (the header's text tabs switch them).
            title: '리그',
            tabBarAccessibilityLabel: position('리그', 3),
            ...hideOnPostScreens(route),
            tabBarIcon: ({ color, size, focused }) => (
              <TabBarIcon focused={focused} name="ranking" color={color} size={size} />
            ),
          })}
        />
      )}
      <Tab.Screen
        name="WalletTab"
        component={mode === 'guest' ? GuestWalletStack : WalletStack}
        options={{
          title: '지갑',
          tabBarAccessibilityLabel: position('지갑', 4),
          tabBarIcon: ({ color, size, focused }) => (
            <TabBarIcon focused={focused} name="wallet" color={color} size={size} />
          ),
        }}
      />
      {mode === 'guest' ? (
        // No account to show under MY: the investment modes instead.
        <Tab.Screen name="ModesTab" component={ModesStack} options={{
          title: '투자모드',
          tabBarAccessibilityLabel: position('투자모드', 5),
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
            tabBarAccessibilityLabel: position('MY', 5),
            tabBarIcon: ({ color, size, focused }) => (
              <TabBarIcon focused={focused} name="menu" color={color} size={size} />
            ),
          }}
        />
      )}
      {mode === 'beginner' ? (
        // Hidden: Home's 퀘스트 opens it; the quest guide still targets this name.
        <Tab.Screen name="QuestTab" component={QuestStack} options={{
          title: '퀘스트',
          ...HIDDEN_TAB,
          tabBarIcon: ({ color, size, focused }) => <TabBarIcon focused={focused} name="quest" color={color} size={size} />,
        }} />
      ) : mode === 'general' ? (
        // Hidden: Home's 가이드 opens it.
        <Tab.Screen name="GuideTab" component={MemberGuideStack} options={{
          title: '가이드',
          ...HIDDEN_TAB,
          tabBarIcon: ({ color, size, focused }) => <TabBarIcon focused={focused} name="guide" color={color} size={size} />,
        }} />
      ) : null}
    </Tab.Navigator>
  );

  // The quest guide spans the Quest and Wallet tabs of ONE beginner account;
  // keyed like the navigator, a switch or logout discards it with the tabs.
  // Bottom sheets of tab screens cover headers and the tab bar but stay below
  // the quest overlay, which the provider draws after its children.
  // 앱 업데이트 안내 and the members' 공지 팝업 open in the same layer once the
  // app is entered normally — one at a time (EntryOverlayProvider), the
  // popup only for a signed-in member. A season account's settled, unseen
  // 시즌최종결과 (2026-11-14) takes the same slot before it opens on its own.
  const hosted = (
    <ScreenSheetHost>
      {tabs}
      <EntryOverlayProvider>
        <AppUpdateNotice />
        <NoticePopupHost enabled={mode !== 'guest'} />
        <SeasonResultAutoOpen enabled={mode !== 'guest'} />
      </EntryOverlayProvider>
    </ScreenSheetHost>
  );
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
