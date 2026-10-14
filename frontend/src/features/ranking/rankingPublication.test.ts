import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { availableRankings } from './fixtures.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { semantic } from '../../theme/tokens.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
const query = require('@tanstack/react-query');

async function setup(t, conflict = false, state = 'active') {
  const native = interactionHarness();
  const calls = [];
  let generation = 1;
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const publication = () => ({ ...structuredClone(availableRankings),
    season: { ...availableRankings.season, status: state }, rankType: state === 'settled' ? 'final' : 'daily',
    capturedAt: `2026-09-01T00:0${generation}:00.000Z` });
  const api = {
    getRankingTier: () => 'Silver',
    getRankings: async params => {
      calls.push(params);
      if (params.limit === 3) return publication();
      if (conflict) { conflict = false; generation = 2; }
      if (params.capturedAt !== publication().capturedAt) {
        throw { response: { data: { error: { code: 'RANKING_SNAPSHOT_CHANGED' } } } };
      }
      const data = publication();
      if (params.scope === 'friends') data.rankings = [{ ...data.rankings[0], userId: 'friend-42', seasonParticipantId: 'sp-42', rank: 42 }];
      return data;
    },
    // 순위 안내 row reads: no rows here (the slot keeps only what the publication shows).
    getRankingSlice: async params => ({ state: 'unavailable', season: null, rankType: params.rankType,
      rankingDate: params.rankingDate, capturedAt: null, rankings: [],
      pagination: { limit: params.limit, offset: params.offset, total: 0, returned: 0, nextOffset: null },
      myRanking: { state: 'unavailable', reason: 'RANKING_UNAVAILABLE', message: 'Ranking is unavailable.' } }),
  };
  const Screen = native.load('src/screens/ranking/RankingScreen.tsx', {
    'react-native': { ...native.native, SafeAreaView: 'SafeAreaView',
      FlatList: ({ ListHeaderComponent, ListEmptyComponent, ListFooterComponent, data, renderItem }) =>
        React.createElement('List', null, ListHeaderComponent,
          data.length ? data.map(item => React.createElement(React.Fragment, { key: item.seasonParticipantId }, renderItem({ item }))) : ListEmptyComponent,
          ListFooterComponent),
    },
    '@tanstack/react-query': query,
    '../../features/ranking/api': api,
    '../../features/season/api': { getCurrentSeason: async () => ({ ...publication().season, joined: true }) },
    '../../features/me/api': { getMe: async () => ({ nickname: 'me' }) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
    '@react-navigation/native': { useIsFocused: () => true },
  }).default;
  const renderer = native.render(React.createElement(query.QueryClientProvider, { client },
    React.createElement(Screen, { navigation: { navigate() {} } })));
  t.after(() => { act(() => renderer.unmount()); client.clear(); });
  const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); };
  const node = id => renderer.root.findByProps({ testID: id });
  // The publication (limit 3) is read, never drawn: count its reads and read
  // my rank from it instead of a podium card.
  const publicationReads = () => calls.filter(p => p.limit === 3).length;
  const myRank = () => renderer.root.findAll(n => n.props?.testID === 'ranking-my-rank' && typeof n.type === 'string')[0]?.props.children;
  const podiumCards = () => renderer.root.findAll(n => typeof n.props?.testID === 'string' && n.props.testID.startsWith('ranking-top')).length;
  await flush();
  return { renderer, client, calls, node, flush, publicationReads, myRank, podiumCards, advance: () => { generation++; } };
}

it('tab changes keep the canonical publication and refresh adopts one new publication for both queries', async t => {
  const h = await setup(t);
  assert.equal(h.podiumCards(), 0);
  const reads = h.publicationReads(), rank = h.myRank();
  assert.equal(rank, '#2');
  await act(async () => h.node('ranking-tab-friends').props.onPress());
  assert.equal(h.publicationReads(), reads);
  await h.flush();
  assert.ok(h.node('ranking-item-friend-42'));
  assert.equal(h.publicationReads(), reads, 'a tab change never re-reads the publication');
  assert.equal(h.myRank(), rank);
  h.advance();
  await act(async () => { await h.client.invalidateQueries({ queryKey: QUERY_KEYS.ranking.list({
    scope: 'all', seasonId: availableRankings.season!.id, rankType: 'daily', limit: 3, offset: 0,
  }) }); });
  await h.flush();
  const newest = h.calls.filter(p => p.scope === 'friends').at(-1);
  assert.equal(newest.capturedAt, '2026-09-01T00:02:00.000Z');
  assert.equal(newest.rankingDate, availableRankings.rankingDate);
  assert.equal(newest.seasonId, availableRankings.season!.id);
  assert.equal(newest.rankType, 'daily');
  assert.equal(h.myRank(), rank);
});

it('a publication race recovers by refetching the canonical publication before the scoped list', async t => {
  const h = await setup(t, true);
  assert.equal(h.podiumCards(), 0);
  assert.ok(h.node('ranking-item-user-1'));
  const topCalls = h.calls.filter(p => p.limit === 3);
  assert.equal(topCalls.length, 2);
  assert.equal(h.calls.at(-1).capturedAt, '2026-09-01T00:02:00.000Z');
  assert.ok(h.calls.length <= 5, 'bounded snapshot recovery');
});

for (const state of ['active', 'settled']) it(`${state}: secondary tab state preserves the canonical and scoped publication`, async t => {
  const h = await setup(t, false, state);
  const reads = h.publicationReads(), rank = h.myRank();
  for (const scope of ['all', 'friends', 'top10']) {
    act(() => h.node(`ranking-tab-${scope}`).props.onPress());
    await h.flush();
    for (const [key, label] of [['all', '전체'], ['friends', '친구'], ['top10', 'TOP10']]) {
      const tab = h.node(`ranking-tab-${key}`), selected = key === scope;
      assert.equal(tab.props.accessibilityRole, 'tab');
      assert.equal(tab.props.accessibilityLabel, label);
      assert.equal(tab.props.accessibilityState.selected, selected);
      assert.equal(tab.props['aria-selected'], selected);
      // One sliding selector: before measurement the selected segment paints the pill.
      assert.equal(flatten(tab.props.style).backgroundColor, selected ? semantic.surface : undefined);
      assert.equal(flatten(tab.findByType('Text').props.style).color, selected ? semantic.text : semantic.secondary);
    }
    assert.equal(h.publicationReads(), reads);
    assert.equal(h.myRank(), rank);
    assert.equal(h.podiumCards(), 0);
    const list = h.calls.filter(p => p.scope === scope && p.limit !== 3).at(-1);
    assert.equal(list.limit, scope === 'top10' ? 10 : 50);
    assert.equal(list.rankType, state === 'settled' ? 'final' : 'daily');
    assert.equal(list.capturedAt, '2026-09-01T00:01:00.000Z');
    assert.equal(list.rankingDate, availableRankings.rankingDate);
    assert.equal(list.seasonId, availableRankings.season.id);
    if (scope === 'friends') assert.ok(h.node('ranking-item-friend-42'));
  }
  assert.ok(h.calls.filter(p => p.limit === 3).every(p => p.scope === 'all'));
});
