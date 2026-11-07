import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { URL } from 'node:url';
import { tabTransition } from './transitionPolicy.ts';

const require = createRequire(import.meta.url);
const { elements, load } = require('../../../test/ledgerTestHarness.cjs');

const tabs = readFileSync(new URL('./MainTabs.tsx', import.meta.url), 'utf8');
const guideStack = readFileSync(
  new URL('./GuideStack.tsx', import.meta.url),
  'utf8',
);
const rankingStack = readFileSync(
  new URL('./RankingStack.tsx', import.meta.url),
  'utf8',
);
const icons = readFileSync(
  new URL('../../components/navigation/TabBarIcon.tsx', import.meta.url),
  'utf8',
);

type AccountMode = 'general' | 'season' | 'beginner';

function renderTabs(mode: AccountMode | null, isLoading = false, appearance: 'light' | 'dark' = 'light', reduced = false, accountId = `${mode}-account`, guest = false) {
  // Tab screens' bottom sheets render in ScreenSheetHost; the navigator contract is inside it
  // (beside the 앱 업데이트 안내, which opens in the same sheet layer).
  const unwrap = (node: any) => node?.type === 'ScreenSheetHost'
    ? [node.props.children].flat().find((child: any) => child?.type !== 'AppUpdateNotice') : node;
  const tree: any = renderHostedTabs(mode, isLoading, appearance, reduced, accountId, guest);
  // Guest tabs: the exit provider wraps the hosted navigator.
  const hosted = guest && tree?.props?.value ? tree.props.children : tree;
  return hosted?.type === 'QuestGuideProvider' ? { ...hosted, props: { ...hosted.props, children: unwrap(hosted.props.children) } } : unwrap(hosted);
}

function renderHostedTabs(mode: AccountMode | null, isLoading = false, appearance: 'light' | 'dark' = 'light', reduced = false, accountId = `${mode}-account`, guest = false, navigation: unknown = undefined, read: { isEmpty?: boolean; accountReadError?: unknown; retryAccountRead?: () => void } = {}) {
  const MainTabs = load(resolve('src/app/navigation/MainTabs.tsx'), {
    'react-native': { Text: 'Text', useWindowDimensions: () => ({ fontScale: 1 }) },
    'react-native-safe-area-context': {
      useSafeAreaInsets: () => ({ bottom: 0 }),
    },
    '@react-navigation/native': { getFocusedRouteNameFromRoute: route => route.params?.screen },
    '@react-navigation/bottom-tabs': {
      createBottomTabNavigator: () => ({
        Navigator: 'Navigator',
        Screen: 'Screen',
      }),
    },
    '../../theme/appearance': { useAppearance: () => ({ mode: appearance, colors: appearance === 'light'
      ? { navigation: '#ffffff', navigationActive: '#202a35', secondaryActionForeground: '#285B85', navigationInactive: '#697583', navigationHomeInactive: '#111111', border: '#dfe4e9' }
      : { navigation: '#080a0d', navigationActive: '#ffffff', secondaryActionForeground: '#B9DDFC', navigationInactive: '#9aa8b6', navigationHomeInactive: '#9aa8b6', border: '#3b3d43' } }) },
    '../../theme/useReducedMotion': { useReducedMotion: () => reduced },
    '../../components/navigation/TabBarButton': {
      default: 'TabBarButton',
      __esModule: true,
    },
    '../../components/navigation/TabBarIcon': {
      default: 'TabBarIcon',
      __esModule: true,
    },
    '../../components/states/FullPageLoading': {
      default: 'FullPageLoading',
      __esModule: true,
    },
    '../../components/states/ErrorState': { default: 'ErrorState', __esModule: true },
    '../../features/tradingAccount/TradingAccountContext': {
      useTradingAccount: () => ({
        selectedAccount: mode ? { id: accountId, mode } : null,
        isLoading,
        isEmpty: read.isEmpty ?? false,
        accountReadError: read.accountReadError ?? null,
        retryAccountRead: read.retryAccountRead ?? (() => undefined),
      }),
    },
    '../../features/quest/QuestGuideProvider': { QuestGuideProvider: 'QuestGuideProvider' },
    '../../components/common/ScreenSheetHost': { ScreenSheetHost: 'ScreenSheetHost' },
    '../../features/appRelease/AppUpdateNotice': { default: 'AppUpdateNotice', __esModule: true },
    '../../features/auth/guestBrowsing': { isGuestBrowsing: () => guest },
    ...Object.fromEntries(
      ['Home', 'Market', 'Guide', 'Ranking', 'Community', 'Wallet', 'My', 'Modes'].map((name) => [
        `./${name}Stack`,
        { default: `${name}Stack`, QuestStack: 'QuestStack', MemberGuideStack: 'MemberGuideStack', GuestHomeStack: 'GuestHomeStack', GuestWalletStack: 'GuestWalletStack', __esModule: true },
      ]),
    ),
  }).default;

  return MainTabs({ navigation } as never);
}

