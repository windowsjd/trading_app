import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { homeAccountChangeWidth, homeHeaderLayout, homeTitleMinWidth, questBadgeCount } from './homeHeaderLayout.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

// Home's header (2026-11-07): the mode title control at the left opens the
// existing account sheet; account and season notices stay in the body.
function setup({ width = 390, fontScale = 1, seasonName = 'Season 1' } = {}) {
  const h = interactionHarness('android');
  h.dimensions = { width, height: 844, fontScale };
  const general = { id: 'general-1', mode: 'general', status: 'active', season: null };
  const season = {
    id: 'season-1', mode: 'season', status: 'active',
    season: { seasonId: 's1', seasonName, seasonStatus: 'active', participantStatus: 'active' },
  };
  const selected: string[] = [];
  const context = {
    accounts: [general, season], selectedAccount: season, selectedAccountId: season.id,
    selectAccount: (id: string) => selected.push(id),
  };
  const module = h.load('src/components/tradingAccount/AccountSwitcher.tsx', {
    '@tanstack/react-query': { useQuery: () => ({ isSuccess: false }) },
    '../../features/season/api': { getCurrentSeason: () => {} },
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => context },
    '../../features/tradingAccount/useOpenGeneralAccount': { useOpenGeneralAccount: () => ({}), useOpenBeginnerAccount: () => ({}) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
    '../common/ActionPressable': { default: h.ActionPressable, __esModule: true },
    '../common/CTAButton': { default: 'CTAButton', __esModule: true },
    './AdminDiagnosticPanel': { default: () => null, __esModule: true },
    '../common/BottomSheetBackdrop': {
      default: ({ visible, children }: { visible: boolean; children: unknown }) => visible ? children : null,
      __esModule: true,
    },
  });
  const Switcher = module.default;
  const Notices = module.HomeAccountNotices;
  const layout = homeHeaderLayout(width, fontScale, 'general');
  const maxWidth = layout.titleMaxWidth;
  const render = () => React.createElement(React.Fragment, null,
    React.createElement(Switcher, { homeHeader: true, maxWidth, titleFontCap: layout.titleFontCap, changeFontCap: layout.changeFontCap }),
    React.createElement(Notices));
  const renderer = h.render(render());
  // Every text but the 계정변경 chip's own label (asserted on its own below).
  const text = () => renderer.root.findAllByType('Text').map((node: any) => node.props.children).flat()
    .filter((child: unknown) => child !== '계정변경').join(' ');
  return { renderer, context, general, selected, render, text, maxWidth, layout };
}

