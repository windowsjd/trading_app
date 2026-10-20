import { financial } from '../../theme/financialColors.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { TEST_IDS } from '../../constants/testIds.ts';
import { ASSET_CHART_TIMEFRAMES } from '../../features/asset/chartTimeframes.ts';

const { inlineTradingHarness, act, deferred } = createRequire(import.meta.url)(
  '../../../test/inlineTradingHarness.cjs',
);
const text = (h: any) => JSON.stringify(h.renderer.toJSON());
const chart = (h: any) => h.renderer.root.findByType('CandlestickChart').props;

const openDetail = async (h: any) => {
  h.Screen = h.Detail;
  await h.mount();
};

test('market asset opens chart-first detail with price and change; holdings live under the order screen only', async (t) => {
  const h = inlineTradingHarness();
  await openDetail(h);
  t.after(h.close);
  const screen = text(h);
  assert.match(h.node('asset-name-selector').props.accessibilityLabel, /현재 BNB/);
  assert.match(screen, /763\.79/);
  assert.match(screen, /전일대비 \+0\.33%/);
  assert.ok(h.node(TEST_IDS.assetDetail.screen));
  assert.equal(h.node('inline-order-panel') === undefined, true);
  assert.equal(h.node('asset-trading-columns') === undefined, true);
  // 2026-10-12: no duplicate holdings on the detail (they are under the order form).
  assert.equal(h.node('account-holdings') === undefined, true);
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
  assert.equal(h.node(TEST_IDS.order.quantityInput) === undefined, true);
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

test('the order bar clears the system navigation area itself (tab bar hidden here)', async (t) => {
  const h = inlineTradingHarness();
  await openDetail(h);
  t.after(h.close);
  // The harness provider reports a 34dp bottom inset (gesture bar / home indicator).
  assert.equal(h.node('asset-order-actions').props.style.paddingBottom, 8 + 34);
  const screen = h.renderer.root.findAll((n: any) => n.type === 'SafeAreaView')[0];
  assert.deepEqual(screen.props.edges, ['left', 'right'], 'the bottom inset is applied once, by the order bar');
});

test('the order bar follows the inset it is given, never a fixed gap (3-button 48dp, gesture 24dp, none)', async (t) => {
  for (const bottom of [48, 24, 0]) {
    const h = inlineTradingHarness();
    h.safeAreaInsets = { top: 24, bottom, left: 0, right: 0 };
    await openDetail(h);
    t.after(h.close);
    assert.equal(h.node('asset-order-actions').props.style.paddingBottom, 8 + bottom, `${bottom}dp inset`);
  }
});

test('detail candle diagnostics stay admin only', async (t) => {
  const user = inlineTradingHarness();
  user.candleStale = true;
  await openDetail(user);
  t.after(user.close);
  assert.equal(user.node('admin-diagnostic-panel') === undefined, true);
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
  assert.equal(h.node('asset-change-pair') === undefined, true);
  await h.press('asset-name-selector');
  assert.equal(h.node('order-asset-sheet') !== undefined, true, 'the asset search opens as a sheet');
  assert.deepEqual(h.navigation, [], 'no full-screen search route');
  assert.match(h.node('asset-detail-primary-price').props.children, /\$763\.79/);
  assert.equal(h.node('asset-detail-secondary-price').props.children, '1,054,259원');
  assert.match(h.node('asset-change-rate').props.children, /전일대비 \+0\.33%/);
  for (const [before, after] of [
    ['asset-name-selector', 'asset-detail-name'], ['asset-detail-name', 'asset-detail-primary-price'],
    ['asset-detail-primary-price', 'asset-change-rate'], ['asset-change-rate', 'CandlestickChart'],
    ['CandlestickChart', 'ChartTimeframeSelector'], ['ChartTimeframeSelector', 'asset-order-actions'],
  ]) assert.ok(screen.indexOf(before) < screen.indexOf(after), `${before} before ${after}`);
});

const listed = (h: any, id: string) => h.node(TEST_IDS.market.item(id)) !== undefined;
const marked = (h: any, id: string) => h.node(`market-selected-${id}`) !== undefined;
const sheetTitle = (h: any) => h.renderer.root.findAll((n: any) => n.type === 'Text' && n.props.accessibilityRole === 'header')
  .map((n: any) => [n.props.children].flat().join('')).find((title: string) => title.endsWith('종목 선택'));

test('the name ▼ searches only this asset\'s market in a sheet, marks the asset, and swaps the detail in place', async (t) => {
  const h = inlineTradingHarness();
  await openDetail(h); t.after(h.close);
  await h.press('asset-name-selector');
  await h.flush();
  assert.equal(h.node('order-asset-sheet') !== undefined, true);
  assert.equal(h.node(TEST_IDS.assetDetail.screen) !== undefined, true, 'the detail stays behind the sheet');
  // Crypto spot (BNB) only: no market choice, every read scoped to crypto, live rows.
  for (const scope of ['all', 'domestic_stock', 'us_stock', 'crypto']) {
    assert.equal(h.node(`order-asset-scope-${scope}`) === undefined, true, scope);
  }
  assert.equal(sheetTitle(h), '암호화폐 종목 선택');
  assert.equal(h.marketRequests.length, 1);
  assert.deepEqual([h.marketRequests[0].assetType, h.marketRequests[0].withPrice], ['crypto', true]);
  assert.deepEqual([listed(h, 'bnb'), listed(h, 'btc'), listed(h, 'samsung')], [true, true, false]);
  // The asset on screen is marked; the others are not.
  assert.deepEqual([marked(h, 'bnb'), marked(h, 'btc')], [true, false]);
  assert.equal(h.node(TEST_IDS.market.item('bnb')).props.accessibilityState.selected, true);
  // A search stays in the market: another market's asset is never offered.
  await h.input('order-asset-search-input', 'SAMSUNG'); await h.flush();
  assert.equal(h.marketRequests.at(-1).assetType, 'crypto');
  assert.equal(listed(h, 'samsung'), false);
  assert.equal(h.node('order-asset-sheet-empty') !== undefined, true);
  await h.input('order-asset-search-input', ''); await h.flush();
  // Picking the current asset just closes the sheet.
  await h.press(TEST_IDS.market.item('bnb'));
  assert.equal(h.node('order-asset-sheet') === undefined, true);
  assert.deepEqual(h.navigation, []);
  // Another asset rebuilds this detail for it, without a new screen …
  await h.press('asset-name-selector');
  await h.flush();
  await h.press(TEST_IDS.market.item('btc'));
  assert.deepEqual(h.navigation, [['setParams', { assetId: 'btc' }]]);
  await h.update();
  assert.equal(h.node('order-asset-sheet') === undefined, true);
  assert.match(h.node('asset-name-selector').props.accessibilityLabel, /현재 BTC/);
  assert.equal(h.node('asset-detail-name').props.children, 'BTC');
  // … whose orders are for it (same account), and whose sheet marks it.
  await h.press(TEST_IDS.assetDetail.openBuyOrder);
  assert.deepEqual(h.navigation.at(-1), ['Order', { assetId: 'btc', accountId: 'general', side: 'buy' }]);
  await h.press('asset-name-selector');
  await h.flush();
  assert.deepEqual([marked(h, 'btc'), marked(h, 'bnb')], [true, false]);
});

test('the detail\'s sheet closes by its button, the backdrop or Android back and leaves the detail as it was', async (t) => {
  const h = inlineTradingHarness();
  await openDetail(h); t.after(h.close);
  const closes = [
    () => h.press('order-asset-sheet-close'),
    () => h.press('order-asset-sheet-backdrop'),
    () => act(async () => h.node('order-asset-sheet-modal').props.onRequestClose()),
  ];
  for (const close of closes) {
    await h.press('asset-name-selector'); await h.flush();
    assert.equal(h.node('order-asset-sheet') !== undefined, true);
    await close(); await h.flush();
    assert.equal(h.node('order-asset-sheet') === undefined, true);
    assert.match(h.node('asset-name-selector').props.accessibilityLabel, /현재 BNB/);
  }
  assert.deepEqual(h.navigation, []);
});

test('a domestic or US detail searches only its own market, Korean names included', async (t) => {
  for (const [assetType, title, korean] of [['domestic_stock', '국내주식 종목 선택', '삼성전자'], ['us_stock', '미국주식 종목 선택', '애플']]) {
    const h = inlineTradingHarness();
    h.assetId = 'samsung';
    if (assetType === 'us_stock') {
      Object.assign(h.assets.samsung, { name: 'Apple Inc.', symbol: 'AAPL', market: 'NAS', assetType: 'us_stock',
        priceCurrency: 'USD', settlementCurrency: 'USD' });
    }
    await openDetail(h); t.after(h.close);
    await h.press('asset-name-selector');
    await h.flush();
    assert.equal(sheetTitle(h), title);
    assert.equal(h.node('order-asset-scope-all') === undefined, true, assetType);
    assert.deepEqual(h.marketRequests.map((request: any) => request.assetType), [assetType]);
    assert.deepEqual([listed(h, 'samsung'), listed(h, 'bnb'), listed(h, 'btc')], [true, false, false], assetType);
    assert.equal(marked(h, 'samsung'), true);
    await h.input('order-asset-search-input', korean); await h.flush();
    assert.equal(listed(h, 'samsung'), true, `${assetType}: ${korean}`);
    assert.deepEqual([...new Set(h.marketRequests.map((request: any) => request.assetType))], [assetType]);
    assert.deepEqual([listed(h, 'bnb'), listed(h, 'btc')], [false, false]);
  }
});

test('the detail\'s sheet keeps the shared loading, error and empty states, with no other market to suggest', async (t) => {
  const emptyState = (h: any) => h.renderer.root.findAll((n: any) => n.type === 'InlineEmptyState')[0]?.props;
  const loading = inlineTradingHarness();
  loading.marketGates = { '': deferred() };
  await openDetail(loading); t.after(loading.close);
  await loading.press('asset-name-selector'); await loading.flush();
  assert.equal(loading.node('order-asset-sheet-loading') !== undefined, true);
  assert.match(text(loading), /종목 목록을 불러오는 중입니다/);
  await act(async () => loading.marketGates[''].resolve()); await loading.flush();
  assert.equal(listed(loading, 'bnb'), true);

  const failed = inlineTradingHarness();
  failed.marketFailure = Object.assign(new Error('down'), { response: { status: 503 } });
  await openDetail(failed); t.after(failed.close);
  await failed.press('asset-name-selector'); await failed.flush();
  assert.equal(failed.node('order-asset-sheet-error') !== undefined, true);
  assert.match(text(failed), /종목 목록을 불러오지 못했습니다/);
  failed.marketFailure = null;
  await act(async () => failed.renderer.root.findAll((n: any) => n.type === 'CTAButton' && n.props.label === '다시 시도')[0].props.onPress());
  await failed.flush();
  assert.equal(listed(failed, 'bnb'), true, 'a retry lists the market');
  assert.deepEqual([...new Set(failed.marketRequests.map((request: any) => request.assetType))], ['crypto']);

  const empty = inlineTradingHarness();
  empty.marketEmpty = true;
  await openDetail(empty); t.after(empty.close);
  await empty.press('asset-name-selector'); await empty.flush();
  assert.deepEqual([emptyState(empty)?.title, emptyState(empty)?.message], ['표시할 종목이 없습니다.', '잠시 후 다시 확인해주세요.']);
  await empty.input('order-asset-search-input', 'ZZZ'); await empty.flush();
  assert.deepEqual([emptyState(empty)?.title, emptyState(empty)?.message], ['검색 결과가 없습니다.', '다른 종목명 또는 심볼로 다시 검색해주세요.']);
});

test('until the asset\'s market is known (detail loading or failed), the name ▼ is unavailable and opens nothing', async (t) => {
  for (const state of ['pending', 'failed'] as const) {
    const h = inlineTradingHarness();
    if (state === 'pending') h.detailPending = true;
    else h.detailFailure = Object.assign(new Error('down'), { response: { status: 503 } });
    await openDetail(h); t.after(h.close);
    const selector = h.node('asset-name-selector');
    assert.deepEqual([selector.props.onPress === undefined, selector.props.disabled, selector.props.accessibilityState?.disabled],
      [true, true, true], state);
    assert.equal(h.renderer.root.findAll((n: any) => n.type?.name === 'DisclosureTriangle').length, 0, `${state}: no ▼`);
    await h.flush();
    assert.equal(h.node('order-asset-sheet') === undefined, true);
    assert.deepEqual(h.marketRequests, []);
    // Once it answers, the same selector opens that market's sheet.
    h.detailPending = false; h.detailFailure = null;
    await h.update();
    assert.equal(h.node('asset-name-selector').props.disabled, false, state);
    assert.equal(h.renderer.root.findAll((n: any) => n.type?.name === 'DisclosureTriangle').length, 1, `${state}: ▼ back`);
    await h.press('asset-name-selector');
    await h.flush();
    assert.equal(h.node('order-asset-sheet') !== undefined, true);
    assert.deepEqual(h.marketRequests.map((request: any) => request.assetType), ['crypto']);
  }
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
  assert.equal(h.node('asset-detail-name').props.children, '삼성전자');
  assert.equal(h.node('asset-detail-english-name').props.children, '(005930)', 'the code under the KRX listing name');
  assert.match(h.node('asset-name-selector').props.accessibilityLabel, /현재 삼성전자/);
  assert.match(h.node('asset-detail-primary-price').props.children, /70,000/);
  assert.equal(h.node('asset-currency-usd') === undefined, true);
  assert.equal(h.node('asset-currency-krw') === undefined, true);
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

test('a US listing reads by its Korean name with `(English) · SYMBOL` under it at 320px and fontScale 2', async (t) => {
  const h = inlineTradingHarness();
  h.assetId = 'samsung';
  Object.assign(h.assets.samsung, { name: 'Apple Inc.', symbol: 'AAPL', market: 'NAS', assetType: 'us_stock',
    priceCurrency: 'USD', settlementCurrency: 'USD' });
  h.dimensions = { width: 320, height: 700, fontScale: 2 };
  await openDetail(h); t.after(h.close);
  assert.equal(h.node('asset-detail-name').children.join(''), '애플');
  assert.equal(h.node('asset-detail-english-name').children.join(''), '(Apple Inc.) · AAPL');
  assert.equal(h.node('asset-detail-english-name').props.numberOfLines, undefined, 'a long English name wraps, never cut');
  const screen = text(h);
  assert.ok(screen.indexOf('asset-detail-name') < screen.indexOf('asset-detail-english-name'));
  assert.ok(screen.indexOf('asset-detail-english-name') < screen.indexOf('asset-detail-primary-price'));
});

test('domestic asset shows KRW and a long name wraps beside the badge', async (t) => {
  const h = inlineTradingHarness();
  h.assetId = 'samsung';
  // A code outside the listing-name map shows the asset's own (long) name.
  h.assets.samsung.symbol = '900010';
  h.assets.samsung.name = '아주 긴 이름을 가진 국내 상장 종목 삼성전자 보통주';
  await openDetail(h); t.after(h.close);
  assert.equal(h.node('asset-settlement-currency').children.join(''), 'KRW');
  assert.equal(h.node('asset-detail-name').children.join(''), h.assets.samsung.name);
  assert.equal(h.node('asset-detail-english-name').props.children, '(900010)', 'its code below, never an English line');
  const selector = h.node('asset-name-selector');
  assert.equal(selector.props.style.maxWidth, '100%');
  assert.equal(selector.props.style.flexDirection, 'row');
  assert.equal(h.node('asset-detail-name').props.style.flexShrink, 1);
  assert.equal(h.node('asset-detail-name').props.numberOfLines, undefined);
});
