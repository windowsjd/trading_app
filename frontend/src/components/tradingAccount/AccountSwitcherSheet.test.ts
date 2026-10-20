import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it, type TestContext } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { accountSheetMaxHeight } from './accountSheetLayout.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

const season = {
  id: 'season-1', mode: 'season', status: 'active', openedAt: '2026-09-01T00:00:00Z', closedAt: null,
  season: { seasonId: 's1', seasonName: 'Season 1', seasonStatus: 'active', participantStatus: 'active' },
};

/** The real switcher with its sheet open; account hooks and the sheet frame are stand-ins. */
function setup(t: TestContext, accounts: Array<Record<string, unknown>> = [season]) {
  const ui = interactionHarness('android');
  ui.dimensions = { width: 360, height: 844, fontScale: 1.5 };
  const h: any = { starts: 0, beginnerStarts: 0, general: { isPending: false, error: null }, beginner: { isPending: false, error: null } };
  const Switcher = ui.load('src/components/tradingAccount/AccountSwitcher.tsx', {
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) },
    '@tanstack/react-query': { useQuery: () => ({ isSuccess: false }) },
    '../../features/season/api': { getCurrentSeason: () => {} },
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({
      accounts, selectedAccount: accounts[0], selectedAccountId: accounts[0].id, selectAccount() {},
      isLoading: false, isError: false, isEmpty: false, refetchAccounts() {},
    }) },
    '../../features/tradingAccount/useOpenGeneralAccount': {
      useOpenGeneralAccount: () => ({ ...h.general, start: () => { h.starts++; } }),
      useOpenBeginnerAccount: () => ({ ...h.beginner, start: () => { h.beginnerStarts++; } }),
    },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
    '../common/ActionPressable': { default: ui.ActionPressable, __esModule: true },
    '../common/CTAButton': { default: 'CTAButton', __esModule: true },
    '../states/ErrorNotice': { default: 'ErrorNotice', __esModule: true },
    '../common/BottomSheetBackdrop': {
      default: ({ visible, children }: { visible: boolean; children: unknown }) => (visible ? children : null),
      __esModule: true,
    },
  }).default;
  h.renderer = ui.render(React.createElement(Switcher));
  t.after(() => act(() => h.renderer.unmount()));
  h.rerender = () => act(() => h.renderer.update(React.createElement(Switcher)));
  act(() => h.renderer.root.findByProps({ testID: TEST_IDS.tradingAccount.switcherTrigger }).props.onPress());
  h.cta = (testID: string) => h.renderer.root.findAll((node: any) => node.type === 'CTAButton' && node.props.testID === testID);
  h.texts = () => h.renderer.root.findAllByType('Text').map((node: any) => [node.props.children].flat().join(''));
  return h;
}

it('offers 일반모드 as the same card as 초보모드: title, sentence, one full-width CTA', (t) => {
  const h = setup(t);
  const texts: string[] = h.texts();
  const general = h.cta(TEST_IDS.tradingAccount.switcherStartGeneral);
  assert.equal(general.length, 1);
  assert.equal(general[0].props.label, '일반모드 계정만들기');
  assert.equal(general[0].props.state, 'enabled');
  assert.equal(h.cta('beginner-account-start')[0].props.label, '초보모드 계정만들기');
  // Title, then its sentence, in both offers.
  const at = (value: string) => texts.indexOf(value);
  assert.equal(at('시즌 기간 제한 없이 자유롭게 가상 투자를 연습합니다.'), at('일반모드') + 1);
  assert.equal(at('퀘스트를 따라 투자의 기초부터 다양한 거래 방법까지 단계별로 연습합니다.'), at('초보모드') + 1);
  // Both cards share one style (a full-width CTA inside a bordered card).
  const cards = ['general-account-entry', 'beginner-account-entry']
    .map((id) => flatten(h.renderer.root.findAll((node: any) => node.type === 'View' && node.props.testID === id)[0].props.style));
  assert.deepEqual(cards[0], cards[1]);
  assert.equal(cards[0].borderRadius, 16);
  assert.doesNotMatch(texts.join(' '), /일반 투자 시작하기|매매 가능|KRW↔USD 환전 가능|초보 계정 만들기/);
  assert.equal(texts.includes('시작'), false, 'no trailing 시작 action');
  // Rendering creates nothing; the press does.
  assert.equal(h.starts, 0);
  general[0].props.onPress();
  assert.equal(h.starts, 1);
  assert.equal(h.beginnerStarts, 0);
});

it('keeps loading and the original error on the 일반모드 card', (t) => {
  const h = setup(t);
  h.general = { isPending: true, error: null };
  h.rerender();
  assert.equal(h.cta(TEST_IDS.tradingAccount.switcherStartGeneral)[0].props.state, 'loading');
  const failure = Object.assign(new Error('conflict'), { response: { status: 409 } });
  h.general = { isPending: false, error: failure };
  h.rerender();
  const notices = h.renderer.root.findAll((node: any) => node.type === 'ErrorNotice'
    && node.props.testID === TEST_IDS.tradingAccount.switcherStartGeneralError);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].props.error === failure, true);
  assert.equal(h.cta(TEST_IDS.tradingAccount.switcherStartGeneral)[0].props.state, 'enabled', 'retry stays available');
});

it('offers nothing to create when both standalone accounts exist', (t) => {
  const general = { ...season, id: 'general-1', mode: 'general', season: null };
  const beginner = { ...season, id: 'beginner-1', mode: 'beginner', season: null };
  const h = setup(t, [season, general, beginner]);
  assert.equal(h.cta(TEST_IDS.tradingAccount.switcherStartGeneral).length, 0);
  assert.equal(h.cta('beginner-account-start').length, 0);
  // Every owned account stays selectable, in the existing order.
  const rows = h.renderer.root.findAll((node: any) => node.type === 'Pressable'
    && String(node.props.testID).startsWith('trading-account-switcher-option-')).map((node: any) => node.props.testID);
  assert.deepEqual(rows, ['season-1', 'general-1', 'beginner-1'].map(TEST_IDS.tradingAccount.switcherOption));
});

it('grows the sheet to the window minus the system bars, scrolling inside', (t) => {
  const h = setup(t);
  const sheet = h.renderer.root.findAll((node: any) => node.type === 'ScrollView'
    && node.props.testID === TEST_IDS.tradingAccount.switcherSheet)[0];
  const maxHeight = flatten(sheet.props.style).maxHeight;
  assert.equal(maxHeight, accountSheetMaxHeight(844, { top: 47, bottom: 34 }));
  assert.ok(maxHeight > Math.min(480, 844 * 0.7), `${maxHeight}`);
});