function screenOptions(screen: any, route = {}) {
  return typeof screen.props.options === 'function'
    ? screen.props.options({ route })
    : screen.props.options;
}

/** A route kept for navigation but left out of the tab bar (no button, no room). */
function hidden(screen: any) {
  const options = screenOptions(screen);
  return typeof options.tabBarButton === 'function' && options.tabBarButton({}) === null && options.tabBarItemStyle?.display === 'none';
}

function tabContract(tree: unknown, which: 'visible' | 'hidden' = 'visible') {
  return elements(tree, 'Screen').filter((screen: any) => hidden(screen) === (which === 'hidden')).map((screen: any) => {
    const options = screenOptions(screen);
    const icon = options.tabBarIcon({
      color: '#123456',
      size: 25,
    });

    return [
      screen.props.name,
      screen.props.component,
      options.title,
      icon.props.name,
    ];
  });
}

describe('mode-aware bottom tabs', () => {
  it('shows 커뮤니티 as the third of exactly five tabs for a general account, 가이드 kept as a hidden route', () => {
    const tree = renderTabs('general');
    assert.deepEqual(tabContract(tree), [
      ['HomeTab', 'HomeStack', '홈', 'home'],
      ['MarketTab', 'MarketStack', '마켓', 'market'],
      ['CommunityTab', 'CommunityStack', '커뮤니티', 'community'],
      ['WalletTab', 'WalletStack', '지갑', 'wallet'],
      ['MyTab', 'MyStack', 'MY', 'menu'],
    ]);
    // Home's 가이드 opens it; its first screen goes back to Home (MemberGuideStack).
    assert.deepEqual(tabContract(tree, 'hidden'), [['GuideTab', 'MemberGuideStack', '가이드', 'guide']]);
  });

  it('keeps Ranking third of exactly five tabs for a season account, labelled 리그', () => {
    const tree = renderTabs('season');
    assert.deepEqual(tabContract(tree), [
      ['HomeTab', 'HomeStack', '홈', 'home'],
      ['MarketTab', 'MarketStack', '마켓', 'market'],
      ['RankingTab', 'RankingStack', '리그', 'ranking'],
      ['WalletTab', 'WalletStack', '지갑', 'wallet'],
      ['MyTab', 'MyStack', 'MY', 'menu'],
    ]);
    assert.deepEqual(tabContract(tree, 'hidden'), []);
  });

  for (const mode of ['beginner', 'general', 'season'] as const) {
    it(`${mode}: community post screens own the bottom edge (the tab bar hides there only)`, () => {
      const tab = elements(renderTabs(mode), 'Screen').find((screen: any) => screen.props.name === (mode === 'season' ? 'RankingTab' : 'CommunityTab'));
      for (const name of [undefined, 'Community', 'Ranking', 'UserSeasonSummary', 'PostDetail', 'PostCompose']) {
        const options = screenOptions(tab, { name: tab.props.name, params: name ? { screen: name } : undefined });
        assert.equal(options.tabBarStyle?.display === 'none', name === 'PostDetail' || name === 'PostCompose', String(name));
      }
    });
  }

  for (const mode of ['general', 'season'] as const) {
    it(`${mode}: hides the tab bar only for the detail screens (AssetDetail, FuturesDetail) and restores it on Market routes`, () => {
      const tree = renderTabs(mode);
      const screens = elements(tree, 'Screen');
      const market = screens.find((screen: any) => screen.props.name === 'MarketTab');
      const defaultStyle = tree.props.screenOptions.tabBarStyle;

      // Nested screen params are available before the child navigator mounts.
      for (const name of [undefined, 'Market', 'MarketSearch', 'AssetDetail', 'MarketSearch', 'FuturesDetail', 'Futures', 'Order', 'Market']) {
        const route = { name: 'MarketTab', params: name ? { screen: name } : undefined };
        const options = screenOptions(market, route);
        assert.equal(options.title, '마켓');
        if (name === 'AssetDetail' || name === 'FuturesDetail') {
          assert.deepEqual(options.tabBarStyle, { display: 'none' });
        } else {
          assert.equal(options.tabBarStyle, undefined, 'inherits the navigator tab bar style');
          assert.equal(defaultStyle.display, undefined);
          assert.equal(defaultStyle.backgroundColor, '#ffffff');
        }
      }
      for (const screen of screens.filter((screen: any) => screen !== market)) {
        assert.equal(screenOptions(screen).tabBarStyle, undefined, screen.props.name);
      }
    });
  }

  it('remounts at Home when account mode changes, dropping the removed tab state', () => {
    const general = renderTabs('general');
    const season = renderTabs('season');

    assert.equal(general.key, 'general-account');
    assert.equal(season.key, 'season-account');
    assert.notEqual(general.key, season.key);
    assert.equal(general.props.initialRouteName, 'HomeTab');
    assert.equal(season.props.initialRouteName, 'HomeTab');
  });

  it('shows no mode-specific tabs before the selected account is known', () => {
    for (const tree of [
      renderTabs('season', true),
      renderTabs(null, true),
    ]) {
      assert.equal(tree.type, 'FullPageLoading');
      assert.equal(tree.props.message, '계정 정보를 불러오는 중입니다.');
      assert.equal(elements(tree, 'Screen').length, 0);
    }
  });

  it('a finished read without an account is never an endless loader: why, retry and a way back to the start', () => {
    const calls: string[] = [];
    const navigation = { reset: (state: unknown) => calls.push(JSON.stringify(state)) };
    const failure = new Error('timeout of 10000ms exceeded');
    const failed: any = renderHostedTabs(null, false, 'light', false, 'x', false, navigation, { accountReadError: failure, retryAccountRead: () => calls.push('retry') });
    assert.equal(failed.type, 'ErrorState');
    assert.equal(elements(failed, 'Screen').length, 0, 'no tabs of a mode that is not known');
    assert.deepEqual([failed.props.title, failed.props.message, failed.props.error === failure],
      ['계정 정보를 불러오지 못했습니다.', '네트워크 연결을 확인한 뒤 다시 시도해주세요.', true]);
    failed.props.onRetry();
    // 처음 화면으로: the error screen's second way out (never an endless loader with no exit).
    const restart = failed.props.secondaryAction;
    assert.deepEqual([restart?.label, restart?.testID], ['처음 화면으로', 'main-tabs-restart']);
    restart.onPress();
    assert.deepEqual(calls, ['retry', JSON.stringify({ index: 0, routes: [{ name: 'Splash' }] })]);

    const empty: any = renderHostedTabs(null, false, 'light', false, 'x', false, navigation, { isEmpty: true });
    assert.deepEqual([empty.type, empty.props.title, empty.props.message],
      ['ErrorState', '사용할 계정이 없습니다.', '처음 화면에서 투자 모드를 다시 선택해주세요.']);
    const unresolved: any = renderHostedTabs(null, false);
    assert.deepEqual([unresolved.type, unresolved.props.title], ['ErrorState', '계정 정보를 불러오지 못했습니다.']);
  });

  it('extends the existing Guide stack with MarketBasics and leaves Ranking intact', () => {
    assert.equal([...guideStack.matchAll(/<Stack\.Screen\b/g)].length, 9);
    assert.match(guideStack, /name="Guide"/);
    assert.match(guideStack, /component=\{beginner \? BeginnerLearningScreen : GuideScreen\}/);
    // Quests start the real Wallet practice directly: no text detail route.
    assert.doesNotMatch(guideStack, /QuestDetail|BeginnerQuestDetailScreen/);
    assert.match(guideStack, /name="MarketBasics"/);
    assert.match(guideStack, /component=\{MarketBasicsScreen\}/);
    assert.match(guideStack, /component=\{MarketBasicsChaptersScreen\}/);
    for (const route of ['OrderBookLesson', 'Liquidity', 'Candles', 'OrderTypes', 'StockCharacteristics', 'EtfIndex', 'GuideChapter']) {
      assert.ok(guideStack.includes(`name="${route}"`));
    }
    assert.match(guideStack, /title: '시장기초'/);
    // 리그: the ranking root (랭킹 | 커뮤니티 sections), 유저 시즌 요약 and the community post screens.
    assert.equal([...rankingStack.matchAll(/<Stack\.Screen\b/g)].length, 4);
    for (const route of ['Ranking', 'UserSeasonSummary', 'PostDetail', 'PostCompose']) assert.ok(rankingStack.includes(`name="${route}"`), route);
    assert.match(rankingStack, /component=\{LeagueScreen\}/);
  });
});

