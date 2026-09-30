import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { ASSET_CHART_TIMEFRAMES } from '../../features/asset/chartTimeframes.ts';

const { inlineTradingHarness, act } = createRequire(import.meta.url)(
  '../../../test/inlineTradingHarness.cjs',
);
const text = (h: any) => JSON.stringify(h.renderer.toJSON());
const chart = (h: any) => h.renderer.root.findByType('CandlestickChart').props;

const openDetail = async (h: any) => {
  h.Screen = h.Detail;
  await h.mount();
};

test('market asset opens chart-first detail with price, change and no trading sections', async (t) => {
  const h = inlineTradingHarness();
  await openDetail(h);
  t.after(h.close);
  const screen = text(h);
  assert.match(screen, /BNB \/ USD/);
  assert.match(screen, /763\.79/);
  assert.match(screen, /전일대비 \+0\.33%/);
  assert.ok(h.node(TEST_IDS.assetDetail.screen));
  assert.equal(h.node('inline-order-panel'), undefined);
  assert.equal(h.node('asset-trading-columns'), undefined);
  assert.equal(h.node('account-holdings'), undefined);
  assert.ok(chart(h).candles.length > 0);
  assert.ok(screen.indexOf('전일대비') < screen.indexOf('CandlestickChart'));
  assert.ok(screen.indexOf('CandlestickChart') < screen.indexOf('ChartTimeframeSelector'));
  assert.ok(screen.indexOf('ChartTimeframeSelector') < screen.indexOf('asset-order-actions'));
});

test('detail timeframe uses the existing query policy and isolates live candles', async (t) => {
  const h = inlineTradingHarness();
  await openDetail(h);
  t.after(h.close);
  const timeframe = ASSET_CHART_TIMEFRAMES.find((value) => value.interval === '1d')!;
  h.candlesByKey = { 'bnb:1d': [{ time: '2026-09-20T00:00:00Z', open: '800', high: '900', low: '700', close: '888', volume: '10' }] };
  await act(async () => h.renderer.root.findByType('ChartTimeframeSelector').props.onSelect(timeframe));
  assert.deepEqual(h.queries.findLast((value: any) => value.queryKey[1] === 'candles').queryKey,
    ['asset', 'candles', 'bnb', timeframe.range, timeframe.interval, timeframe.limit]);
  assert.equal(h.candleOptions.interval, '1d');
  assert.equal(chart(h).viewportResetKey, 'bnb:1d');
  assert.equal(chart(h).candles[0].close, '888');
  h.candle = { assetId: 'bnb', interval: '5m', candle: { close: '999' } };
  await h.update();
  assert.equal(chart(h).candles[0].close, '888');
});

test('pair switch does not show a previous ticker or live candle', async (t) => {
  const h = inlineTradingHarness();
  h.ticker = { assetId: 'bnb', priceLocal: '900', changeRate: '3.00' };
  await openDetail(h);
  t.after(h.close);
  assert.match(text(h), /900/);
  h.assetId = 'btc';
  h.candlesByKey = { 'btc:5m': [{ time: '2026-09-20T00:00:00Z', open: '10', high: '20', low: '5', close: '12', volume: '2' }] };
  h.candle = { assetId: 'bnb', interval: '5m', candle: { close: '999' } };
  await h.update();
  assert.match(text(h), /BTC \/ USD/);
  assert.match(text(h), /98,765/);
  assert.doesNotMatch(text(h), /900/);
  assert.equal(chart(h).viewportResetKey, 'btc:5m');
  assert.equal(chart(h).candles[0].close, '12');
});

for (const [side, id] of [
  ['buy', TEST_IDS.assetDetail.openBuyOrder],
  ['sell', TEST_IDS.assetDetail.openSellOrder],
] as const) {
  test(`${side} CTA passes the selected account and opens the existing trading screen`, async (t) => {
    const h = inlineTradingHarness();
    await openDetail(h);
    t.after(h.close);
    await h.press(id);
    assert.deepEqual(h.navigation, [['Order', { assetId: 'bnb', accountId: 'general', side }]]);
    h.Screen = h.OrderScreen;
    h.routeAccountId = 'general';
    h.routeSide = side;
    await h.update();
    assert.ok(h.node(TEST_IDS.order.screen));
    assert.ok(h.node('asset-trading-columns'));
    assert.ok(h.node('account-holdings'));
    assert.equal(h.node(side === 'buy' ? TEST_IDS.assetDetail.buyButton : TEST_IDS.assetDetail.sellButton)
      .props.accessibilityState.selected, true);
  });
}

test('no selected account disables both order actions without a fallback route', async (t) => {
  const h = inlineTradingHarness();
  h.accountId = null;
  h.accounts = [];
  await openDetail(h);
  t.after(h.close);
  for (const id of [TEST_IDS.assetDetail.openBuyOrder, TEST_IDS.assetDetail.openSellOrder]) {
    assert.equal(h.node(id).props.state, 'disabled');
    await h.press(id);
  }
  assert.deepEqual(h.navigation, []);
  assert.match(text(h), /계정이 없습니다/);
});

test('an Order route keeps its account when selection changes', async (t) => {
  const h = inlineTradingHarness();
  await h.mount();
  t.after(h.close);
  h.accountId = 'season';
  await h.update();
  assert.equal(h.routeAccountId, 'general');
  assert.equal(h.node(TEST_IDS.order.quantityInput), undefined);
  assert.equal(h.requests.length, 0);
  assert.ok(h.node('account-holdings'));
});

test('320px and large text keep both order actions flexible below the chart', async (t) => {
  const h = inlineTradingHarness();
  h.dimensions = { width: 320, height: 700, fontScale: 2 };
  await openDetail(h);
  t.after(h.close);
  for (const [id, color] of [[TEST_IDS.assetDetail.openBuyOrder, '#16a34a'], [TEST_IDS.assetDetail.openSellOrder, '#dc2626']]) {
    const action = h.node(id);
    assert.equal(action.props.style.flex, 1);
    assert.equal(action.props.style.minWidth, 0);
    assert.equal(action.props.style.backgroundColor, color);
    assert.ok(action.props.style.minHeight >= 48);
    assert.ok(action.props.label.endsWith('하기'));
  }
  assert.equal(h.node('asset-order-actions').props.style.flexDirection, 'row');
  assert.ok(h.node(TEST_IDS.assetDetail.screen));
});

test('detail candle diagnostics stay admin only', async (t) => {
  const user = inlineTradingHarness();
  user.candleStale = true;
  await openDetail(user);
  t.after(user.close);
  assert.equal(user.node('admin-diagnostic-panel'), undefined);
  const admin = inlineTradingHarness();
  admin.role = 'admin';
  admin.candleStale = true;
  await openDetail(admin);
  t.after(admin.close);
  await admin.flush();
  assert.ok(admin.node('admin-diagnostic-panel'));
});