const LONG_SEASON = '2026 하반기 정규 시즌 프리미엄 리그 결승 라운드 (확장 이벤트)';
for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 1.5, 2]) for (const mode of ['general', 'season']) {
  it(`${mode} Home header title at ${width}px × ${fontScale}: one 44dp control, one line inside its width, 계정변경 text chip`, t => {
    const h = setup({ width, fontScale, seasonName: LONG_SEASON });
    t.after(() => act(() => h.renderer.unmount()));
    if (mode === 'general') {
      h.context.selectedAccount = h.general;
      h.context.selectedAccountId = h.general.id;
      act(() => h.renderer.update(h.render()));
    }
    const buttons = h.renderer.root.findAllByType('Pressable');
    assert.equal(buttons.length, 1, 'the title and the chip are one target');
    const control = flatten(buttons[0].props.style);
    assert.equal(control.minHeight >= 44, true);
    assert.equal(control.flexDirection, 'row');
    assert.equal(control.maxWidth, h.maxWidth, 'the title never runs under the header buttons');
    assert.equal(buttons[0].props.testID, TEST_IDS.tradingAccount.switcherTrigger);
    const titles = h.renderer.root.findAllByType('Text').filter((node: any) => node.props.testID === 'home-account-title');
    assert.equal(titles.length, 1);
    assert.equal(titles[0].props.numberOfLines, 1, 'the header has one line');
    assert.equal(titles[0].props.maxFontSizeMultiplier, h.layout.titleFontCap);
    const titleStyle = flatten(titles[0].props.style);
    assert.equal([titleStyle.fontSize, titleStyle.fontWeight].join('/'), '20/700');
    assert.equal(titles[0].props.children, mode === 'general' ? '일반모드' : LONG_SEASON);
    // The full name is announced even when the line is cut.
    assert.match(buttons[0].props.accessibilityLabel, mode === 'general' ? /현재 일반모드/ : /현재 2026 하반기/);
    // 계정변경 (2026-11-07 (3)) replaces the ⇄ icon: a 28dp text chip inside the same target, never shrinking.
    const chip = h.renderer.root.findAll((node: any) => node.type === 'View' && node.props.testID === 'home-account-change')[0];
    const chipStyle = flatten(chip.props.style);
    assert.equal([chipStyle.minHeight, chipStyle.borderRadius, chipStyle.paddingHorizontal, chipStyle.flexShrink].join('/'), '28/8/8/0');
    const label = chip.findAllByType('Text')[0];
    assert.equal(label.props.children, '계정변경');
    assert.equal(label.props.numberOfLines === undefined, true, 'never cut to one ellipsised line');
    assert.equal(label.props.maxFontSizeMultiplier, h.layout.changeFontCap);
    const labelStyle = flatten(label.props.style);
    assert.equal([labelStyle.fontSize, labelStyle.fontWeight].join('/'), '13/600');
    assert.equal(h.renderer.root.findAll((node: any) => node.type === 'Svg').length, 0, 'the ⇄ icon is gone');
  });
}

it('the four-character mode title and 계정변경 always fit whole beside the header buttons (320–430dp, 1–2x)', () => {
  for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 1.15, 1.3, 1.5, 1.6, 2]) {
    for (const mode of ['beginner', 'general'] as const) {
      const layout = homeHeaderLayout(width, fontScale, mode);
      const title = homeTitleMinWidth(Math.min(fontScale, layout.titleFontCap));
      const chip = homeAccountChangeWidth(Math.min(fontScale, layout.changeFontCap));
      assert.equal(title + chip <= layout.titleMaxWidth, true, `${mode} ${width}/${fontScale}: ${title}+${chip} > ${layout.titleMaxWidth}`);
      assert.equal(layout.titleFontCap >= 1 && layout.titleFontCap <= 1.6, true);
    }
  }
  // Room to spare keeps the usual caps; only a narrow screen with large text gives way.
  assert.deepEqual([homeHeaderLayout(390, 1.6, 'general').titleFontCap, homeHeaderLayout(390, 1.6, 'general').changeFontCap], [1.6, 1.3]);
  const narrow = homeHeaderLayout(320, 1.6, 'general');
  assert.equal(narrow.changeFontCap, 1);
  assert.equal(narrow.titleFontCap < 1.6, true);
});

it('the header title opens the existing account selection sheet and follows the selection', () => {
  const h = setup();
  try {
    assert.equal(h.text(), 'Season 1');
    const button = h.renderer.root.findByType('Pressable');
    assert.match(button.props.accessibilityLabel, /Season 1/);
    act(() => button.props.onPress());
    assert.ok(h.text().includes('시즌 수익률 (초기자본 대비)'), 'the sheet keeps the initial-capital explanation');
    assert.ok(h.text().includes('누적 투자원금 대비 수익률'));
    const option = h.renderer.root.findAllByType('Pressable').find(
      (node: any) => node.props.testID === TEST_IDS.tradingAccount.switcherOption('general-1'),
    );
    assert.ok(option);
    act(() => option.props.onPress());
    assert.deepEqual(h.selected, ['general-1']);
    assert.equal(h.text(), 'Season 1');
    h.context.selectedAccount = h.general;
    h.context.selectedAccountId = h.general.id;
    act(() => h.renderer.update(h.render()));
    assert.equal(h.text(), '일반모드');
  } finally { act(() => h.renderer.unmount()); }
});