describe('bottom tab icon contract', () => {
  it('draws every icon with consistent SVG strokes, without text or font assets', () => {
    assert.match(icons, /import Svg, \{ Circle, Path \} from 'react-native-svg'/);
    assert.deepEqual(
      [...new Set([...icons.matchAll(/case '(\w+)':/g)].map((match) => match[1]))],
      ['market', 'guide', 'quest', 'ranking', 'wallet', 'record', 'menu', 'modes', 'community', 'profile'],
    );
    assert.match(icons, /width=\{size\}\s+height=\{size\}/);
    assert.match(icons, /viewBox="0 0 24 24"/);
    assert.match(icons, /fill=\{focused \? color : 'none'\}/);
    assert.match(icons, /stroke=\{focused \? 'none' : color\}/);
    assert.match(icons, /name === 'home'/);
    assert.match(icons, /strokeLinecap="round"\s+strokeLinejoin="round"/);
    assert.doesNotMatch(
      icons,
      /<Text|<Image|fontFamily|vector-icons|lucide|#[\da-f]{3,8}\b/i,
    );
    assert.doesNotMatch(icons, /[^\x00-\x7F]/);
  });

  it('leaves accessibility on the tab and prevents duplicate icon announcements', () => {
    assert.match(icons, /accessible=\{false\}/);
    assert.match(icons, /accessibilityElementsHidden/);
    assert.match(icons, /importantForAccessibility="no-hide-descendants"/);
    assert.match(icons, /aria-hidden/);
    assert.match(icons, /focusable=\{false\}/);
  });

  it('keeps labels below icons and reserves safe-area space when fonts grow', () => {
    assert.match(tabs, /tabBarLabelPosition: 'below-icon'/);
    assert.match(tabs, /fontScale.*useWindowDimensions\(\)/);
    assert.match(tabs, /insets = useSafeAreaInsets\(\)/);
    assert.match(
      tabs,
      /fontScale > 1\s*\? \{ height: 49 \+ Math\.ceil\(14 \* \(fontScale - 1\)\) \+ insets\.bottom \}\s*: \{\}/,
    );
    assert.doesNotMatch(tabs, /tabBarAllowFontScaling:\s*false/);
    assert.match(tabs, /tabBarActiveTintColor: primaryGradient.colors\[0\]/);
    assert.match(tabs, /tabBarInactiveTintColor: colors.navigationInactive/);
    assert.match(tabs, /backgroundColor: colors.navigation/);
  });
});

