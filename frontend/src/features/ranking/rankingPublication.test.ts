import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { availableRankings } from './fixtures.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const query = require('@tanstack/react-query');

async function setup(t, conflict = false) {
  const native = interactionHarness();
  const calls = [];
  let generation = 1;
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const publication = () => ({ ...structuredClone(availableRankings), capturedAt: `2026-09-01T00:0${generation}:00.000Z` });
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
    '../../features/season/api': { getCurrentSeason: async () => ({ ...availableRankings.season, joined: true }) },
    '../../features/me/api': { getMe: async () => ({ nickname: 'me' }) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({ navigate() {} }) },
  }).default;
  const renderer = native.render(React.createElement(query.QueryClientProvider, { client },
    React.createElement(Screen, { navigation: { navigate() {} } })));
  t.after(() => { act(() => renderer.unmount()); client.clear(); });
  const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); };
  const node = id => renderer.root.findByProps({ testID: id });
  await flush();
  return { renderer, client, calls, node, flush, advance: () => { generation++; } };
}

it('tab changes preserve global TOP3 and refresh adopts one new publication for both queries', async t => {
  const h = await setup(t);
  const top = () => h.node('ranking-top3').findAllByType('Pressable').map(n => n.props.testID);
  const initial = top();
  await act(async () => h.node('ranking-tab-friends').props.onPress());
  assert.deepEqual(top(), initial);
  await h.flush();
  assert.ok(h.node('ranking-item-friend-42'));
  assert.deepEqual(top(), initial);
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
  assert.deepEqual(top(), initial);
});

it('a publication race recovers by refetching canonical TOP3 before the scoped list', async t => {
  const h = await setup(t, true);
  assert.ok(h.node('ranking-top3'));
  assert.ok(h.node('ranking-item-user-1'));
  const topCalls = h.calls.filter(p => p.limit === 3);
  assert.equal(topCalls.length, 2);
  assert.equal(h.calls.at(-1).capturedAt, '2026-09-01T00:02:00.000Z');
  assert.ok(h.calls.length <= 5, 'bounded snapshot recovery');
});
