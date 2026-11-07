import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const { elements, load } = createRequire(import.meta.url)('../../../test/ledgerTestHarness.cjs');
const native = { View: 'View', Platform: { OS: 'ios' }, StyleSheet: { create: styles => styles } };
const navigationTheme = { useTheme: () => ({ fonts: { heavy: { fontFamily: 'System', fontWeight: '700' } } }) };

for (const [stack, root, label, icon] of [
  ['Home', 'Home', '홈', 'home'], ['Market', 'Market', '마켓', 'market'],
  ['Guide', 'Guide', '가이드', 'guide'], ['Community', 'Community', '커뮤니티', 'community'],
  ['Wallet', 'Wallet', '지갑', 'wallet'], ['My', 'Overall', '전체', 'menu'],
]) {
  test(`${stack}: only the root title reuses its tab icon; detail headers and transitions stay native`, () => {
    const file = resolve(`src/app/navigation/${stack}Stack.tsx`);
    const mocks = {
      'react-native': native,
      '@react-navigation/native-stack': { createNativeStackNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen' }) },
      '@react-navigation/elements': { HeaderTitle: 'HeaderTitle' },
      '@react-navigation/native': navigationTheme,
      'react-native-svg': { default: 'Svg', Circle: 'Circle', Path: 'Path', __esModule: true },
      '../../theme/useReducedMotion': { useReducedMotion: () => true },
      './RecordStack': { default: 'RecordStack', __esModule: true },
      // Each stack screen renders inside its own error boundary (stackScreenLayout); headers are the subject here.
      '../../components/states/ScreenErrorBoundary': { default: ({ children }: { children: unknown }) => children, __esModule: true },
      ...Object.fromEntries([...readFileSync(file, 'utf8').matchAll(/import (\w+) from '(\.\.\/\.\.\/screens\/[^']+)'/g)]
        .map(match => [match[2], { default: match[1], __esModule: true }])),
    };
    const tree = load(file, mocks).default();
    // Guide lesson titles take the tab headers' heavy theme font; transitions stay native.
    const options = typeof tree.props.screenOptions === 'function'
      ? tree.props.screenOptions({ theme: navigationTheme.useTheme() }) : tree.props.screenOptions;
    assert.deepEqual(options, stack === 'Guide'
      ? { animation: 'none', headerTitleStyle: { fontFamily: 'System', fontWeight: '700' } } : { animation: 'none' });
    const screens = elements(tree, 'Screen');
    const first = screens.find(screen => screen.props.name === root);
    assert.equal(first.props.options.title, label);
    const title = first.props.options.headerTitle({ children: label, tintColor: '#f2f5f7' });
    assert.equal(title.props.icon, icon);
    assert.equal(title.props.children, label);
    assert.equal(title.props.tintColor, '#f2f5f7');
    // 종목 상세 (stocks/crypto and futures contracts), 주문 and 글쓰기
    // (2026-11-07 (3)) alone take the heavy theme font (bolder, same size).
    const bold = stack === 'Market' ? ['AssetDetail', 'FuturesDetail', 'Order'] : stack === 'Community' ? ['PostCompose'] : [];
    const route = (name: string, params: object = {}) => ({ key: name, name, params });
    for (const screen of screens) {
      const resolved = typeof screen.props.options === 'function'
        ? screen.props.options({ theme: navigationTheme.useTheme(), route: route(screen.props.name) }) : screen.props.options;
      assert.equal(resolved.header, undefined);
      assert.equal(resolved.headerLeft, undefined);
      assert.equal(resolved.headerBackVisible, undefined);
      if (screen !== first) {
        assert.equal(resolved.headerTitle, undefined, screen.props.name);
        assert.deepEqual(resolved.headerTitleStyle, bold.includes(screen.props.name)
          ? { fontFamily: 'System', fontWeight: '700' } : undefined, screen.props.name);
      }
    }
    if (stack === 'Community') {
      // A post Home's card opened goes back to Home: the arrow alone, never labeled 커뮤니티.
      const detail = screens.find(item => item.props.name === 'PostDetail');
      const back = (params: object) => {
        const options = detail.props.options({ theme: navigationTheme.useTheme(), route: route('PostDetail', params) });
        return [options.title, options.headerBackTitle, options.headerBackButtonDisplayMode];
      };
      assert.deepEqual(back({ postId: 'p' }), ['커뮤니티', undefined, undefined]);
      assert.deepEqual(back({ postId: 'p', returnTab: 'HomeTab' }), ['커뮤니티', '뒤로', 'minimal']);
      assert.equal(detail.props.getId({ params: { postId: 'p', returnTab: 'HomeTab' } }), 'p', 'one screen per post');
      assert.equal(typeof tree.props.screenListeners, 'function', 'back from a cross-tab post returns to its tab');
      const compose = screens.find(item => item.props.name === 'PostCompose');
      assert.equal(compose.props.options({ theme: navigationTheme.useTheme(), route: route('PostCompose') }).title, '글쓰기');
    }
    if (stack === 'Market') {
      for (const [name, title] of [['AssetDetail', '종목 상세'], ['FuturesDetail', '종목 상세'], ['Order', '주문']]) {
        const screen = screens.find(item => item.props.name === name);
        assert.equal(screen.props.options({ theme: navigationTheme.useTheme(), route: route(name) }).title, title);
      }
      // A detail opened from another tab goes back there: the arrow alone, never labeled 마켓.
      const detail = screens.find(item => item.props.name === 'AssetDetail');
      const back = (params: object) => {
        const options = detail.props.options({ theme: navigationTheme.useTheme(), route: route('AssetDetail', params) });
        return [options.headerBackTitle, options.headerBackButtonDisplayMode];
      };
      assert.deepEqual(back({ assetId: 'BTC' }), [undefined, undefined]);
      assert.deepEqual(back({ assetId: 'BTC', returnTab: 'HomeTab' }), ['뒤로', 'minimal']);
    }
  });
}

test('Quest: the beginner root reuses the shared tab title with its own quest icon', () => {
  const file = resolve('src/app/navigation/GuideStack.tsx');
  const mocks = {
    'react-native': native,
    '@react-navigation/native-stack': { createNativeStackNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen' }) },
    '@react-navigation/elements': { HeaderTitle: 'HeaderTitle' },
    '@react-navigation/native': navigationTheme,
    'react-native-svg': { default: 'Svg', Circle: 'Circle', Path: 'Path', __esModule: true },
    '../../theme/useReducedMotion': { useReducedMotion: () => true },
    '../../components/states/ScreenErrorBoundary': { default: ({ children }: { children: unknown }) => children, __esModule: true },
    ...Object.fromEntries([...readFileSync(file, 'utf8').matchAll(/import (\w+) from '(\.\.\/\.\.\/screens\/[^']+)'/g)]
      .map(match => [match[2], { default: match[1], __esModule: true }])),
  };
  const stack = load(file, mocks);
  const screens = elements(stack.default({ beginner: true }), 'Screen');
  const root = screens.find(screen => screen.props.name === 'Guide');
  assert.equal(root.props.component, 'BeginnerLearningScreen');
  assert.equal(root.props.options.title, '퀘스트');
  const title = root.props.options.headerTitle({ children: '퀘스트', tintColor: '#f2f5f7' });
  assert.equal(title.type, MainTabTitle(stack), 'the same component as every other tab root');
  assert.equal(title.props.icon, 'quest');
  assert.equal(title.props.children, '퀘스트');
  assert.equal(screens.some(screen => screen.props.name === 'QuestDetail'), false);
  for (const screen of screens) {
    if (screen !== root) assert.equal(screen.props.options.headerTitle, undefined, screen.props.name);
  }
  // General accounts keep the guide book on the same stack.
  const general = elements(stack.default(), 'Screen').find(screen => screen.props.name === 'Guide');
  assert.equal(general.props.options.headerTitle({ children: '가이드' }).props.icon, 'guide');
});

test('Quest and member Guide roots go back to Home; the guest Guide tab root has no back button', () => {
  const file = resolve('src/app/navigation/GuideStack.tsx');
  const stack = load(file, {
    'react-native': native,
    '@react-navigation/native-stack': { createNativeStackNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen' }) },
    '@react-navigation/elements': { HeaderTitle: 'HeaderTitle' },
    '@react-navigation/native': navigationTheme,
    'react-native-svg': { default: 'Svg', Circle: 'Circle', Path: 'Path', __esModule: true },
    '../../theme/useReducedMotion': { useReducedMotion: () => true },
    '../../components/navigation/HeaderHomeBackButton': { default: 'HeaderHomeBackButton', __esModule: true },
    '../../components/states/ScreenErrorBoundary': { default: ({ children }: { children: unknown }) => children, __esModule: true },
    ...Object.fromEntries([...readFileSync(file, 'utf8').matchAll(/import (\w+) from '(\.\.\/\.\.\/screens\/[^']+)'/g)]
      .map(match => [match[2], { default: match[1], __esModule: true }])),
  });
  assert.deepEqual([stack.QuestStack().props.beginner, stack.QuestStack().props.homeBack], [true, true]);
  assert.deepEqual([stack.MemberGuideStack().props.beginner, stack.MemberGuideStack().props.homeBack], [undefined, true]);
  for (const props of [{ beginner: true, homeBack: true }, { homeBack: true }]) {
    const screens = elements(stack.default(props), 'Screen');
    const root = screens.find(screen => screen.props.name === 'Guide');
    const back = root.props.options.headerLeft({ tintColor: '#f2f5f7' });
    assert.equal(back.type, 'HeaderHomeBackButton');
    assert.equal(back.props.tintColor, '#f2f5f7');
    // Only the first screen: lessons keep the stack's own back button.
    for (const screen of screens) if (screen !== root) assert.equal(screen.props.options.headerLeft, undefined, screen.props.name);
  }
  const guest = elements(stack.default(), 'Screen').find(screen => screen.props.name === 'Guide');
  assert.equal(guest.props.options.headerLeft, undefined);
});

test('리그: the root header shows 랭킹 | 커뮤니티 at the left from the section param; pushed screens stay native', () => {
  const file = resolve('src/app/navigation/RankingStack.tsx');
  const stack = load(file, {
    'react-native': native,
    '@react-navigation/native-stack': { createNativeStackNavigator: () => ({ Navigator: 'Navigator', Screen: 'Screen' }) },
    '../../theme/useReducedMotion': { useReducedMotion: () => true },
    '@react-navigation/native': navigationTheme,
    '@react-navigation/elements': { HeaderTitle: 'HeaderTitle' },
    '../../components/navigation/LeagueSectionTabs': { default: 'LeagueSectionTabs', __esModule: true },
    '../../components/states/ScreenErrorBoundary': { default: ({ children }: { children: unknown }) => children, __esModule: true },
    ...Object.fromEntries([...readFileSync(file, 'utf8').matchAll(/import (\w+) from '(\.\.\/\.\.\/screens\/[^']+)'/g)]
      .map(match => [match[2], { default: match[1], __esModule: true }])),
  });
  const screens = elements(stack.default(), 'Screen');
  assert.deepEqual(screens.map(screen => [screen.props.name, screen.props.component]), [
    ['Ranking', 'LeagueScreen'], ['UserSeasonSummary', 'UserSeasonSummaryScreen'],
    ['PostDetail', 'PostDetailScreen'], ['PostCompose', 'PostComposeScreen'],
  ]);
  const params: unknown[] = [];
  const navigation = { setParams: (value: unknown) => params.push(value) };
  for (const [section, expected] of [[undefined, 'ranking'], ['ranking', 'ranking'], ['community', 'community']]) {
    const options = screens[0].props.options({ route: { name: 'Ranking', params: section ? { section } : undefined }, navigation });
    assert.equal(options.title, '리그');
    assert.equal(options.headerTitle(), null, 'the tabs take the title place at the left (both platforms)');
    const tabs = options.headerLeft();
    assert.equal(tabs.type, 'LeagueSectionTabs');
    assert.equal(tabs.props.section, expected);
    tabs.props.onChange('community');
  }
  assert.deepEqual(params, [{ section: 'community' }, { section: 'community' }, { section: 'community' }]);
  const resolved = (screen: any, routeParams: object = {}) => typeof screen.props.options === 'function'
    ? screen.props.options({ theme: navigationTheme.useTheme(), route: { key: screen.props.name, name: screen.props.name, params: routeParams } })
    : screen.props.options;
  assert.deepEqual(screens.slice(1).map(screen => resolved(screen).title), ['유저 시즌 요약', '커뮤니티', '글쓰기']);
  for (const screen of screens.slice(1)) {
    assert.equal(resolved(screen).headerLeft, undefined);
    assert.equal(resolved(screen).headerTitle, undefined);
  }
  // 글쓰기 takes the heavy theme font (2026-11-07 (3)); a post from Home goes back with the arrow alone.
  assert.deepEqual(resolved(screens[3]).headerTitleStyle, { fontFamily: 'System', fontWeight: '700' });
  assert.deepEqual([resolved(screens[2], { postId: 'p', returnTab: 'HomeTab' }).headerBackButtonDisplayMode,
    resolved(screens[2], { postId: 'p' }).headerBackButtonDisplayMode], ['minimal', undefined]);
  assert.equal(screens[2].props.getId({ params: { postId: 'q' } }), 'q', 'one screen per post');
});

test('the community stack registers the same post screens and 유저 시즌 요약 title as the 리그 stack', () => {
  const community = readFileSync(resolve('src/app/navigation/CommunityStack.tsx'), 'utf8');
  const ranking = readFileSync(resolve('src/app/navigation/RankingStack.tsx'), 'utf8');
  for (const source of [community, ranking]) {
    // One PostDetail header for both (communityPostEntry.postDetailOptions: 커뮤니티, back to an entry tab).
    assert.match(source, /name="PostDetail" component=\{PostDetailScreen\} getId=\{postDetailId\}\s+options=\{\(\{ route \}\) => postDetailOptions\(route\.params\)\}/);
    assert.match(source, /name="PostCompose" component=\{PostComposeScreen\}\s+options=\{\(\{ theme \}\) => \(\{ title: '글쓰기', headerTitleStyle: theme\.fonts\.heavy \}\)\}/);
    assert.match(source, /name="UserSeasonSummary"\s+component=\{UserSeasonSummaryScreen\}\s+options=\{\{ title: '유저 시즌 요약' \}\}/);
    assert.match(source, /screenListeners=\{returnToEntryTab\}/);
  }
});

function MainTabTitle(stack) {
  return elements(stack.default(), 'Screen').find(screen => screen.props.name === 'Guide').props.options.headerTitle({ children: '가이드' }).type;
}

test('quest has its own flag in both states, distinct from the guide book and ranking trophy', () => {
  const Icon = load(resolve('src/components/navigation/TabBarIcon.tsx'), {
    'react-native': native,
    'react-native-svg': { default: 'Svg', Circle: 'Circle', Path: 'Path', __esModule: true },
  }).default;
  for (const focused of [false, true]) {
    const drawing = name => elements(Icon({ name, color: '#326FE5', size: 24, focused }), 'Path').map(path => path.props.d).join('|');
    assert.ok(drawing('quest').length > 0);
    assert.notEqual(drawing('quest'), drawing('guide'));
    assert.notEqual(drawing('quest'), drawing('ranking'));
    const svg = elements(Icon({ name: 'quest', color: '#326FE5', size: 24, focused }), 'Svg')[0];
    assert.equal(svg.props.fill, focused ? '#326FE5' : 'none');
    assert.equal(svg.props.stroke, focused ? 'none' : '#326FE5');
  }
});

test('the root title keeps Navigation heading semantics, platform size, tint, and layout measurement', () => {
  const Title = load(resolve('src/components/navigation/MainTabHeaderTitle.tsx'), {
    'react-native': native,
    '@react-navigation/elements': { HeaderTitle: 'HeaderTitle' },
    '@react-navigation/native': navigationTheme,
    './TabBarIcon': { default: 'TabBarIcon', __esModule: true },
  }).default;
  const onLayout = () => {};
  const row = Title({ icon: 'home', children: '홈', tintColor: '#f2f5f7', onLayout, allowFontScaling: true });
  assert.equal(row.props.onLayout, onLayout, 'measure the icon and text together');
  const text = elements(row, 'HeaderTitle')[0];
  assert.equal(text.props.children, '홈');
  assert.equal(text.props.tintColor, '#f2f5f7');
  assert.equal(text.props.allowFontScaling, true);
  assert.equal(text.props.maxFontSizeMultiplier, 2);
  assert.equal(text.props.onLayout, undefined, 'text measurements must not overwrite row measurements');
  const style = Object.assign({}, ...text.props.style.filter(Boolean));
  assert.equal(style.fontWeight, '700');
  assert.equal(style.fontSize, undefined);
  assert.equal(style.lineHeight, undefined);
  assert.equal(style.height, undefined);
  const svg = elements(row, 'TabBarIcon')[0];
  assert.equal(svg.props.name, 'home');
  assert.equal(svg.props.size, 20);
  assert.equal(svg.props.color, '#f2f5f7', 'the home header follows the title tint');
  assert.equal(svg.props.focused, true, 'the header uses the filled home silhouette');
  assert.equal(row.props.accessible, undefined, 'only HeaderTitle announces the heading');
});

test('header icons follow the navigation tint in both themes', () => {
  for (const mode of ['light', 'dark']) {
    const text = mode === 'light' ? '#202a35' : '#f2f5f7';
    const Title = load(resolve('src/components/navigation/MainTabHeaderTitle.tsx'), {
      'react-native': native,
      '@react-navigation/elements': { HeaderTitle: 'HeaderTitle' },
      '@react-navigation/native': navigationTheme,
      '../../theme/appearance': { useAppearance: () => ({ mode, colors: { text } }) },
      './TabBarIcon': { default: 'TabBarIcon', __esModule: true },
    }).default;
    for (const icon of ['home', 'market', 'guide', 'quest', 'ranking', 'wallet', 'menu']) {
      for (const tintColor of [undefined, '#ffffff']) {
        const tree = Title({ icon, children: '제목', tintColor });
        const svg = elements(tree, 'TabBarIcon')[0];
        assert.equal(svg.props.color, tintColor ?? text);
        assert.equal(svg.props.focused, icon === 'home');
      }
    }
  }
});

test('home shares one undecorated contour in outline and filled states at tab/header sizes', () => {
  const Icon = load(resolve('src/components/navigation/TabBarIcon.tsx'), {
    'react-native': native,
    'react-native-svg': { default: 'Svg', Circle: 'Circle', Path: 'Path', __esModule: true },
  }).default;
  for (const size of [18, 20, 24]) {
    const outline = Icon({ name: 'home', color: '#111111', size });
    const filled = Icon({ name: 'home', color: '#326FE5', size, focused: true });
    const outlinePaths = elements(outline, 'Path');
    const filledPaths = elements(filled, 'Path');
    assert.equal(outlinePaths.length, 1, 'the doorway belongs to the house perimeter');
    assert.equal(filledPaths.length, 1, 'no added outline or internal decoration');
    assert.equal(filledPaths[0].props.d, outlinePaths[0].props.d);
    assert.ok(outlinePaths[0].props.strokeWidth > 2, 'slightly heavier than the other tab outlines');
    for (const [tree, fill, stroke] of [[outline, 'none', '#111111'], [filled, '#326FE5', 'none']]) {
      const svg = elements(tree, 'Svg')[0];
      assert.equal(svg.props.width, size);
      assert.equal(svg.props.height, size);
      assert.equal(svg.props.viewBox, '0 0 24 24');
      assert.equal(svg.props.fill, fill);
      assert.equal(svg.props.stroke, stroke);
      assert.equal(elements(tree, 'Circle').length, 0);
    }
    assert.equal(outline.props['aria-hidden'], true);
    assert.equal(filled.props.importantForAccessibility, 'no-hide-descendants');
  }
});