describe('bottom tab visual states', () => {
  it('preserves filled active icons and outline inactive icons', () => {
    const Icon = load(resolve('src/components/navigation/TabBarIcon.tsx'), {
      'react-native': { View: 'View' },
      'react-native-svg': { default: 'Svg', Circle: 'Circle', Path: 'Path', __esModule: true },
    }).default;
    for (const name of ['home', 'market', 'guide', 'quest', 'ranking', 'wallet', 'record', 'menu', 'modes', 'community']) {
      const active = elements(Icon({ name, color: '#ffffff', size: 25, focused: true }), 'Svg')[0];
      const inactive = elements(Icon({ name, color: '#aebbc8', size: 25, focused: false }), 'Svg')[0];
      assert.equal(active.props.fill, '#ffffff'); assert.equal(active.props.stroke, 'none');
      assert.equal(inactive.props.fill, 'none'); assert.equal(inactive.props.stroke, '#aebbc8');
      assert.equal(active.props.width, 25); assert.equal(inactive.props.width, 25);
    }
  });

  for (const mode of ['general', 'season'] as const) {
    for (const appearance of ['light', 'dark'] as const) {
      it(`${mode}/${appearance}: uses Primary Blue for every active tab and keeps inactive colors and motion`, () => {
        const tree = renderTabs(mode, false, appearance);
        const options = tree.props.screenOptions;
        assert.equal(options.tabBarActiveTintColor, '#326FE5');
        assert.equal(options.tabBarInactiveTintColor, appearance === 'light' ? '#697583' : '#9aa8b6');
        assert.equal(options.tabBarStyle.backgroundColor, appearance === 'light' ? '#ffffff' : '#080a0d');

        // Let Navigation apply the same tint to its default label and each icon.
        assert.equal(options.tabBarLabel, undefined);
        assert.equal(options.tabBarLabelStyle?.color, undefined);
        for (const screen of elements(tree, 'Screen')) {
          const tab = screenOptions(screen);
          assert.equal(tab.tabBarActiveTintColor, undefined);
          assert.equal(tab.tabBarInactiveTintColor, undefined);
          assert.equal(tab.tabBarLabel, undefined);
          assert.equal(tab.tabBarLabelStyle?.color, undefined);
          for (const focused of [true, false]) {
            const color = focused ? options.tabBarActiveTintColor : options.tabBarInactiveTintColor;
            const icon = tab.tabBarIcon({ color, size: 25, focused });
            const expected = screen.props.name === 'HomeTab' && !focused && appearance === 'light'
              ? '#111111' : color;
            assert.equal(icon.props.color, expected, screen.props.name);
            assert.equal(icon.props.focused, focused, screen.props.name);
          }
        }

        // The harness platform is Android: tabs switch in place there.
        assert.equal(options.animation, 'none');
        assert.deepEqual(options.transitionSpec, tabTransition(false, 'android').transitionSpec);
        const reduced = renderTabs(mode, false, appearance, true).props.screenOptions;
        assert.equal(reduced.animation, 'none');
        assert.deepEqual(reduced.transitionSpec, tabTransition(true, 'android').transitionSpec);
        assert.equal(reduced.tabBarActiveTintColor, '#326FE5');
      });
    }
  }
});


