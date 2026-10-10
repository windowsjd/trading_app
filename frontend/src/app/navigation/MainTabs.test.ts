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

function renderTabs(mode: AccountMode | null, isLoading = false, appearance: 'light' | 'dark' = 'light', reduced = false, accountId = `${mode}-account`) {
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
    ...Object.fromEntries(
      ['Home', 'Market', 'Guide', 'Ranking', 'Wallet', 'My'].map((name) => [
        `./${name}Stack`,
        { default: `${name}Stack`, QuestStack: 'QuestStack', __esModule: true },
      ]),
    ),
  }).default;

  return MainTabs();
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
    it(`${mode}: hides the tab bar only for AssetDetail and restores it on Market routes`, () => {
      const tree = renderTabs(mode);
      const screens = elements(tree, 'Screen');
      const market = screens.find((screen: any) => screen.props.name === 'MarketTab');
      const defaultStyle = tree.props.screenOptions.tabBarStyle;

      // Nested screen params are available before the child navigator mounts.
      for (const name of [undefined, 'Market', 'MarketSearch', 'AssetDetail', 'MarketSearch', 'Market']) {
        const route = { name: 'MarketTab', params: name ? { screen: name } : undefined };
        const options = screenOptions(market, route);
        assert.equal(options.title, '마켓');
        if (name === 'AssetDetail') {
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
    assert.equal([...guideStack.matchAll(/<Stack\.Screen\b/g)].length, 11);
    assert.match(guideStack, /name="Guide"/);
    assert.match(guideStack, /component=\{beginner \? BeginnerLearningScreen : GuideScreen\}/);
    // The quest detail exists only in the beginner QuestStack, never in GuideTab.
    assert.match(guideStack, /\{beginner \? \(\s*<Stack\.Screen name="QuestDetail" component=\{BeginnerQuestDetailScreen\}[^>]*\/>\s*\) : null\}/);
    assert.match(guideStack, /name="MarketBasics"/);
    assert.match(guideStack, /component=\{MarketBasicsScreen\}/);
    assert.match(guideStack, /component=\{MarketBasicsChaptersScreen\}/);
    for (const route of ['OrderBookLesson', 'Liquidity', 'Candles', 'OrderTypes', 'StockCharacteristics', 'CorporateActions', 'EtfIndex', 'GuideChapter']) {
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
      ['market', 'guide', 'ranking', 'wallet', 'record', 'menu', 'profile'],
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
    for (const name of ['home', 'market', 'guide', 'ranking', 'wallet', 'record', 'menu']) {
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
    ['QuestTab', 'QuestStack', '퀘스트', 'guide'], ['WalletTab', 'WalletStack', '지갑', 'wallet'],
    ['MyTab', 'MyStack', 'MY', 'menu'],
  ]);
});
it('even switching two season accounts resets nested navigation by account id', () => {
  assert.notEqual(renderTabs('season', false, 'light', false, 'season-one').key, renderTabs('season', false, 'light', false, 'season-two').key);
});