for (const change of [
  { status: 'suspended', expected: '일시정지' },
  { status: 'closed', expected: '종료' },
  { seasonStatus: 'upcoming', expected: '시작 전' },
  { seasonStatus: 'ended', expected: '종료됨' },
  { seasonStatus: 'settled', expected: '정산 완료' },
  { participantStatus: 'registered', expected: '참가 등록' },
  { participantStatus: 'excluded', expected: '참가 제외' },
  { participantStatus: 'finished', expected: '참가 종료' },
  { participantStatus: 'rewarded', expected: '보상 지급 완료' },
]) it(`Home preserves the important account/season context under the profile: ${change.expected}`, () => {
  const h = setup();
  try {
    assert.equal(h.renderer.root.findAll((node: any) => node.type === 'View' && node.props.testID === 'home-account-notices').length, 0, 'nothing for an active season');
    const account = h.context.selectedAccount;
    if (change.status) account.status = change.status;
    if (change.seasonStatus) account.season.seasonStatus = change.seasonStatus;
    if (change.participantStatus) account.season.participantStatus = change.participantStatus;
    act(() => h.renderer.update(h.render()));
    assert.ok(h.text().includes(change.expected));
    assert.equal(h.renderer.root.findAll((node: any) => node.type === 'View' && node.props.testID === 'home-account-notices').length, 1);
    assert.equal(h.renderer.root.findAllByType('Pressable').length, 1);
  } finally { act(() => h.renderer.unmount()); }
});

// The header's buttons: 퀘스트 (beginner, count badge), 가이드 + 보상 (general), none (season).
function actions(mode: 'beginner' | 'general' | 'season', { width = 390, fontScale = 1, completed = 7 as number | null } = {}) {
  const h = interactionHarness('android');
  h.dimensions = { width, height: 844, fontScale };
  const navigations: unknown[] = [];
  const progress = completed === null ? null : Object.fromEntries([
    'exchange', 'transfer', 'marketBuy', 'protection', 'marketSell', 'limitBuy', 'krStock', 'usStock', 'futuresLong', 'futuresShort',
  ].map((key, index) => [key, { completed: index < completed }]));
  const module = h.load('src/screens/home/HomeHeader.tsx', {
    '../../theme/appearance': { useAppearance: () => ({ colors: { secondaryActionForeground: '#285B85' } }) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate: (...args: unknown[]) => navigations.push(args) }) },
    '../../features/quest/useBeginnerQuestProgress': { useBeginnerQuestProgress: () => ({ progress }) },
    '../../components/tradingAccount/AccountSwitcher': { __esModule: true, default: 'AccountSwitcher' },
    '../../components/navigation/TabBarIcon': { __esModule: true, default: 'TabBarIcon' },
    '../../components/common/ActionPressable': { default: h.ActionPressable, __esModule: true },
    './GeneralRewardSheet': { __esModule: true, HomeRewardButton: ({ onPress, iconOnly }: any) => React.createElement('RewardButton', { onPress, iconOnly }) },
  });
  const rewards: string[] = [];
  const renderer = h.render(React.createElement(module.HomeHeaderActions, { mode, onReward: () => rewards.push('reward') }));
  const pressable = (id: string) => renderer.root.findAll((node: any) => node.type === 'Pressable' && node.props.testID === id)[0];
  const labels = () => renderer.root.findAllByType('Text').map((node: any) => node.props.children).flat().join(' ');
  return { renderer, navigations, rewards, pressable, labels, close: () => act(() => renderer.unmount()) };
}