it('beginner has exactly five tabs with 커뮤니티 third and MY last; 퀘스트 stays a hidden route', () => {
  const tree = renderTabs('beginner');
  assert.deepEqual(tabContract(tree), [
    ['HomeTab', 'HomeStack', '홈', 'home'], ['MarketTab', 'MarketStack', '마켓', 'market'],
    ['CommunityTab', 'CommunityStack', '커뮤니티', 'community'], ['WalletTab', 'WalletStack', '지갑', 'wallet'],
    ['MyTab', 'MyStack', 'MY', 'menu'],
  ]);
  // The quest guide is bound to the QuestTab name: kept under it, opened from Home's 퀘스트.
  assert.deepEqual(tabContract(tree, 'hidden'), [['QuestTab', 'QuestStack', '퀘스트', 'quest']]);
});

it('every mode shows exactly five tabs; hidden routes come after them', () => {
  for (const [mode, guest] of [['beginner', false], ['general', false], ['season', false], [null, true]] as const) {
    const screens = elements(renderTabs(mode, false, 'light', false, undefined, guest), 'Screen');
    const visible = screens.filter((screen: any) => !hidden(screen));
    assert.equal(visible.length, 5, String(mode));
    assert.equal(screens.findIndex((screen: any) => hidden(screen)) === -1 || screens.findIndex((screen: any) => hidden(screen)) >= 5, true, String(mode));
  }
  // The four-character 커뮤니티 gets 투자모드's allowance at larger text sizes.
  assert.match(tabs, /title: '커뮤니티',[\s\S]*?tabBarItemStyle: fontScale > 1 \? \{ flex: 1\.8 \} : undefined/);
});
it('beginner tabs run inside one quest guide keyed by the account, unlike other modes', () => {
  const beginner = renderTabs('beginner', false, 'light', false, 'beginner-one');
  assert.equal(beginner.type, 'QuestGuideProvider');
  assert.equal(beginner.key, 'beginner-one');
  assert.equal(beginner.props.accountId, 'beginner-one');
  assert.equal(beginner.props.children.key, 'beginner-one', 'the navigator stays keyed by account too');
  assert.notEqual(renderTabs('beginner', false, 'light', false, 'beginner-two').key, beginner.key);
  for (const mode of ['general', 'season'] as const) {
    assert.equal(renderTabs(mode).type, 'Navigator', `${mode} has no quest guide`);
  }
  // Sheets cover the tabs (headers, tab bar) but the quest overlay stays above them.
  assert.equal((renderHostedTabs('beginner') as any).props.children.type, 'ScreenSheetHost');
  for (const mode of ['general', 'season'] as const) assert.equal((renderHostedTabs(mode) as any).type, 'ScreenSheetHost');
  // 앱 업데이트 안내: once, in that sheet layer (so below the quest overlay), for every mode and guests.
  const notices = (host: any) => [host.props.children].flat().filter((child: any) => child?.type === 'AppUpdateNotice').length;
  assert.equal(notices((renderHostedTabs('beginner') as any).props.children), 1);
  for (const mode of ['general', 'season'] as const) assert.equal(notices(renderHostedTabs(mode)), 1);
  assert.equal(notices((renderHostedTabs(null, false, 'light', false, 'guest', true) as any).props.children), 1);
});
it('even switching two season accounts resets nested navigation by account id', () => {
  assert.notEqual(renderTabs('season', false, 'light', false, 'season-one').key, renderTabs('season', false, 'light', false, 'season-two').key);
});

