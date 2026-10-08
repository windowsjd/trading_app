import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createRequire } from 'node:module';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { primaryGradient, semantic } from '../../theme/tokens.ts';
const require = createRequire(import.meta.url);
const { setup, account, position, asset, flush, act } = require('../../../test/homeDiscoveryHarness.cjs');
// AssetsService verifies this same fixture through the real Binance parser/writer,
// selected snapshot and turnover reader before checking its API result.
const cryptoContract = require('../../../../backend/src/assets/fixtures/binance-crypto-hot-contract.json');

for (const mode of ['season', 'general']) {
  for (const count of [0, 1, 7, 207]) it(`${mode}: ${count} holdings use server order, lazy complete pagination and collapse`, async t => {
    const h = setup(mode, count); t.after(h.close); await flush();
    assert.equal(h.rows().length, count ? 1 : 0);
    assert.equal(!!h.node('home-holdings-toggle'), count > 1);
    const requests = h.requests.filter(r => r.section === 'positions');
    assert.deepEqual(requests.map(r => [r.limit, r.offset]), [[1, 0]]);
    if (count) {
      assert.equal(h.rows()[0].props.testID, `home-position-item-${mode}-a0`);
      assert.equal(h.node(`home-position-item-${mode}-a0-value`).props.children, '$100');
    }
    if (count > 1) {
      let release; const gate = new Promise(resolve => { release = resolve; });
      h.beforeRead = async r => { if (r.section === 'positions' && r.limit === 100) await gate; };
      await h.press('home-holdings-toggle');
      assert.equal(h.node('home-holdings-toggle').props.accessibilityState.expanded, true);
      assert.equal(h.rows().length, 1, 'representative remains during loading');
      assert.ok(h.node('home-holdings-loading'));
      await act(async () => release()); await flush();
      assert.equal(h.rows().length, count);
      assert.ok(h.node(`home-position-item-${mode}-a${count - 1}`));
      assert.deepEqual(h.requests.filter(r => r.section === 'positions' && r.limit === 100).map(r => r.offset), count === 207 ? [0, 100, 200] : [0]);
      await h.press('home-holdings-toggle');
      assert.equal(h.rows().length, 1);
      assert.equal(h.node('home-holdings-toggle').props.accessibilityState.expanded, false);
    }
  });
}

it('unavailable valuations have no arbitrary representative but remain accessible, including a lone position', async t => {
  const h = setup('season', 2); t.after(h.close);
  h.positions.season = [position(0, 'season', true), position(1, 'season', true)]; await flush();
  assert.equal(h.rows().length, 0);
  assert.ok(h.renderer.root.findAllByType('InlineEmptyState').some(n => /대표 보유자산/.test(n.props.message)));
  await h.press('home-holdings-toggle'); assert.equal(h.rows().length, 2);
  h.positions.single = [position(0, 'single', true)]; await h.switch(account('general', 'single'));
  assert.equal(h.rows().length, 1); assert.equal(h.node('home-holdings-toggle') === undefined, true);
  assert.equal(h.node('home-position-item-single-a0-value').props.children, '-');
});

it('a later page failure retains the representative and retry never presents a partial list as complete', async t => {
  const h = setup('season', 207); t.after(h.close); await flush();
  h.beforeRead = async r => { if (r.offset === 100) throw new Error('offline'); };
  await h.press('home-holdings-toggle');
  assert.equal(h.rows().length, 1);
  const error = h.renderer.root.findAllByType('ErrorState').find(n => n.props.title.startsWith('전체 보유'));
  assert.ok(error);
  h.beforeRead = async () => {};
  await act(async () => error.props.onRetry()); await flush();
  assert.equal(h.rows().length, 207);
});

it('HOT uses the Market turnover DESC result and stable order for each category, with exact navigation', async t => {
  const h = setup(); t.after(h.close); await flush();
  for (const type of ['domestic_stock', 'us_stock', 'crypto']) {
    await h.press(`home-hot-tab-${type}`);
    const request = h.requests.find(r => r.section === 'hot' && r.assetType === type);
    assert.equal(request.sortBy, 'turnover'); assert.equal(request.sortOrder, 'desc');
    assert.equal(request.limit, 5); assert.equal(request.offset, 0); assert.equal(request.withPrice, true);
    assert.equal(h.node(`home-hot-tab-${type}`).props.accessibilityState.selected, true);
    for (const category of ['domestic_stock', 'us_stock', 'crypto']) {
      const tab = h.node(`home-hot-tab-${category}`);
      assert.equal(tab.props.accessibilityRole, 'tab');
      assert.equal(tab.props['aria-selected'], category === type);
      assert.equal(Object.assign({}, ...tab.props.style.filter(Boolean)).backgroundColor,
        category === type ? semantic.secondaryActionSurface : undefined);
    }
    assert.deepEqual(h.hotRows().map(n => n.props.testID), h.markets[type].map(a => `home-hot-item-${a.id}`));
    await h.press(`home-hot-item-${type}-0`);
    assert.deepEqual(h.navigation.at(-1), ['MainTabs', { screen: 'MarketTab', params: { screen: 'AssetDetail', params: { assetId: `${type}-0` } } }]);
    await h.press('home-hot-market');
    const market = h.node('home-hot-market');
    assert.equal(market.props.primary, true);
    assert.equal(market.findByType('Text').props.style.color, primaryGradient.foreground);
    assert.deepEqual(h.navigation.at(-1), ['MainTabs', { screen: 'MarketTab', params: { screen: 'Market', params: { assetType: type } } }]);
  }
  const keys = h.client.getQueryCache().findAll().filter(q => q.queryKey[0] === 'market').map(q => q.queryKey);
  assert.equal(keys.length, 3);
  for (const key of keys) { assert.ok(key.includes('preview')); assert.ok(key.includes('turnover')); assert.ok(key.includes(5)); assert.ok(!key.includes('season')); }
});

