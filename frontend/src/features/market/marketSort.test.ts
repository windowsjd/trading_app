import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { marketSortParams, nextMarketPage } from './marketSort.ts';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');
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
  const Control = h.load('src/features/market/MarketSortControl.tsx', {
    '../../components/common/ActionPressable': { default: h.ActionPressable, __esModule: true },
  }).default;
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
      const button = renderer.root.findAllByType('Pressable').find(n => n.props.testID === `market-sort-${direction}`);
      assert.equal(node(direction).props.feedback, 'none');
      const style = flatten(button.props.style);
      assert.equal(style.height, 24);
      assert.equal(style.width, 44);
      for (const key of ['backgroundColor', 'borderWidth', 'borderRadius', 'transform']) assert.equal(style[key], undefined);
      const before = h.animations.length;
      act(() => button.props.onPressIn({ nativeEvent: { pageX: 10, pageY: 10 } }));
      act(() => button.props.onPressOut({ nativeEvent: {} }));
      assert.equal(h.animations.length, before, 'direction presses never animate');
      assert.equal(button.findAllByType('AnimatedView').length, 0);
      const triangle = flatten(renderer.root.findAllByType('View').find(n => n.props.testID === `market-sort-${direction}-triangle`).props.style);
      assert.equal(triangle.borderLeftWidth + triangle.borderRightWidth, 10);
      assert.equal(triangle.borderTopWidth ?? triangle.borderBottomWidth, 7);
      assert.equal(triangle.backgroundColor, undefined);
    }
  } finally { act(() => renderer.unmount()); }
});