it('beginner: 퀘스트 opens the quest list as the guide does, with the count of quests left', t => {
  const h = actions('beginner', { completed: 7 }); t.after(h.close);
  const quest = h.pressable('home-quest-button');
  assert.ok(quest);
  const style = flatten(quest.props.style);
  assert.equal([style.minHeight, style.borderRadius, style.paddingHorizontal, style.gap].join('/'), '36/12/12/6');
  assert.equal(quest.props.hitSlop.top + quest.props.hitSlop.bottom + style.minHeight, 44, 'a 44dp target');
  const badge = h.renderer.root.findAll((node: any) => node.type === 'View' && node.props.testID === 'home-quest-button-badge')[0];
  assert.ok(badge);
  const badgeStyle = flatten(badge.props.style);
  assert.equal([badgeStyle.top, badgeStyle.right, badgeStyle.height, badgeStyle.borderWidth].join('/'), '-8/-8/18/2');
  assert.match(h.labels(), /퀘스트/);
  assert.match(h.labels(), /\b3\b/);
  assert.match(quest.props.accessibilityLabel, /남은 퀘스트 3개/);
  act(() => quest.props.onPress());
  assert.equal(JSON.stringify(h.navigations), JSON.stringify([['MainTabs', { screen: 'QuestTab', params: { screen: 'Guide', pop: true } }]]));
  assert.equal(h.pressable('home-guide-button') === undefined, true);
});

for (const completed of [10, null] as const) {
  it(`beginner: no badge when ${completed === null ? 'progress is unknown' : 'every quest is done'}`, t => {
    const h = actions('beginner', { completed }); t.after(h.close);
    assert.equal(h.renderer.root.findAll((node: any) => node.props.testID === 'home-quest-button-badge').length, 0);
  });
}

it('general: 가이드 opens the hidden guide tab, 보상 keeps its sheet; season has no buttons', t => {
  const h = actions('general'); t.after(h.close);
  const guide = h.pressable('home-guide-button');
  act(() => guide.props.onPress());
  assert.equal(JSON.stringify(h.navigations), JSON.stringify([['MainTabs', { screen: 'GuideTab', params: { screen: 'Guide', pop: true } }]]));
  const reward = h.renderer.root.findByType('RewardButton');
  act(() => reward.props.onPress());
  assert.deepEqual(h.rewards, ['reward']);
  assert.equal(h.pressable('home-quest-button') === undefined, true);
  const season = actions('season'); t.after(season.close);
  assert.equal(season.renderer.toJSON() === null, true);
});

it('narrow screens and large text keep only the icons (labels stay for screen readers)', t => {
  const wide = actions('general', { width: 390, fontScale: 1 }); t.after(wide.close);
  assert.match(wide.labels(), /가이드/);
  const narrow = actions('general', { width: 360, fontScale: 1.5 }); t.after(narrow.close);
  assert.equal(/가이드/.test(narrow.labels()), false);
  assert.equal(narrow.renderer.root.findByType('RewardButton').props.iconOnly, true);
  assert.equal(narrow.pressable('home-guide-button').props.accessibilityLabel, '가이드');
});

it('the header layout fits 320–430dp up to 1.6x text for every mode', () => {
  for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 1.3, 1.6, 2]) {
    for (const mode of ['beginner', 'general', 'season'] as const) {
      const layout = homeHeaderLayout(width, fontScale, mode);
      assert.equal(layout.titleMaxWidth >= 120, true, `${mode} ${width}/${fontScale}`);
      assert.equal(layout.titleMaxWidth <= width - 32, true);
      if (mode === 'season') assert.equal(layout.iconOnly, false);
    }
  }
  // The 계정변경 chip is wider than the old ⇄ icon (2026-11-07 (3)): general's
  // 가이드·보상 keep their labels from 390dp at 1x, beginner's 퀘스트 even at 320dp.
  assert.equal(homeHeaderLayout(390, 1, 'general').iconOnly, false);
  assert.equal(homeHeaderLayout(360, 1, 'general').iconOnly, true);
  assert.equal(homeHeaderLayout(360, 1, 'beginner').iconOnly, false);
  assert.equal(homeHeaderLayout(320, 1, 'beginner').iconOnly, false);
  assert.equal(homeHeaderLayout(360, 1.3, 'general').iconOnly, true);
  assert.equal(homeHeaderLayout(320, 1, 'general').iconOnly, true);
  assert.deepEqual([questBadgeCount(10, 3), questBadgeCount(10, 10), questBadgeCount(10, null), questBadgeCount(10, 12)], [7, null, null, null]);
});
