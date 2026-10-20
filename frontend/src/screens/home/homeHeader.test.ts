import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

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
  const Switcher = h.load('src/components/tradingAccount/AccountSwitcher.tsx', {
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
  }).default;
  const render = () => React.createElement(Switcher, { home: true });
  const renderer = h.render(render());
  const text = () => renderer.root.findAllByType('Text').map((node) => node.props.children).flat().join(' ');
  return { renderer, context, general, selected, render, text, dimensions: h.dimensions };
}

const LONG_SEASON = '2026 하반기 정규 시즌 프리미엄 리그 결승 라운드 (확장 이벤트)';
for (const width of [320, 360, 390, 430]) for (const fontScale of [1, 1.5, 2]) for (const mode of ['general', 'season']) {
  it(`${mode} Home box at ${width}px × ${fontScale}: one compact column, wrapping title, 44dp change target`, t => {
    const h = setup({ width, fontScale, seasonName: LONG_SEASON });
    t.after(() => act(() => h.renderer.unmount()));
    if (mode === 'general') {
      h.context.selectedAccount = h.general;
      h.context.selectedAccountId = h.general.id;
      act(() => h.renderer.update(h.render()));
    }
    const card = flatten(h.renderer.root.findByProps({ testID: TEST_IDS.home.accountContext }).props.style);
    // Sized by its content: no artwork minimum, fixed height or side-by-side emblem.
    assert.equal(card.minHeight, undefined);
    assert.equal(card.height, undefined);
    assert.equal(card.flexDirection ?? 'column', 'column');
    const titles = h.renderer.root.findAllByType('Text').filter(node => node.props.testID === 'home-account-title');
    assert.equal(titles.length, 1);
    const title = titles[0];
    assert.equal(title.props.numberOfLines, undefined);
    const titleStyle = flatten(title.props.style);
    assert.equal(titleStyle.flex === undefined, true, 'text keeps intrinsic width inside the wrapping title');
    const groups = h.renderer.root.findAllByType('View').filter(node => node.props.accessible === true && node.props.accessibilityLabel === (mode === 'general' ? '일반모드' : LONG_SEASON));
    assert.equal(groups.length, 1);
    assert.equal(flatten(groups[0].props.style).flex, 1, 'the title container reserves the remaining width beside change');
    assert.equal(titleStyle.minWidth, 0);
    assert.equal(title.props.children, mode === 'general' ? '일반모드' : LONG_SEASON);
    const button = h.renderer.root.findByType('Pressable');
    const visual = flatten(button.props.style);
    const slop = button.props.hitSlop;
    assert.ok(Math.min(visual.width, visual.height) + 2 * slop >= 44);
  });
}

it('Home context is compact (title near the top), quiet and opens the existing account selection sheet', () => {
  const h = setup();
  try {
    assert.equal(h.text(), 'Season 1');
    const context = h.renderer.root.findByProps({ testID: TEST_IDS.home.accountContext });
    const style = flatten(context.props.style);
    assert.ok(style.minHeight === undefined && style.height === undefined);
    assert.ok(style.paddingHorizontal >= 16 && style.paddingTop <= 12 && style.gap <= 8);
    const button = h.renderer.root.findByType('Pressable');
    assert.ok(flatten(button.props.style).width + 2 * button.props.hitSlop >= 44);
    assert.match(button.props.accessibilityLabel, /Season 1/);
    act(() => button.props.onPress());
    assert.ok(h.text().includes('시즌 수익률 (초기자본 대비)'), 'the sheet keeps the initial-capital explanation');
    assert.ok(h.text().includes('누적 투자원금 대비 수익률'));
    const option = h.renderer.root.findAllByType('Pressable').find(
      (node) => node.props.testID === TEST_IDS.tradingAccount.switcherOption('general-1'),
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
]) it(`Home preserves the important account/season context: ${change.expected}`, () => {
  const h = setup();
  try {
    const account = h.context.selectedAccount;
    if (change.status) account.status = change.status;
    if (change.seasonStatus) account.season.seasonStatus = change.seasonStatus;
    if (change.participantStatus) account.season.participantStatus = change.participantStatus;
    act(() => h.renderer.update(h.render()));
    assert.ok(h.text().includes(change.expected));
    assert.equal(h.renderer.root.findAllByType('Pressable').length, 1);
  } finally { act(() => h.renderer.unmount()); }
});
