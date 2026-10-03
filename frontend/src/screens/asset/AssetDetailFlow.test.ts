import { financial } from '../../theme/financialColors.ts';
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
  assert.match(h.node('asset-name-selector').props.accessibilityLabel, /현재 BNB/);
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
  assert.match(h.node('asset-name-selector').props.accessibilityLabel, /현재 BTC/);
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
  for (const [id, color] of [[TEST_IDS.assetDetail.openBuyOrder, financial.buyAction], [TEST_IDS.assetDetail.openSellOrder, financial.sellAction]]) {
    const action = h.node(id);
    assert.equal(action.props.style.flex, 1);
    assert.equal(action.props.style.minWidth, 0);
    assert.equal(action.props.style.backgroundColor, color);
    assert.ok(action.props.style.minHeight >= 48);
    assert.ok(action.props.label.endsWith('하기'));
  }
  assert.equal(h.node('asset-order-actions').props.style.flexDirection, 'row');
  assert.equal(h.node(TEST_IDS.assetDetail.screen).type, 'ScrollView');
  assert.equal(h.node(TEST_IDS.assetDetail.screen).props.contentContainerStyle.flexGrow, 1);
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

test('detail header keeps name, symbol, paired prices, change, chart and actions in order at 320px and fontScale 2', async (t) => {
  const h = inlineTradingHarness();
  h.assets.bnb.name = 'A deliberately long Bitcoin themed asset name that wraps';
  h.dimensions = { width: 320, height: 700, fontScale: 2 };
  await openDetail(h); t.after(h.close);
  const screen = text(h);
  const name = h.node('asset-detail-name');
  assert.equal(name.props.children, h.assets.bnb.name);
  assert.equal(name.props.numberOfLines, undefined);
  assert.equal(h.node('asset-change-pair'), undefined);
  await h.press('asset-name-selector');
  assert.deepEqual(h.navigation, [['MarketSearch', { returnToAsset: true }]]);
  assert.match(h.node('asset-detail-primary-price').props.children, /\$763\.79/);
  assert.equal(h.node('asset-detail-secondary-price').props.children, '1,054,259원');
  assert.match(h.node('asset-change-rate').props.children, /전일대비 \+0\.33%/);
  for (const [before, after] of [
    ['asset-name-selector', 'asset-detail-name'], ['asset-detail-name', 'asset-detail-primary-price'],
    ['asset-detail-primary-price', 'asset-change-rate'], ['asset-change-rate', 'CandlestickChart'],
    ['CandlestickChart', 'ChartTimeframeSelector'], ['ChartTimeframeSelector', 'asset-order-actions'],
  ]) assert.ok(screen.indexOf(before) < screen.indexOf(after), `${before} before ${after}`);
});

test('USD/KRW toggle swaps only the same display price pair', async (t) => {
  const h = inlineTradingHarness();
  h.ticker = { type: 'asset_ticker', assetId: 'bnb', priceLocal: '900', priceCurrency: 'USD',
    priceKrw: '1234567', priceKrwState: 'available', changeRate: '2.50' };
  await openDetail(h); t.after(h.close);
  const primary = () => h.node('asset-detail-primary-price').props.children;
  const secondary = () => h.node('asset-detail-secondary-price').props.children;
  assert.equal(primary(), '$900'); assert.equal(secondary(), '1,234,567원');
  await h.press('asset-currency-krw');
  assert.equal(primary(), '1,234,567원'); assert.equal(secondary(), '$900');
  assert.equal(h.node('asset-change-rate').props.children, '전일대비 +2.5%');
  assert.deepEqual(h.navigation, []);
  await h.press('asset-currency-usd'); assert.equal(primary(), '$900');
});

test('unavailable ticker KRW never borrows REST conversion', async (t) => {
  const h = inlineTradingHarness();
  h.ticker = { type: 'asset_ticker', assetId: 'bnb', priceLocal: '900', priceCurrency: 'USD',
    priceKrw: null, priceKrwState: 'unavailable', changeRate: '2.50' };
  await openDetail(h); t.after(h.close);
  assert.equal(h.node('asset-detail-primary-price').props.children, '$900');
  assert.equal(h.node('asset-detail-secondary-price').props.children, '원 환산 불가');
  assert.equal(h.node('asset-currency-krw').props.accessibilityState.disabled, true);
  await h.press('asset-currency-krw');
  assert.equal(h.node('asset-detail-primary-price').props.children, '$900');
  assert.doesNotMatch(text(h), /1,054,259원/);
});

test('domestic KRW stock has no invented USD conversion', async (t) => {
  const h = inlineTradingHarness(); h.assetId = 'samsung';
  await openDetail(h); t.after(h.close);
  assert.equal(h.node('asset-detail-name').props.children, 'Samsung Electronics');
  assert.match(h.node('asset-name-selector').props.accessibilityLabel, /현재 Samsung Electronics/);
  assert.match(h.node('asset-detail-primary-price').props.children, /70,000/);
  assert.equal(h.node('asset-currency-usd'), undefined);
  assert.equal(h.node('asset-currency-krw'), undefined);
});

test('changing assets restores USD as the default display choice', async (t) => {
  const h = inlineTradingHarness(); await openDetail(h); t.after(h.close);
  await h.press('asset-currency-krw');
  assert.equal(h.node('asset-currency-krw').props.accessibilityState.selected, true);
  h.assetId = 'btc'; await h.update();
  assert.equal(h.node('asset-currency-usd').props.accessibilityState.selected, true);
  assert.match(h.node('asset-detail-primary-price').props.children, /^\$/);
});

test('settlement badge shows USD for Binance and stays separate from the display toggle', async (t) => {
  const h = inlineTradingHarness();
  await openDetail(h); t.after(h.close);
  assert.equal(h.node('asset-settlement-currency').children.join(''), 'USD');
  assert.doesNotMatch(JSON.stringify(h.node('asset-settlement-currency').children), /USDT/);
  assert.ok(text(h).indexOf('asset-detail-name') < text(h).indexOf('asset-settlement-currency'));
  await h.press('asset-currency-krw');
  assert.equal(h.node('asset-settlement-currency').children.join(''), 'USD');
});

test('domestic asset shows KRW and a long name wraps beside the badge', async (t) => {
  const h = inlineTradingHarness();
  h.assetId = 'samsung';
  h.assets.samsung.name = '아주 긴 이름을 가진 국내 상장 종목 삼성전자 보통주';
  await openDetail(h); t.after(h.close);
  assert.equal(h.node('asset-settlement-currency').children.join(''), 'KRW');
  assert.equal(h.node('asset-detail-name').children.join(''), h.assets.samsung.name);
  const selector = h.node('asset-name-selector');
  assert.equal(selector.props.style.maxWidth, '100%');
  assert.equal(selector.props.style.flexDirection, 'row');
  assert.equal(h.node('asset-detail-name').props.style.flexShrink, 1);
  assert.equal(h.node('asset-detail-name').props.numberOfLines, undefined);
});
