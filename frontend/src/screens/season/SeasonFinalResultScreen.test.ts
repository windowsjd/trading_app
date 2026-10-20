import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it, type TestContext } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const query = require('@tanstack/react-query');

const IDS = TEST_IDS.seasonFinalResult;
const strings = (node: any): string[] =>
  node.children.flatMap((child: any) => (typeof child === 'string' ? [child] : strings(child)));

const ranked = {
  state: 'available', finalRank: 3, finalTier: 'gold',
  totalAssetKrw: '12345678.90000000', returnRate: '23.45670000', capturedAt: '2026-10-01T00:00:05.000Z',
};
const notQualified = {
  state: 'not_qualified', totalAssetKrw: '10200000.00000000', returnRate: '-1.50000000',
  tradedInstrumentCount: 2, recognizedTurnoverKrw: '1500000.00000000',
};
const body = (result: Record<string, unknown>, viewedAt: string | null = null) => ({
  season: { id: 'season-1', name: '2026 가을 시즌', status: 'settled', startAt: '2026-09-01T00:00:00.000Z', endAt: '2026-10-01T00:00:00.000Z' },
  participantStatus: result.state === 'excluded' ? 'excluded' : 'finished',
  viewedAt,
  result,
});

/** The real screen, records API module, badge card and React Query over a fixture transport. */
async function setup(t: TestContext, options: { read: Record<string, unknown> | 'fail'; view?: 'fail' }) {
  const ui = interactionHarness();
  ui.dimensions = { width: 390, height: 844, fontScale: 1 };
  const h: any = { reads: 0, views: 0, back: 0, read: options.read, view: options.view };
  const failure = () => Object.assign(new Error('offline'), { response: { status: 503, data: { success: false } } });
  const transport = { apiClient: {
    get: async (path: string) => {
      if (path !== '/records/me/seasons/season-1/final-result') throw new Error(`Unexpected read ${path}`);
      h.reads++;
      if (h.read === 'fail') throw failure();
      return { data: { success: true, data: h.read } };
    },
    post: async (path: string) => {
      if (path !== '/records/me/seasons/season-1/final-result/view') throw new Error(`Unexpected write ${path}`);
      h.views++;
      if (h.view === 'fail') throw failure();
      return { data: { success: true, data: { seasonId: 'season-1', viewedAt: '2026-10-02T01:02:03.000Z' } } };
    },
  } };
  const api = ui.load('src/features/record/api.ts', { '../../services/api/client': transport });
  h.client = new query.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: 0 } } });
  // The signed-in owner's account list, as TradingAccountContext caches it.
  h.client.setQueryData(QUERY_KEYS.tradingAccount.list('user-1'), {
    accounts: [
      { id: 'general', mode: 'general', season: null },
      { id: 'season-account', mode: 'season', season: { seasonId: 'season-1', seasonName: '2026 가을 시즌', seasonStatus: 'settled', finalResultViewedAt: null } },
    ],
  });
  const Screen = ui.load('src/screens/season/SeasonFinalResultScreen.tsx', {
    'react-native': ui.native,
    '@tanstack/react-query': query,
    '../../features/record/api': api,
    '../../theme/appearance': { useAppearance: () => ({ mode: 'light', financialPreference: 'red_blue', colors: {} }) },
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    '../../components/states/ErrorNotice': { default: 'ErrorNotice', __esModule: true },
    '../../components/states/ErrorState': { default: 'ErrorState', __esModule: true },
    '../../components/states/FullPageLoading': { default: 'FullPageLoading', __esModule: true },
  }).default;
  const navigation = { canGoBack: () => true, goBack: () => { h.back++; }, reset: () => { throw new Error('unexpected reset'); } };
  h.renderer = ui.render(React.createElement(query.QueryClientProvider, { client: h.client },
    React.createElement(Screen, { navigation, route: { params: { seasonId: 'season-1' } } })));
  h.flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
  t.after(() => { act(() => h.renderer.unmount()); h.client.clear(); });
  h.hosts = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id);
  h.text = (id: string) => h.hosts(id).flatMap(strings).join('');
  h.ids = () => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && typeof node.props.testID === 'string')
    .map((node: any) => node.props.testID);
  h.cta = (testID: string) => h.renderer.root.findAll((node: any) => node.type === 'CTAButton' && node.props.testID === testID);
  h.listViewedAt = () => h.client.getQueryData(QUERY_KEYS.tradingAccount.list('user-1')).accounts[1].season.finalResultViewedAt;
  h.resultViewedAt = () => h.client.getQueryData(QUERY_KEYS.record.seasonFinalResult('season-1')).viewedAt;
  await h.flush();
  return h;
}

