import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

function setup() {
  const h = interactionHarness('android');
  const general = { id: 'general-1', mode: 'general', status: 'active', season: null };
  const season = {
    id: 'season-1', mode: 'season', status: 'active',
    season: { seasonId: 's1', seasonName: 'Season 1', seasonStatus: 'active', participantStatus: 'active' },
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
    '../../features/tradingAccount/useOpenGeneralAccount': { useOpenGeneralAccount: () => ({}) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
    '../common/ActionPressable': { default: h.ActionPressable, __esModule: true },
    '../common/CTAButton': { default: 'CTAButton', __esModule: true },
    '../common/BottomSheetBackdrop': {
      default: ({ visible, children }: { visible: boolean; children: unknown }) => visible ? children : null,
      __esModule: true,
    },
  }).default;
  const render = () => React.createElement(Switcher, { home: true });
  const renderer = h.render(render());
  const text = () => renderer.root.findAllByType('Text').map((node) => node.props.children).flat().join(' ');
  return { renderer, context, general, selected, render, text };
}

it('Home context is spacious, quiet and opens the existing account selection sheet', () => {
  const h = setup();
  try {
    assert.equal(h.text(), 'Season 1 변경');
    const context = h.renderer.root.findByProps({ testID: TEST_IDS.home.accountContext });
    const style = flatten(context.props.style);
    assert.ok(style.minHeight >= 64 && style.minHeight <= 80);
    assert.ok(style.paddingHorizontal >= 16 && style.paddingVertical >= 12);
    const button = h.renderer.root.findByType('Pressable');
    assert.ok(flatten(button.props.style).minHeight >= 44);
    assert.match(button.props.accessibilityLabel, /Season 1/);
    act(() => button.props.onPress());
    assert.ok(h.text().includes('시즌 수익률 (초기자본 대비)'), 'the sheet keeps the initial-capital explanation');
    assert.ok(h.text().includes('시간가중 수익률'));
    const option = h.renderer.root.findAllByType('Pressable').find(
      (node) => node.props.testID === TEST_IDS.tradingAccount.switcherOption('general-1'),
    );
    assert.ok(option);
    act(() => option.props.onPress());
    assert.deepEqual(h.selected, ['general-1']);
    assert.equal(h.text(), 'Season 1 변경');
    h.context.selectedAccount = h.general;
    h.context.selectedAccountId = h.general.id;
    act(() => h.renderer.update(h.render()));
    assert.equal(h.text(), '일반 투자 변경');
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
