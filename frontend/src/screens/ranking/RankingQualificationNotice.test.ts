import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { availableRankings } from '../../features/ranking/fixtures.ts';
import { semantic } from '../../theme/tokens.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const query = require('@tanstack/react-query');

const SEASON_ID = availableRankings.season!.id;
const season = (status = 'active') => ({ ...availableRankings.season!, status, endAt: '2099-01-01T00:00:00.000Z' });
const shortOfBoth = (status = 'active') => ({
  state: 'available', season: season(status), basis: status === 'settled' ? 'final' : 'provisional', asOf: '2026-11-20T03:00:00.000Z',
  criteria: { minTradedInstrumentCount: 5, minTurnoverRatio: '3.0000', minRecognizedTurnoverKrw: '30000000.00000000' },
  tradedInstrumentCount: 3, recognizedTurnoverKrw: '12000000.00000000',
  remainingTradedInstrumentCount: 2, remainingRecognizedTurnoverKrw: '18000000.00000000',
  tradedInstrumentRequirementMet: false, turnoverRequirementMet: false, qualified: false,
});

/** The real ranking tab and notice over a real query client; transport, navigation and native hosts are the boundaries. */
async function rankingTab(t: any, options: { answer?: unknown; fail?: boolean; joined?: boolean; status?: string; myRanking?: unknown } = {}) {
  const ui = interactionHarness('android');
  ui.dimensions = { width: 320, height: 640, fontScale: 2 };
  const h: any = { reads: [] as string[], rankingCalls: [] as unknown[] };
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const status = options.status ?? 'active';
  const api = {
    getRankingTier: () => 'Silver',
    getRankings: async (params: any) => {
      h.rankingCalls.push(params);
      return { ...structuredClone(availableRankings), season: { ...availableRankings.season, status }, rankType: status === 'settled' ? 'final' : 'daily',
        ...(options.myRanking ? { myRanking: options.myRanking } : {}) };
    },
    getRankingSlice: async (params: any) => ({ state: 'unavailable', season: null, rankType: params.rankType, rankingDate: params.rankingDate,
      capturedAt: null, rankings: [], pagination: { limit: params.limit, offset: params.offset, total: 0, returned: 0, nextOffset: null },
      myRanking: { state: 'unavailable', reason: 'RANKING_UNAVAILABLE', message: '' } }),
    getRankingQualification: async (seasonId: string) => {
      h.reads.push(seasonId);
      if (options.fail) throw { response: { status: 500, data: { success: false, error: { code: 'INTERNAL_SERVER_ERROR' } } } };
      return options.answer === undefined ? shortOfBoth(status) : options.answer;
    },
  };
  const sheet = ({ visible, title, testID, children, onClose }: any) => visible ? React.createElement('Sheet', { testID, title, onClose }, children) : null;
  const notice = ui.load('src/screens/ranking/RankingQualificationNotice.tsx', {
    '@tanstack/react-query': query,
    '../../features/ranking/api': api,
    '../../components/common/ActionPressable': { default: ui.ActionPressable, __esModule: true },
    '../../components/common/InlineBottomSheet': { default: sheet, __esModule: true },
    '../../components/common/ScreenSheetHost': { SheetPortal: ({ children }: any) => children },
    '../../theme/appearance': { useAppearance: () => ({ mode: 'light', colors: { error: '#b32d2d', secondary: '#536170' } }) },
  });
  const Screen = ui.load('src/screens/ranking/RankingScreen.tsx', {
    'react-native': { ...ui.native, SafeAreaView: 'SafeAreaView',
      AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
      FlatList: ({ ListHeaderComponent, ListEmptyComponent, data, renderItem }: any) =>
        React.createElement('List', null, ListHeaderComponent,
          data.length ? data.map((item: any) => React.createElement(React.Fragment, { key: item.seasonParticipantId }, renderItem({ item }))) : ListEmptyComponent),
    },
    '@tanstack/react-query': query,
    '../../features/ranking/api': api,
    './RankingQualificationNotice': notice,
    '../../features/season/api': { getCurrentSeason: async () => ({ ...season(status), joined: options.joined ?? true }) },
    '../../features/me/api': { getMe: async () => ({ nickname: 'me' }) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
    '@react-navigation/native': { useIsFocused: () => h.focused ?? true },
  }).default;
  const element = () => React.createElement(query.QueryClientProvider, { client }, React.createElement(Screen, { navigation: { navigate() {} } }));
  h.renderer = ui.render(element());
  t.after(() => { act(() => h.renderer.unmount()); client.clear(); });
  h.flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
  h.rerender = async () => { act(() => h.renderer.update(element())); await h.flush(); };
  h.host = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id);
  h.text = (id: string) => {
    const read = (node: any): string => (typeof node === 'string' ? node : (node?.children ?? []).map(read).join(''));
    return h.host(id).map((node: any) => read(node)).join('');
  };
  h.headerOrder = () => h.renderer.root.findAll((node: any) => typeof node.type === 'string' &&
    ['ranking-my-card', 'ranking-slot', 'ranking-qualification-notice', 'ranking-tabs'].includes(node.props.testID))
    .map((node: any) => node.props.testID).filter((id: string, index: number, all: string[]) => all.indexOf(id) === index);
  await h.flush();
  return h;
}

