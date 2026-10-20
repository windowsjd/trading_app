import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it, type TestContext } from 'node:test';
import { financial } from '../../theme/financialColors.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const query = require('@tanstack/react-query');

const strings = (node: any): string[] =>
  node.children.flatMap((child: any) => (typeof child === 'string' ? [child] : strings(child)));

/** One `/records/me/seasons` item as records.service returns it. */
const season = (patch: Record<string, unknown> = {}) => ({
  seasonId: 'season-1', seasonName: 'Season 1', seasonStatus: 'settled', joinedAt: '2026-05-01T00:00:00.000Z',
  participantStatus: 'finished', initialCapitalKrw: '10000000.00000000', finalRank: 3, finalTier: 'gold', finalQualified: null,
  rewardGrantedAt: null, latestTotalAssetKrw: '10450000.00000000', latestReturnRate: '4.50000000',
  orderCount: 3, exchangeCount: 0, walletTransactionCount: 2, ...patch,
});

/** The real screen, records API module and StandingCard over a fixture transport; `pages` by offset. */
async function badgesHarness(t: TestContext, { pages, fail = false }: { pages: Array<Array<Record<string, unknown>>>; fail?: boolean }) {
  const ui = interactionHarness();
  ui.dimensions = { width: 390, height: 844, fontScale: 1 };
  const h: any = { requests: [] as string[], navigations: [] as unknown[][], fail };
  const transport = { apiClient: { get: async (path: string) => {
    h.requests.push(path);
    const url = new URL(path, 'https://fixture.invalid');
    if (url.pathname !== '/records/me/seasons') throw new Error(`Unexpected read ${path}`);
    if (h.fail) throw Object.assign(new Error('offline'), { response: { status: 503, data: { success: false } } });
    const limit = Number(url.searchParams.get('limit'));
    const index = Number(url.searchParams.get('offset')) / limit;
    const items = pages[index] ?? [];
    const total = pages.flat().length;
    return { data: { success: true, data: { state: total ? 'available' : 'empty', seasons: items,
      pagination: { limit, offset: index * limit, total, returned: items.length, nextOffset: index + 1 < pages.length ? (index + 1) * limit : null },
      filters: { seasonStatus: url.searchParams.get('seasonStatus') } } } };
  } } };
  const api = ui.load('src/features/record/api.ts', { '../../services/api/client': transport });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const Screen = ui.load('src/screens/my/MyBadgesScreen.tsx', {
    'react-native': { ...ui.native, SafeAreaView: 'SafeAreaView',
      FlatList: ({ ListHeaderComponent, ListEmptyComponent, ListFooterComponent, data, renderItem, keyExtractor, testID }: any) =>
        React.createElement('List', { testID }, ListHeaderComponent,
          data.length ? data.map((item: any) => React.createElement(React.Fragment, { key: keyExtractor(item) }, renderItem({ item })))
            : ListEmptyComponent, ListFooterComponent),
    },
    '@tanstack/react-query': query,
    '../../features/record/api': api,
    '../../theme/appearance': { useAppearance: () => ({ mode: 'light', financialPreference: 'red_blue', colors: {} }) },
    '../../components/common/ActionPressable': { default: ui.ActionPressable, __esModule: true },
    '../../components/states/FullPageLoading': { default: 'FullPageLoading', __esModule: true },
    '../../components/states/ErrorState': { default: 'ErrorState', __esModule: true },
    '../../components/states/EmptyState': { default: 'EmptyState', __esModule: true },
  }).default;
  h.renderer = ui.render(React.createElement(query.QueryClientProvider, { client },
    React.createElement(Screen, { navigation: { navigate: (...args: unknown[]) => h.navigations.push(args) } })));
  h.flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); }); };
  t.after(() => { act(() => h.renderer.unmount()); client.clear(); });
  h.hosts = (id: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === id);
  h.node = (id: string) => h.hosts(id)[0];
  h.has = (id: string) => h.hosts(id).length > 0;
  h.text = (id: string) => strings(h.node(id)).join('');
  h.ofType = (type: string) => h.renderer.root.findAll((node: any) => node.type === type);
  await h.flush();
  return h;
}

