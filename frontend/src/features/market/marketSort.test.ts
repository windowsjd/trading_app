import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { marketSortParams, nextMarketPage } from './marketSort.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const { load } = require('../../../test/ledgerTestHarness.cjs');

it('isolates every market/search sort query and carries the server snapshot across pages', () => {
  const keys = (['turnover_desc', 'turnover_asc', 'change_desc', 'change_asc'] as const).flatMap(sort => ['crypto', 'us_stock', 'domestic_stock'].map(assetType =>
    QUERY_KEYS.market.assets({ assetType, search: '삼성', withPrice: true, ...marketSortParams(sort) })));
  assert.equal(new Set(keys.map(key => JSON.stringify(key))).size, 12);
  assert.deepEqual(nextMarketPage({ assets: [], pagination: { nextOffset: 20, limit: 20, offset: 0, returned: 20, total: 40 }, sortSnapshot: 'server-token' }), { offset: 20, sortSnapshot: 'server-token' });
  assert.equal(nextMarketPage({ assets: [], pagination: { nextOffset: null, limit: 20, offset: 20, returned: 20, total: 40 }, sortSnapshot: 'server-token' }), undefined);
});
it('serializes sort and continuation without reordering returned rows', async () => {
  let path;
  const response = { assets: [{ id: 'b' }, { id: 'a' }], pagination: { nextOffset: null }, sortSnapshot: 'token' };
  const api = load(require.resolve('./api.ts'), { '../../services/api/client': { apiClient: { get: async url => { path = url; return { data: { data: response } }; } } } });
  const result = await api.getAssets({ assetType: 'crypto', search: '比特币', sortBy: 'changeRate', sortOrder: 'asc', sortSnapshot: 'token', limit: 20, offset: 20 });
  const url = new URL(path, 'https://fixture.invalid');
  assert.equal(url.searchParams.get('sortBy'), 'changeRate');
  assert.equal(url.searchParams.get('sortOrder'), 'asc');
  assert.equal(url.searchParams.get('sortSnapshot'), 'token');
  assert.equal(url.searchParams.get('search'), '比特币');
  assert.deepEqual(result.assets.map(a => a.id), ['b', 'a']);
});
it('offers two criteria and separate neutral ASC/DESC controls, preserving direction', () => {
  const h = interactionHarness('android');
  const Control = h.load('src/features/market/MarketSortControl.tsx').default;
  let choice;
  function Stateful() {
    const [value, setValue] = React.useState('turnover_desc');
    return React.createElement(Control, { value, onChange: (next) => { choice = next; setValue(next); } });
  }
  const renderer = h.render(React.createElement(Stateful));
  try {
    const node = (id) => renderer.root.findByProps({ testID: `market-sort-${id}` });
    assert.equal(node('turnover').props.accessibilityState.checked, true);
    assert.equal(node('desc').props.accessibilityState.checked, true);
    assert.equal(node('asc').props.accessibilityLabel, '오름차순');
    assert.equal(node('desc').props.accessibilityLabel, '내림차순');
    act(() => node('asc').props.onPress());
    assert.equal(choice, 'turnover_asc');
    act(() => node('changeRate').props.onPress());
    assert.equal(choice, 'change_asc');
    act(() => node('desc').props.onPress());
    assert.equal(choice, 'change_desc');
    act(() => node('turnover').props.onPress());
    assert.equal(choice, 'turnover_desc');
    for (const direction of ['asc', 'desc']) {
      assert.equal(node(direction).props.style[0].minHeight, 44);
      assert.equal(node(direction).props.style[0].minWidth, 44);
    }
  } finally { act(() => renderer.unmount()); }
});