describe('최종 랭킹 참가 기준 안내 on the ranking tab', () => {
  it('a short participant sees one small red line with ⓘ right above the list tabs; it opens every figure', async (t) => {
    const h = await rankingTab(t);
    assert.deepEqual(h.reads, [SEASON_ID], 'asked once, for the season on screen');
    const order = h.headerOrder();
    assert.equal(order.indexOf('ranking-qualification-notice') > -1, true);
    assert.equal(order.indexOf('ranking-qualification-notice'), order.indexOf('ranking-tabs') - 1, 'right above the list tabs');
    assert.equal(order.includes('ranking-my-card') && order.indexOf('ranking-my-card') < order.indexOf('ranking-qualification-notice'), true, 'below 내 순위');
    const [button] = h.host('ranking-qualification-notice');
    assert.equal(button.type, 'Pressable');
    assert.equal(button.props.accessibilityRole, 'button');
    const touch = flatten(button.props.style);
    assert.equal(touch.backgroundColor === undefined && touch.borderWidth === undefined, true, 'no card, background or border');
    const [text] = h.host('ranking-qualification-text');
    assert.equal(h.text('ranking-qualification-text'), '최종 랭킹 참가 기준을 아직 충족하지 못했습니다.');
    const style = flatten(text.props.style);
    assert.equal([style.fontSize, style.color].join('/'), `13/${semantic.error}`);
    assert.equal(text.props.numberOfLines === undefined, true, 'wraps whole, never cut');
    assert.equal(h.host('ranking-qualification-info').length, 1, 'the ⓘ mark is part of the control');
    assert.equal(h.host('ranking-qualification-sheet').length, 0);
    await act(async () => { button.props.onPress(); });
    await h.flush();
    const [sheet] = h.host('ranking-qualification-sheet');
    assert.equal(sheet.props.title, '최종 랭킹 참가 기준');
    assert.deepEqual(['required', 'current', 'remaining'].map((k) => h.text(`ranking-qualification-instruments-${k}`)), ['5개', '3개', '2개']);
    assert.deepEqual(['required', 'current', 'remaining'].map((k) => h.text(`ranking-qualification-turnover-${k}`)),
      ['30,000,000원', '12,000,000원', '18,000,000원']);
    assert.match(h.text('ranking-qualification-basis'), /잠정 판정/);
    await act(async () => { sheet.props.onClose(); });
    await h.flush();
    assert.equal(h.host('ranking-qualification-sheet').length, 0);
  });

  it('the sheet never stays over another tab', async (t) => {
    const h = await rankingTab(t);
    await act(async () => { h.host('ranking-qualification-notice')[0].props.onPress(); });
    await h.flush();
    assert.equal(h.host('ranking-qualification-sheet').length, 1);
    h.focused = false;
    await h.rerender();
    assert.equal(h.host('ranking-qualification-sheet').length, 0);
  });

  for (const [label, options] of [
    ['both criteria met', { answer: { ...shortOfBoth(), qualified: true, tradedInstrumentCount: 5, remainingTradedInstrumentCount: 0,
      tradedInstrumentRequirementMet: true, recognizedTurnoverKrw: '30000000.00000000', remainingRecognizedTurnoverKrw: '0.00000000', turnoverRequirementMet: true } }],
    ['a season without criteria', { answer: { state: 'not_applicable', season: season(), basis: null, qualified: null, criteria: null, reason: 'FINAL_RANKING_QUALIFICATION_NOT_REQUIRED' } }],
    ['an excluded participant', { answer: { state: 'unavailable', season: season(), basis: null, qualified: null, criteria: null, reason: 'PARTICIPANT_EXCLUDED' } }],
    ['a server error', { fail: true }],
  ] as const) {
    it(`${label}: no notice, and the ranking list is unchanged`, async (t) => {
      const h = await rankingTab(t, options as never);
      assert.equal(h.host('ranking-qualification-notice').length, 0);
      assert.deepEqual(h.headerOrder().filter((id: string) => id !== 'ranking-slot'), ['ranking-my-card', 'ranking-tabs']);
      assert.ok(h.host(`ranking-item-${availableRankings.rankings[0].userId}`).length > 0, 'rows still render');
    });
  }

  it('not joined: nothing is asked and nothing is shown', async (t) => {
    const h = await rankingTab(t, { joined: false });
    assert.deepEqual(h.reads, []);
    assert.equal(h.host('ranking-qualification-notice').length, 0);
  });

  it('after settlement the confirmed verdict says so, and 내 순위 names it instead of "waiting"', async (t) => {
    const h = await rankingTab(t, { status: 'settled', myRanking: { state: 'unavailable', reason: 'FINAL_RANKING_NOT_QUALIFIED', message: '' } });
    assert.equal(h.text('ranking-qualification-text'), '최종 랭킹 참가 기준을 충족하지 못해 최종 순위에 포함되지 않았습니다.');
    assert.equal(h.text('ranking-my-unavailable'), '최종 랭킹 자격 미충족');
    assert.equal(h.headerOrder().indexOf('ranking-qualification-notice'), h.headerOrder().indexOf('ranking-tabs') - 1);
  });

  it('a pending ranking still says it is waiting (only the settled verdict changes the words)', async (t) => {
    const h = await rankingTab(t, { myRanking: { state: 'unavailable', reason: 'RANKING_UNAVAILABLE', message: '' } });
    assert.equal(h.text('ranking-my-unavailable'), '내 랭킹 생성 대기 중입니다.');
  });
});