it('shows a ranked result in order — emblem, tier, rank, return, assets, badge — and records the first view once', async (t) => {
  const h = await setup(t, { read: body(ranked) });
  const order = [IDS.emblem, IDS.tierName, IDS.rank, IDS.returnRate, IDS.totalAsset, IDS.badge];
  const ids: string[] = h.ids();
  const positions = order.map((id) => ids.indexOf(id));
  assert.equal(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), true,
    `order ${positions.join(',')}`);
  assert.equal(h.hosts('home-tier-image').length + h.hosts(`${IDS.emblem}-image`).length > 0, true, 'the tier emblem art');
  assert.equal(h.text(IDS.tierName), 'Gold');
  assert.equal(h.text(IDS.rank), '3위');
  assert.equal(h.text(IDS.returnRate), '+23.46%');
  assert.equal(h.text(IDS.totalAsset), '12,345,679원');
  // The same card 내 뱃지 draws, with the same figures.
  assert.equal(h.text('season-badge-season-1-rank'), '#3');
  assert.equal(h.text('season-badge-season-1-return'), '+23.46%');
  assert.equal(h.text('season-badge-season-1-total'), '12,345,679원');
  assert.equal(h.hosts(IDS.noBadge).length, 0);

  assert.equal(h.views, 1);
  assert.equal(h.resultViewedAt(), '2026-10-02T01:02:03.000Z');
  assert.equal(h.listViewedAt(), '2026-10-02T01:02:03.000Z', 'the entry flips from the stored answer');
  await h.flush();
  assert.equal(h.views, 1, 'one view per screen');

  act(() => h.cta(IDS.done)[0].props.onPress());
  assert.equal(h.back, 1);
});

it('keeps a not-qualified participant\'s settled assets and return, with no rank, tier, emblem or badge', async (t) => {
  const h = await setup(t, { read: body(notQualified) });
  assert.equal(h.hosts(`${IDS.emblem}-image`).length + h.hosts('home-tier-image').length, 0, 'no invented emblem');
  assert.equal(h.text(IDS.tierName), '최종 랭킹 자격 미충족');
  assert.equal(h.text(IDS.rank), '최종 랭킹 자격 미충족');
  assert.equal(h.text(IDS.returnRate), '-1.5%');
  assert.equal(h.text(IDS.totalAsset), '10,200,000원');
  assert.equal(h.hosts('season-badge-season-1-card').length, 0);
  assert.match(h.text(IDS.noBadge), /뱃지가 없습니다/);
  assert.equal(h.views, 1);
});

it('records an excluded result as seen, without any figure', async (t) => {
  const h = await setup(t, { read: body({ state: 'excluded' }) });
  assert.equal(h.text(IDS.tierName), '시즌 참가 제외');
  assert.match(h.text(IDS.status), /제외되어/);
  assert.equal(h.hosts(IDS.rank).length + h.hosts(IDS.totalAsset).length, 0);
  assert.equal(h.views, 1);
});

for (const [label, read] of [
  ['a season still being settled', body({ state: 'pending' })],
  ['an unverifiable stored result', body({ state: 'unavailable', reason: 'FINAL_RESULT_UNAVAILABLE' })],
  ['a season I did not join', body({ state: 'not_joined' })],
  ['a result I already saw', body(ranked, '2026-10-02T00:00:00.000Z')],
] as const) {
  it(`never records ${label}`, async (t) => {
    const h = await setup(t, { read });
    assert.equal(h.views, 0);
    assert.equal(h.listViewedAt(), null);
  });
}

it('a failed read shows the error with its cause and records nothing', async (t) => {
  const h = await setup(t, { read: 'fail' });
  const errors = h.renderer.root.findAll((node: any) => node.type === 'ErrorState');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].props.error instanceof Error, true);
  assert.equal(h.views, 0);
  assert.equal(h.listViewedAt(), null);
});

it('a failed save keeps the entry unseen and retries only on request', async (t) => {
  const h = await setup(t, { read: body(ranked), view: 'fail' });
  assert.equal(h.views, 1);
  assert.equal(h.listViewedAt(), null);
  assert.equal(h.resultViewedAt(), null);
  const notice = h.renderer.root.findAll((node: any) => node.type === 'ErrorNotice' && node.props.testID === IDS.viewError);
  assert.equal(notice.length, 1);
  assert.equal(notice[0].props.error instanceof Error, true);
  await h.flush();
  assert.equal(h.views, 1, 'no automatic retry loop');

  h.view = undefined;
  await act(async () => { h.cta(IDS.viewRetry)[0].props.onPress(); });
  await h.flush();
  assert.equal(h.views, 2);
  assert.equal(h.listViewedAt(), '2026-10-02T01:02:03.000Z');
  assert.equal(h.hosts(IDS.viewError).length, 0);
});
