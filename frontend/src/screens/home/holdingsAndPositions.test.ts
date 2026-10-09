import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
const require = createRequire(import.meta.url);
const { setup, account, flush, act } = require('../../../test/homeDiscoveryHarness.cjs');
const { futuresFixture } = require('../../../test/futuresFixtures.cjs');

for (const mode of ['general', 'season', 'beginner']) for (const [spot, future] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
  it(`${mode}: Spot ${spot} / Futures ${future} remain separate and navigate to their domain`, async t => {
    const h = setup(mode, spot); t.after(h.close); await flush();
    h.futures = { [mode]: futuresFixture(mode, { position: !!future, marginMode: 'cross', direction: 'short' }).positions };
    await act(async () => h.client.refetchQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.positions(mode) })); await flush();
    assert.equal(h.rows().length, spot);
    const rows = h.renderer.root.findAll(node => node.type === 'Pressable' && node.props.testID?.startsWith('home-futures-'));
    assert.equal(rows.length, future);
    const titles = h.renderer.root.findAllByType('InlineEmptyState').map(node => node.props.title ?? '').join(' ');
    assert.equal(titles.includes('보유종목 및 포지션이 없습니다.'), spot === 0 && future === 0);
    if (spot) {
      assert.equal(h.positions[mode][0].quantity, '1');
      await h.press(h.rows()[0].props.testID);
      assert.equal(h.navigation.at(-1)[1].params.screen, 'AssetDetail');
    }
    if (future) {
      await h.press(rows[0].props.testID);
      assert.deepEqual(h.navigation.at(-1), ['MainTabs', { screen: 'MarketTab', params: {
        screen: 'Futures', params: { accountId: mode, instrumentId: 'btc' },
      } }]);
    }
  });
}

for (const section of ['positions', 'futures']) it(`a failed ${section} read never makes both domains look empty`, async t => {
  const h = setup('general', 1, 'home', { beforeRead: async request => {
    if (request.section === section) throw new Error('offline');
  } }); t.after(h.close); await flush();
  if (section === 'positions') {
    h.futures = { general: futuresFixture('general', { position: true }).positions };
    await act(async () => h.client.refetchQueries({ queryKey: QUERY_KEYS.tradingAccount.futures.positions('general') })); await flush();
    assert.equal(h.node('home-futures-general:position') !== undefined, true);
  } else assert.equal(h.rows().length, 1);
  assert.equal(h.renderer.root.findAllByType('ErrorState').length > 0, true);
  assert.equal(h.renderer.root.findAllByType('InlineEmptyState').some(n => n.props.title === '보유종목 및 포지션이 없습니다.'), false);
});

it('a late Futures response cannot paint an outgoing account after General→Season→Beginner', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const h = setup('general', 1, 'home', { beforeRead: async request => {
    if (request.section === 'futures' && request.account === 'general') await gate;
  } }); t.after(h.close); await flush();
  h.futures = { general: futuresFixture('general', { position: true }).positions };
  await h.switch(account('season'));
  await h.switch(account('beginner'));
  await act(async () => release()); await flush();
  assert.equal(h.node('home-futures-general:position') === undefined, true);
  assert.equal(h.rows()[0]?.props.testID?.includes('general') ?? false, false);
  assert.equal(h.client.getQueryData(QUERY_KEYS.tradingAccount.futures.positions('beginner')).positions.length, 0);
});

it('opening a Futures position for the same BTC leaves the Spot count, quantity, canonical value and PnL intact', async t => {
  const h = setup('general', 1); t.after(h.close); await flush();
  h.positions.general[0] = { ...h.positions.general[0], assetId: 'asset-btc', name: 'Bitcoin', symbol: 'BTCUSDT', market: 'BINANCE',
    assetType: 'crypto', quantity: '0.00000001', valuation: { state: 'available', priceCurrency: 'USD', positionValue: '145.28',
      unrealizedPnl: '0.36', returnRate: '0.25' } };
  const original = JSON.stringify(h.positions.general);
  h.futures = { general: futuresFixture('general', { position: true, direction: 'long' }).positions };
  await act(async () => h.client.refetchQueries({ predicate: q => q.queryKey.includes('general') })); await flush();
  assert.equal(h.rows().length, 1);
  assert.equal(h.node('home-position-item-asset-btc-quantity').props.children, '보유수량 0.00000001 BTC');
  assert.equal(h.node('home-position-item-asset-btc-value').props.children, '$145.28');
  assert.equal(h.node('home-position-item-asset-btc-return').props.children, '+$0.36 (+0.25%)');
  assert.equal(h.node('home-futures-general:position') !== undefined, true);
  assert.equal(JSON.stringify(h.positions.general), original);
});
