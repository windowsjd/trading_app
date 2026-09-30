import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { URL } from 'node:url';

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

type AccountMode = 'general' | 'season';

function renderTabs(mode: AccountMode | null, isLoading = false) {
  const MainTabs = load(resolve('src/app/navigation/MainTabs.tsx'), {
    'react-native': { useWindowDimensions: () => ({ fontScale: 1 }) },
    'react-native-safe-area-context': {
      useSafeAreaInsets: () => ({ bottom: 0 }),
    },
    '@react-navigation/bottom-tabs': {
      createBottomTabNavigator: () => ({
        Navigator: 'Navigator',
        Screen: 'Screen',
      }),
    },
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
        selectedAccount: mode ? { id: `${mode}-account`, mode } : null,
        isLoading,
      }),
    },
    ...Object.fromEntries(
      ['Home', 'Market', 'Guide', 'Ranking', 'Record', 'My'].map((name) => [
        `./${name}Stack`,
        { default: `${name}Stack`, __esModule: true },
      ]),
    ),
  }).default;

  return MainTabs();
}

function tabContract(tree: unknown) {
  return elements(tree, 'Screen').map((screen: any) => {
    const icon = screen.props.options.tabBarIcon({
      color: '#123456',
      size: 25,
    });

    return [
      screen.props.name,
      screen.props.component,
      screen.props.options.title,
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
      ['RecordTab', 'RecordStack', '전적', 'record'],
      ['MyTab', 'MyStack', '전체', 'menu'],
    ]);
  });

  it('keeps Ranking as the third of five tabs for a season account', () => {
    assert.deepEqual(tabContract(renderTabs('season')), [
      ['HomeTab', 'HomeStack', '홈', 'home'],
      ['MarketTab', 'MarketStack', '마켓', 'market'],
      ['RankingTab', 'RankingStack', '랭킹', 'ranking'],
      ['RecordTab', 'RecordStack', '전적', 'record'],
      ['MyTab', 'MyStack', '전체', 'menu'],
    ]);
  });

  it('remounts at Home when account mode changes, dropping the removed tab state', () => {
    const general = renderTabs('general');
    const season = renderTabs('season');

    assert.equal(general.key, 'general');
    assert.equal(season.key, 'season');
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
    assert.equal([...guideStack.matchAll(/<Stack\.Screen\b/g)].length, 10);
    assert.match(guideStack, /name="Guide"/);
    assert.match(guideStack, /component=\{GuideScreen\}/);
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
      ['home', 'market', 'guide', 'ranking', 'record', 'menu', 'profile'],
    );
    assert.match(icons, /width=\{size\}\s+height=\{size\}/);
    assert.match(icons, /viewBox="0 0 24 24"/);
    assert.match(icons, /fill=\{focused \? color : 'none'\}/);
    assert.match(icons, /stroke=\{focused \? 'none' : color\}/);
    assert.match(icons, /case 'home': drawing = <Path/);
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
    assert.match(tabs, /tabBarActiveTintColor: '#ffffff'/);
    assert.match(tabs, /tabBarInactiveTintColor: '#aebbc8'/);
    assert.match(tabs, /backgroundColor: '#19232e'/);
  });
});

describe('bottom tab visual states', () => {
  it('renders white solid selected icons and grey outline inactive icons', () => {
    const Icon = load(resolve('src/components/navigation/TabBarIcon.tsx'), {
      'react-native': { View: 'View' },
      'react-native-svg': { default: 'Svg', Circle: 'Circle', Path: 'Path', __esModule: true },
    }).default;
    for (const name of ['home', 'market', 'guide', 'ranking', 'record', 'menu']) {
      const active = elements(Icon({ name, color: '#ffffff', size: 25, focused: true }), 'Svg')[0];
      const inactive = elements(Icon({ name, color: '#aebbc8', size: 25, focused: false }), 'Svg')[0];
      assert.equal(active.props.fill, '#ffffff'); assert.equal(active.props.stroke, 'none');
      assert.equal(inactive.props.fill, 'none'); assert.equal(inactive.props.stroke, '#aebbc8');
      assert.equal(active.props.width, 25); assert.equal(inactive.props.width, 25);
    }
    const tree = renderTabs('general');
    assert.equal(tree.props.screenOptions.tabBarActiveTintColor, '#ffffff');
    assert.equal(tree.props.screenOptions.tabBarInactiveTintColor, '#aebbc8');
    assert.equal(tree.props.screenOptions.tabBarStyle.backgroundColor, '#19232e');
  });
});