it('HOT omits unavailable, invalid and inactive turnover without refilling; zero is valid', async t => {
  const h = setup(); t.after(h.close);
  h.markets.domestic_stock = [asset(0, 'domestic_stock'), { ...asset(1, 'domestic_stock'), turnover: '0' },
    { ...asset(2, 'domestic_stock'), turnover: null }, { ...asset(3, 'domestic_stock'), turnover: '-1' },
    { ...asset(4, 'domestic_stock'), isActive: false }]; await flush();
  assert.equal(h.hotRows().length, 2);
  h.markets.us_stock = []; await h.press('home-hot-tab-us_stock');
  assert.equal(h.hotRows().length, 0);
  assert.ok(h.renderer.root.findAllByType('InlineEmptyState').some(n => /거래대금/.test(n.props.message)));
});

it('Crypto HOT renders the five rows verified by the backend writer-to-Assets contract', async t => {
  const h = setup(); t.after(h.close);
  h.markets.crypto = cryptoContract.assets.slice(0, 5);
  await flush(); await h.press('home-hot-tab-crypto');
  assert.deepEqual(h.hotRows().map(node => node.props.testID),
    ['ETHUSDT', 'ADAUSDT', 'XRPUSDT', 'SOLUSDT', 'BTCUSDT'].map(id => `home-hot-item-${id}`));
  assert.equal(h.hotRows().length, 5);
  assert.ok(!h.renderer.root.findAllByType('InlineEmptyState').some(node => /거래대금/.test(node.props.message)));
  const query = h.client.getQueryCache().findAll().find(q => q.queryKey.includes('crypto'));
  assert.equal(query.state.data.sortSnapshot, 'snapshot-crypto');
  assert.deepEqual(query.state.data.assets, cryptoContract.assets.slice(0, 5));
});

it('category changes never relabel the previous response and late account reads cannot mix holdings or ranking', async t => {
  const h = setup(); t.after(h.close); await flush();
  let release; const gate = new Promise(resolve => { release = resolve; });
  h.beforeRead = async r => { if ((r.section === 'hot' && r.assetType === 'crypto') || (r.section === 'positions' && r.limit === 100)) await gate; };
  await h.press('home-hot-tab-crypto'); assert.equal(h.hotRows().length, 0);
  await h.press('home-holdings-toggle'); assert.equal(h.rows().length, 1);
  h.positions.general = [position(0, 'general')]; await h.switch(account('general'));
  assert.equal(h.node('home-rank') === undefined, true); assert.equal(h.node('home-tier') === undefined, true);
  assert.equal(h.node('home-nickname').props.children, 'mycroft');
  assert.equal(h.node('home-holdings-toggle') === undefined, true);
  assert.equal(h.rows()[0].props.testID, 'home-position-item-general-a0');
  assert.equal(h.node('home-hot-tab-crypto').props.accessibilityState.selected, true);
  await act(async () => release()); await flush();
  assert.equal(h.rows().length, 1); assert.equal(h.rows()[0].props.testID, 'home-position-item-general-a0');
  assert.equal(h.hotRows().length, 5);
  await h.switch(account('season', 'settled'));
  assert.equal(h.node('home-rank').props.children, '#99999');
  assert.ok(h.requests.some(r => r.section === 'ranking' && r.seasonId === 'season-settled'));
});

it('Home and Wallet share the complete holdings cache but the preview shape remains separate', async t => {
  const h = setup(); t.after(h.close); await flush();
  act(() => h.client.setQueryData(QUERY_KEYS.tradingAccount.holdings('season'), { tradingAccountId: 'season', positions: h.positions.season }));
  await flush(); await h.press('home-holdings-toggle');
  assert.equal(h.rows().length, 7);
  assert.equal(h.requests.filter(r => r.section === 'positions').length, 1);
});
