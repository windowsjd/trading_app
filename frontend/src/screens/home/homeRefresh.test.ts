import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); };

for (const mode of ['general', 'season']) {
  it(`${mode} Home pulls only visible scoped queries, retaining trend state and late-response isolation`, async () => {
    const h = interactionHarness();
    const requests: Array<{ section: string; account?: string; range?: string; season?: string }> = [];
    let fail = false;
    let release;
    let gate: Promise<void> | null = null;
    const read = async (section, account, range?) => {
      requests.push({ section, account, ...(range ? { range } : {}) });
      if (gate) await gate;
      if (fail) throw new Error('offline');
      if (section === 'positions') return { positions: [] };
      if (section === 'equity') return { points: [] };
      return { state: 'available', sectionErrors: [], summary: { totalAssetKrw: account } };
    };
    const Screen = h.load(`src/screens/home/${mode === 'general' ? 'General' : 'Season'}AccountHome.tsx`, {
      '../../features/tradingAccount/api': {
        getTradingAccountPortfolio: account => read('portfolio', account),
        getTradingAccountPositions: account => read('positions', account),
        getTradingAccountEquity: (account, range) => read('equity', account, range),
      },
      '../../features/ranking/api': {
        getRankings: async params => { requests.push({ section: 'ranking', season: params.seasonId }); return { myRanking: { state: 'unavailable' } }; },
        getRankingTier: () => '-',
      },
      '../../features/me/api': { getMe: async () => { requests.push({ section: 'me' }); return { nickname: 'User' }; } },
      './HomeAssetHero': { __esModule: true, default: 'Hero' },
      './HomeAssetTrend': { __esModule: true, default: 'Trend' },
      '../../components/tradingAccount/PositionAssetRow': { __esModule: true, default: 'Position' },
      '../../components/common/CTAButton': { __esModule: true, default: 'CTA' },
      ...Object.fromEntries(['ErrorState', 'InlineEmptyState', 'SectionSkeleton'].map(name => [
        '../../components/states/' + name, { __esModule: true, default: name },
      ])),
    }).default;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    const account = id => ({ id, mode, season: mode === 'season' ? { seasonId: `season-${id}`, seasonStatus: 'active' } : null });
    const render = id => React.createElement(QueryClientProvider, { client }, React.createElement(Screen, {
      key: id, account: account(id), capabilities: { canTrade: true, canExchange: true }, onOpenFx() {}, onOpenAsset() {}, onOpenReward() {},
    }));
    const renderer = h.render(render('account-one'));
    const scroll = () => renderer.root.findByType('ScrollView');
    const trend = () => renderer.root.findByType('Trend');
    try {
      await flush();
      assert.equal(requests.some(request => request.section === 'equity'), false);
      requests.length = 0;
      act(() => { void scroll().props.refreshControl.props.onRefresh(); void scroll().props.refreshControl.props.onRefresh(); });
      await flush();
      assert.deepEqual(requests.map(r => r.section).sort(), mode === 'general' ? ['portfolio', 'positions'] : ['me', 'portfolio', 'positions', 'ranking']);
      act(() => trend().props.onToggle()); await flush();
      act(() => trend().props.onRangeChange('90d')); await flush();
      requests.length = 0;
      fail = true;
      act(() => { void scroll().props.refreshControl.props.onRefresh(); }); await flush();
      assert.equal(trend().props.expanded, true);
      assert.equal(trend().props.range, '90d');
      assert.equal(renderer.root.findByType('Hero').props.summary.totalAssetKrw, 'account-one');
      assert.equal(scroll().props.refreshControl.props.refreshing, false);
      assert.deepEqual(requests.filter(r => r.account).map(r => r.account), ['account-one', 'account-one', 'account-one']);
      assert.equal(requests.find(r => r.section === 'equity')?.range, '90d');
      if (mode === 'season') assert.equal(requests.find(r => r.section === 'ranking')?.season, 'season-account-one');
      fail = false;
      gate = new Promise(resolve => { release = resolve; });
      act(() => { void scroll().props.refreshControl.props.onRefresh(); });
      // A late outgoing refresh completes after the newly selected account has mounted.
      gate = null;
      act(() => renderer.update(render('account-two'))); await flush();
      assert.equal(renderer.root.findByType('Hero').props.summary.totalAssetKrw, 'account-two');
      await act(async () => release()); await flush();
      assert.equal(renderer.root.findByType('Hero').props.summary.totalAssetKrw, 'account-two');
    } finally { act(() => renderer.unmount()); client.clear(); }
  });
}
