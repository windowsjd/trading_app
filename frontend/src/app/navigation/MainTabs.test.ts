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
  // Tab screens' bottom sheets render in ScreenSheetHost; the navigator contract is inside it.
  const unwrap = (node: any) => node?.type === 'ScreenSheetHost' ? node.props.children : node;
  const tree: any = renderHostedTabs(mode, isLoading, appearance, reduced, accountId, guest);
  // Guest tabs: the exit provider wraps the hosted navigator.
  const hosted = guest && tree?.props?.value ? tree.props.children : tree;
  return hosted?.type === 'QuestGuideProvider' ? { ...hosted, props: { ...hosted.props, children: unwrap(hosted.props.children) } } : unwrap(hosted);
}

function renderHostedTabs(mode: AccountMode | null, isLoading = false, appearance: 'light' | 'dark' = 'light', reduced = false, accountId = `${mode}-account`, guest = false, navigation: unknown = undefined) {
  const MainTabs = load(resolve('src/app/navigation/MainTabs.tsx'), {
    'react-native': { useWindowDimensions: () => ({ fontScale: 1 }) },
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
    '../../features/tradingAccount/TradingAccountContext': {
      useTradingAccount: () => ({
        selectedAccount: mode ? { id: accountId, mode } : null,
        isLoading,
      }),
    },
    '../../features/quest/QuestGuideProvider': { QuestGuideProvider: 'QuestGuideProvider' },
    '../../components/common/ScreenSheetHost': { ScreenSheetHost: 'ScreenSheetHost' },
    '../../features/auth/guestBrowsing': { isGuestBrowsing: () => guest },
    ...Object.fromEntries(
      ['Home', 'Market', 'Guide', 'Ranking', 'Wallet', 'My', 'Modes'].map((name) => [
        `./${name}Stack`,
        { default: `${name}Stack`, QuestStack: 'QuestStack', GuestHomeStack: 'GuestHomeStack', GuestWalletStack: 'GuestWalletStack', __esModule: true },
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

function tabContract(tree: unknown) {
  return elements(tree, 'Screen').map((screen: any) => {
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
  it('shows Guide as the third of five tabs for a general account', () => {
    assert.deepEqual(tabContract(renderTabs('general')), [
      ['HomeTab', 'HomeStack', '홈', 'home'],
      ['MarketTab', 'MarketStack', '마켓', 'market'],
      ['GuideTab', 'GuideStack', '가이드', 'guide'],
      ['WalletTab', 'WalletStack', '지갑', 'wallet'],
      ['MyTab', 'MyStack', 'MY', 'menu'],
    ]);
  });

  it('keeps Ranking as the third of five tabs for a season account', () => {
    assert.deepEqual(tabContract(renderTabs('season')), [
      ['HomeTab', 'HomeStack', '홈', 'home'],
      ['MarketTab', 'MarketStack', '마켓', 'market'],
      ['RankingTab', 'RankingStack', '랭킹', 'ranking'],
      ['WalletTab', 'WalletStack', '지갑', 'wallet'],
      ['MyTab', 'MyStack', 'MY', 'menu'],
    ]);
  });

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
      renderTabs(null, false),
    ]) {
      assert.equal(tree.type, 'FullPageLoading');
      assert.equal(tree.props.message, '계정 정보를 불러오는 중입니다.');
      assert.equal(elements(tree, 'Screen').length, 0);
    }
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
    assert.equal([...rankingStack.matchAll(/<Stack\.Screen\b/g)].length, 2);
    assert.match(rankingStack, /name="Ranking"/);
    assert.match(rankingStack, /name="UserSeasonSummary"/);
  });
});

describe('bottom tab icon contract', () => {
  it('draws every icon with consistent SVG strokes, without text or font assets', () => {
    assert.match(icons, /import Svg, \{ Circle, Path \} from 'react-native-svg'/);
    assert.deepEqual(
      [...new Set([...icons.matchAll(/case '(\w+)':/g)].map((match) => match[1]))],
      ['market', 'guide', 'quest', 'ranking', 'wallet', 'record', 'menu', 'modes', 'profile'],
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
    for (const name of ['home', 'market', 'guide', 'quest', 'ranking', 'wallet', 'record', 'menu', 'modes']) {
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

        assert.equal(options.animation, 'fade');
        assert.deepEqual(options.transitionSpec, tabTransition(false).transitionSpec);
        const reduced = renderTabs(mode, false, appearance, true).props.screenOptions;
        assert.equal(reduced.animation, 'none');
        assert.deepEqual(reduced.transitionSpec, tabTransition(true).transitionSpec);
        assert.equal(reduced.tabBarActiveTintColor, '#326FE5');
      });
    }
  }
});


it('beginner has five tabs with Quest third and MY last', () => {
  assert.deepEqual(tabContract(renderTabs('beginner')), [
    ['HomeTab', 'HomeStack', '홈', 'home'], ['MarketTab', 'MarketStack', '마켓', 'market'],
    ['QuestTab', 'QuestStack', '퀘스트', 'quest'], ['WalletTab', 'WalletStack', '지갑', 'wallet'],
    ['MyTab', 'MyStack', 'MY', 'menu'],
  ]);
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
      const names = elements(renderTabs(mode), 'Screen').map((screen: any) => screen.props.name);
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
    // Members' 가이드 keeps its equal share at every text size.
    assert.equal(items(renderTabs('general')).GuideTab, undefined);
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