describe('guest browsing tabs (로그인 없이 둘러보기)', () => {
  it('shows Home, Market, Guide, Wallet and 투자모드 — no MY, Ranking or Quest', () => {
    assert.deepEqual(tabContract(renderTabs(null, false, 'light', false, undefined, true)), [
      ['HomeTab', 'GuestHomeStack', '홈', 'home'],
      ['MarketTab', 'MarketStack', '마켓', 'market'],
      ['GuideTab', 'GuideStack', '가이드', 'guide'],
      ['WalletTab', 'GuestWalletStack', '지갑', 'wallet'],
      ['ModesTab', 'ModesStack', '투자모드', 'modes'],
    ]);
  });

  it('needs no account: it never waits on the account provider and keys itself apart', () => {
    for (const loading of [false, true]) {
      const tree = renderTabs(null, loading, 'light', false, undefined, true);
      assert.equal(tree.type, 'Navigator');
      assert.equal(tree.key, 'guest');
      assert.equal(tree.props.initialRouteName, 'HomeTab');
    }
    // A stale account in the provider never turns guest tabs into its mode's tabs.
    const names = elements(renderTabs('season', false, 'light', false, 'season-account', true), 'Screen')
      .map((screen: any) => screen.props.name);
    assert.deepEqual(names, ['HomeTab', 'MarketTab', 'GuideTab', 'WalletTab', 'ModesTab']);
  });

  it('keeps the members\' MY tab and mode tabs unchanged', () => {
    for (const mode of ['general', 'season', 'beginner'] as const) {
      const names = elements(renderTabs(mode), 'Screen').filter((screen: any) => !hidden(screen)).map((screen: any) => screen.props.name);
      assert.equal(names.at(-1), 'MyTab', mode);
      assert.ok(!names.includes('ModesTab'), mode);
    }
  });

  it('reserves room for 가이드 and the four-character 투자모드 only when fonts grow', () => {
    const items = (tree: unknown) => Object.fromEntries(elements(tree, 'Screen')
      .map((screen: any) => [screen.props.name, screenOptions(screen).tabBarItemStyle]));
    const guest = items(renderTabs(null, false, 'light', false, undefined, true));
    assert.equal(Object.values(guest).every((style) => style === undefined), true, 'fontScale 1: equal tabs');
    assert.match(tabs, /title: '투자모드',[\s\S]*?tabBarItemStyle: fontScale > 1 \? \{ flex: 1\.8 \} : undefined/);
    assert.match(tabs, /title: '가이드',[\s\S]*?tabBarItemStyle: mode === 'guest' && fontScale > 1 \? \{ flex: 1\.4 \} : undefined/);
    // Members' 가이드 is a hidden route: it takes no room at any text size.
    assert.deepEqual(items(renderTabs('general')).GuideTab, { display: 'none' });
  });

  it('offers 로그인 and 회원가입 from any tab through its own root navigation', () => {
    const resets: any[] = [];
    const tree: any = renderHostedTabs(null, false, 'light', false, undefined, true, { reset: (state: unknown) => resets.push(state) });
    assert.equal(tree.props.children.type, 'ScreenSheetHost');
    tree.props.value.signIn();
    tree.props.value.signUp();
    assert.deepEqual(resets, [
      { index: 0, routes: [{ name: 'AuthStack', state: { index: 0, routes: [{ name: 'Login' }] } }] },
      { index: 0, routes: [{ name: 'AuthStack', state: { index: 1, routes: [{ name: 'Login' }, { name: 'Signup' }] } }] },
    ]);
    // Members get no exit provider.
    for (const mode of ['general', 'season'] as const) assert.equal((renderHostedTabs(mode) as any).type, 'ScreenSheetHost');
  });
});
