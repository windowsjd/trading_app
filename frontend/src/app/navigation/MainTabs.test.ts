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
const guideScreen = readFileSync(
  new URL('../../screens/guide/GuideScreen.tsx', import.meta.url),
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
      ['MyTab', 'MyStack', 'MY', 'profile'],
    ]);
  });

  it('keeps Ranking as the third of five tabs for a season account', () => {
    assert.deepEqual(tabContract(renderTabs('season')), [
      ['HomeTab', 'HomeStack', '홈', 'home'],
      ['MarketTab', 'MarketStack', '마켓', 'market'],
      ['RankingTab', 'RankingStack', '랭킹', 'ranking'],
      ['RecordTab', 'RecordStack', '전적', 'record'],
      ['MyTab', 'MyStack', 'MY', 'profile'],
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

  it('keeps Guide minimal and leaves the existing Ranking stack intact', () => {
    assert.equal([...guideStack.matchAll(/<Stack\.Screen\b/g)].length, 1);
    assert.match(guideStack, /name="Guide"/);
    assert.match(guideStack, /component=\{GuideScreen\}/);
    assert.equal([...rankingStack.matchAll(/<Stack\.Screen\b/g)].length, 2);
    assert.match(rankingStack, /name="Ranking"/);
    assert.match(rankingStack, /name="UserSeasonSummary"/);
    assert.match(guideScreen, />\s*가이드\s*</);
    assert.match(
      guideScreen,
      /투자 기초와 차트 활용 가이드를 준비하고 있습니다\./,
    );
    assert.match(
      guideScreen,
      /<ScrollView contentContainerStyle=\{styles\.content\}>/,
    );
  });
});

describe('bottom tab icon contract', () => {
  it('draws every icon with consistent SVG strokes, without text or font assets', () => {
    assert.match(icons, /import Svg, \{ Circle, Path \} from 'react-native-svg'/);
    assert.deepEqual(
      [...icons.matchAll(/case '(\w+)':/g)].map((match) => match[1]),
      ['home', 'market', 'guide', 'ranking', 'record', 'profile'],
    );
    assert.match(icons, /width=\{size\}\s+height=\{size\}/);
    assert.match(icons, /viewBox="0 0 24 24"/);
    assert.match(
      icons,
      /fill="none"\s+stroke=\{color\}\s+strokeWidth=\{2\}/,
    );
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
      /fontScale > 1\s*\? \{ height: 49 \+ Math\.ceil\(14 \* \(fontScale - 1\)\) \+ insets\.bottom \}\s*: undefined/,
    );
    assert.doesNotMatch(
      tabs,
      /tabBarAllowFontScaling:\s*false|tabBarActiveTintColor|tabBarInactiveTintColor/,
    );
  });
});