it('asks only for settled seasons and shows one tier card per season with its own final result', async (t) => {
  const h = await badgesHarness(t, { pages: [[
    season({ seasonId: 'season-3', seasonName: 'Season 3', finalRank: 1, finalTier: 'master',
      latestReturnRate: '-12.34560000', latestTotalAssetKrw: '8765432.00000000' }),
    season(),
    // Settled but not ranked: settlement confirmed it did not qualify, or it was excluded.
    season({ seasonId: 'season-2', seasonName: 'Season 2', finalRank: null, finalTier: null, finalQualified: false }),
    season({ seasonId: 'season-0', seasonName: 'Season 0', finalRank: null, finalTier: null, participantStatus: 'excluded' }),
  ]] });
  assert.equal(h.requests.length, 1);
  const params = new URL(h.requests[0], 'https://fixture.invalid').searchParams;
  assert.deepEqual([params.get('seasonStatus'), params.get('limit'), params.get('offset')], ['settled', '100', '0']);
  assert.deepEqual(h.renderer.root.findAll((node: any) => typeof node.type === 'string'
    && /^season-badge-[^-]+-\d+-card$/.test(String(node.props.testID))).map((node: any) => node.props.testID),
  ['season-badge-season-3-card', 'season-badge-season-1-card']);
  assert.deepEqual(['season', 'rank', 'tier', 'return', 'total'].map((part) => h.text(`season-badge-season-1-${part}`)),
    ['Season 1', '#3', 'Gold', '+4.5%', '10,450,000원']);
  assert.deepEqual(['season', 'rank', 'tier', 'return', 'total'].map((part) => h.text(`season-badge-season-3-${part}`)),
    ['Season 3', '#1', 'Whale', '-12.35%', '8,765,432원']);
  assert.equal(h.node('season-badge-season-1-figures').props.accessibilityLabel, '최종 수익률 +4.5%, 최종 자산 10,450,000원');
  // Each card keeps its tier's emblem art; the unranked seasons have none.
  assert.equal(h.node('season-badge-season-1-card').findAll((node: any) => node.props.testID === 'home-emblem-gold').length > 0, true);
  assert.equal(h.node('season-badge-season-3-card').findAll((node: any) => node.props.testID === 'home-emblem-whale').length > 0, true);
  assert.equal(h.has('season-badge-season-2-card') || h.has('season-badge-season-0-card'), false);
  // The Ranking tab's labels for a final result.
  const labels = h.node('season-badge-season-1-card').findAll((node: any) => node.type === 'Text').map((node: any) => strings(node).join(''));
  assert.equal(['최종 순위', '최종 수익률', '최종 자산'].every((label) => labels.includes(label)), true);
  // A rising (Gold) and a falling (Whale) final return read exactly as the final assets beside them:
  // the tier's ink and halo at 16/700, no direction color and no chip.
  for (const id of ['season-1', 'season-3']) {
    const ink = flatten(h.node(`season-badge-${id}-return`).props.style);
    assert.deepEqual(ink, flatten(h.node(`season-badge-${id}-total`).props.style), id);
    assert.deepEqual([ink.fontSize, ink.fontWeight, typeof ink.color], [16, '700', 'string'], id);
    assert.equal([financial.rise, financial.fall].includes(ink.color), false, id);
    assert.equal(h.has(`season-badge-${id}-return-chip`), false, id);
  }
});

it('reads every page so an older season is never missing', async (t) => {
  const first = Array.from({ length: 100 }, (_, index) => season({ seasonId: `season-${200 - index}`, seasonName: `S${200 - index}` }));
  const h = await badgesHarness(t, { pages: [first, [season({ seasonId: 'season-1', seasonName: 'Oldest' })]] });
  assert.deepEqual(h.requests.map((path: string) => new URL(path, 'https://fixture.invalid').searchParams.get('offset')), ['0', '100']);
  assert.equal(h.text('season-badge-season-1-season'), 'Oldest');
  assert.equal(h.renderer.root.findAll((node: any) => typeof node.type === 'string'
    && /^season-badge-season-\d+-card$/.test(String(node.props.testID))).length, 101);
});

it('without a settled final result it says so, and never shows a provisional standing', async (t) => {
  const h = await badgesHarness(t, { pages: [[season({ seasonStatus: 'ended', finalRank: 2 }), season({ finalRank: null, finalTier: null })]] });
  const [empty] = h.ofType('EmptyState');
  assert.deepEqual([empty.props.title, empty.props.message],
    ['아직 보관된 시즌 뱃지가 없습니다.', '시즌이 정산되면 그 시즌의 최종 티어와 성적이 이곳에 보관됩니다.']);
  assert.equal(h.renderer.root.findAll((node: any) => /^season-badge-/.test(String(node.props?.testID))).length, 0);
});

it('a failed read is an error with a retry, not an empty archive', async (t) => {
  const h = await badgesHarness(t, { pages: [[season()]], fail: true });
  const [error] = h.ofType('ErrorState');
  assert.equal(error.props.title, '뱃지를 불러오지 못했습니다.');
  assert.equal(h.ofType('EmptyState').length, 0);
  h.fail = false;
  await act(async () => { error.props.onRetry(); });
  await h.flush();
  assert.equal(h.text('season-badge-season-1-rank'), '#3');
});

it('keeps the reward ledger one tap away, apart from the badges', async (t) => {
  const h = await badgesHarness(t, { pages: [[season()]] });
  const link = h.node('my-badges-reward-history');
  assert.match(strings(link).join(' '), /보상 지급 내역/);
  await act(async () => { link.props.onPress(); });
  assert.deepEqual(h.navigations, [['Reward']]);
});
