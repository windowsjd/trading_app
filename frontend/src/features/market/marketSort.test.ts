import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { marketSortParams, nextMarketPage } from './marketSort.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const { load } = require('../../../test/ledgerTestHarness.cjs');

it('isolates every market/search sort query and carries the server snapshot across pages', () => {
  const keys = (['volume_desc', 'change_desc', 'change_asc'] as const).flatMap(sort => ['crypto', 'us_stock', 'domestic_stock'].map(assetType =>
    QUERY_KEYS.market.assets({ assetType, search: '삼성', withPrice: true, ...marketSortParams(sort) })));
  assert.equal(new Set(keys.map(key => JSON.stringify(key))).size, 9);
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
it('sort sheet exposes three choices, selected state, period and base-unit meaning', () => {
  const h = interactionHarness('android');
  const Control = h.load('src/features/market/MarketSortControl.tsx', {
    '../../components/common/BottomSheetBackdrop': { __esModule: true, default: ({ visible, children }) => visible ? children : null },
  }).default;
  let choice;
  const renderer = h.render(React.createElement(Control, { value: 'volume_desc', assetType: 'crypto', onChange: value => { choice = value; } }));
  try {
    let trigger = renderer.root.findByProps({ testID: 'market-sort-trigger' });
    act(() => trigger.props.onPress());
    const options = renderer.root.findAllByProps({ accessibilityRole: 'radio' });
    // Composite and host nodes may both expose the role; inspect exact test id.
    for (const id of ['volume_desc', 'change_desc', 'change_asc']) assert.ok(renderer.root.findByProps({ testID: `market-sort-${id}` }));
    assert.ok(options.some(node => node.props.accessibilityState.checked));
    assert.ok(renderer.root.findAllByType('Text').some(node => String(node.props.children).includes('코인마다 단위가 달라')));
    act(() => renderer.root.findByProps({ testID: 'market-sort-change_asc' }).props.onPress());
    assert.equal(choice, 'change_asc');
    trigger = renderer.root.findByProps({ testID: 'market-sort-trigger' });
    assert.equal(trigger.props.accessibilityState.expanded, false);
  } finally { act(() => renderer.unmount()); }
});
