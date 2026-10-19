import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const { futuresHarness, futuresCandlesFixture, deferred } = createRequire(import.meta.url)(
  '../../../test/futuresHarness.cjs',
);
const { act } = createRequire(import.meta.url)('react-test-renderer');

const chart = (h: any) =>
  h.renderer.root.findAll((node: any) => node.type === 'CandlestickChart')[0];
const words = (node: any): string =>
  (node?.children ?? []).map((child: any) => (typeof child === 'string' ? child : words(child))).join('');
/** The full-screen chart route, as the futures screen's chart button opens it. */
const chartScreen = (options: Record<string, unknown> = {}) => futuresHarness({ ...options, screen: 'chart' });

test("the futures screen's chart button opens the contract's full-screen chart like the spot order screen", async (t) => {
  const h = futuresHarness({ position: true });
  await h.start();
  t.after(h.close);
  const button = h.node('futures-open-chart');
  assert.equal(button.props.accessibilityLabel, '전체화면 차트 열기');
  // No inline chart and no candle read on the order screen itself.
  assert.equal(h.node('futures-candle-chart') === undefined, true);
  assert.equal(h.candleReads === undefined, true);
  await h.amount('51');
  await h.press('futures-open-chart');
  assert.deepEqual(h.navigation, [['FuturesChart', { accountId: 'A', instrumentId: 'btc', symbol: 'BTCUSDT', displayPriceDecimals: 2 }]]);
  // The form is untouched underneath (the route opens over this screen).
  assert.equal(h.node('futures-amount').props.value, '51');
  assert.equal(h.candleReads === undefined, true);
});

test('draws the contract chart from the account-free market-data route with the fresh Futures Last line', async (t) => {
  const h = chartScreen();
  await h.start();
  t.after(h.close);
  assert.equal(h.node('futures-chart-screen') === undefined, false);
  assert.equal(words(h.node('futures-chart-symbol')), 'BTCUSDT');
  assert.equal(h.node('futures-chart-symbol').parent.children.some((n: any) => words(n) === '무기한'), true, 'the 무기한 badge beside it');
  assert.equal(words(h.node('futures-chart-last')), 'Last $102');
  const node = chart(h);
  assert.equal(node === undefined, false);
  assert.equal(node.props.candles.length, 4);
  assert.equal(node.props.viewportResetKey, 'btc:4h');
  assert.equal(node.props.currencyCode, 'USD');
  assert.equal(node.props.displayPriceDecimals, 2);
  // Fresh Futures Last is the current-price line; the chart never uses Mark (101).
  assert.equal(node.props.currentPrice, '102');
  assert.deepEqual(h.candleReads, ['btc']);
  const keys = h.client
    .getQueryCache()
    .findAll({ queryKey: ['futuresMarket'] })
    .map((query: any) => JSON.stringify(query.queryKey));
  assert.deepEqual(keys, [JSON.stringify(['futuresMarket', 'candles', 'btc', '96d', '4h', 600])]);
  // The Last comes from the route account's contract list only.
  assert.equal(h.reads.some((path: string) => path.startsWith('/trading-accounts/A/') && path.includes('instruments')), true);
  // Contract basis, the fixed 4h window and the separate Mark role are stated.
  assert.match(h.text(), /4시간봉/);
  assert.match(h.text(), /선물 계약 거래가격\(Last\) 기준 · 최근 96일/);
  assert.match(h.text(), /Mark Price는 차트와 별개로 평가·청산에만 쓰입니다/);
  assert.match(h.text(), /마지막 봉은 진행 중인 잠정 봉입니다/);
  assert.equal(h.node('chart-loading') === undefined, true);
});

test('fills the rest of the screen (never below the old 280 strip): the measured box height is the chart height', async (t) => {
  const h = chartScreen();
  await h.start();
  t.after(h.close);
  // Before the first layout the chart is drawn at the floor, over its box (it never sizes the box).
  assert.equal(chart(h).props.height, 280);
  const fill = chart(h).parent;
  assert.deepEqual([fill.props.style.position, fill.props.style.top, fill.props.style.bottom, fill.props.style.left, fill.props.style.right],
    ['absolute', 0, 0, 0, 0]);
  const box = fill.parent;
  assert.deepEqual([box.props.style.flex, box.props.style.minHeight], [1, 280]);
  const column = h.node('futures-candle-chart');
  assert.deepEqual([column.props.style.flex, column.props.style.minHeight], [1, 0]);
  // The screen scrolls only when that floor and the text above and below do not fit.
  const scroll = h.renderer.root.findAll((n: any) => n.type === 'ScrollView')[0];
  assert.deepEqual([scroll.props.style.flex, scroll.props.contentContainerStyle.flexGrow], [1, 1]);
  await act(async () => box.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 612.6 } } }));
  assert.equal(chart(h).props.height, 612);
});

test('shows the whale while the candles load, then the chart', async (t) => {
  const h = chartScreen();
  h.readGate = deferred();
  await h.start();
  t.after(h.close);
  const loader = h.node('chart-loading');
  assert.equal(loader === undefined, false);
  assert.equal(loader.findAll((n: any) => n.props?.accessibilityRole === 'progressbar').length > 0, true, 'the WhaleLoader');
  assert.match(h.text(), /차트를 불러오는 중입니다/);
  assert.equal(chart(h) === undefined, true);
  // The header and basis stay while only the chart box waits.
  assert.equal(h.node('futures-chart-back') === undefined, false);
  assert.match(h.text(), /선물 계약 거래가격\(Last\) 기준/);
  h.readGate.resolve();
  await h.flush();
  assert.equal(h.node('chart-loading') === undefined, true);
  assert.equal(chart(h).props.candles.length, 4);
});

test('a stale Futures Last draws no price line and says so; Mark is never used instead', async (t) => {
  const h = chartScreen({ expiredReference: true });
  await h.start();
  t.after(h.close);
  assert.equal(chart(h).props.currentPrice, null);
  assert.equal(words(h.node('futures-chart-last')), 'Last 시세 확인 불가');
});

test('a response for another contract is never drawn under the selected one', async (t) => {
  const h = chartScreen();
  h.futuresCandles = (id: string) => ({
    ...futuresCandlesFixture(id),
    instrument: { ...futuresCandlesFixture(id).instrument, id: 'other' },
  });
  await h.start();
  t.after(h.close);
  assert.equal(chart(h) === undefined, true);
  assert.equal(h.node('chart-loading') === undefined, true);
  assert.equal(
    h.renderer.root.findAll((n: any) => n.props?.message === '선물 차트를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.').length > 0,
    true,
  );
});

test('an empty contract shows its empty state; a failure shows the error with a retry that loads again', async (t) => {
  const empty = chartScreen();
  empty.futuresCandles = (id: string) => ({ ...futuresCandlesFixture(id), state: 'empty', candles: [] });
  await empty.start();
  t.after(empty.close);
  assert.equal(chart(empty) === undefined, true);
  assert.equal(empty.node('chart-loading') === undefined, true);
  assert.match(empty.text(), /아직 수집된 선물 차트 데이터가 없습니다/);

  const failed = chartScreen();
  failed.candleFailure = Object.assign(new Error('network'), { code: 'ERR_NETWORK' });
  await failed.start();
  t.after(failed.close);
  assert.equal(chart(failed) === undefined, true);
  assert.equal(failed.node('chart-loading') === undefined, true, 'a failure is not a loader');
  assert.match(failed.text(), /선물 차트를 불러오지 못했습니다/);
  failed.candleFailure = null;
  failed.readGate = deferred();
  // The read is held open (readGate) while the screen settles.
  await failed.press('futures-chart-retry');
  assert.equal(failed.node('chart-loading') === undefined, false, 'the retry loads with the whale');
  assert.doesNotMatch(failed.text(), /선물 차트를 불러오지 못했습니다/);
  failed.readGate.resolve();
  await failed.flush();
  assert.equal(chart(failed).props.candles.length, 4);
  assert.equal(failed.node('chart-loading') === undefined, true);
});

test('another contract remounts the chart with that contract only (futures-only HYPEUSDT included)', async (t) => {
  const h = chartScreen({ futuresOnly: true });
  h.futuresCandles = (id: string) => {
    const fixture = futuresCandlesFixture(id);
    const price = id === 'hype' ? '30.00000000' : '60000.00000000';
    return {
      ...fixture,
      instrument: { ...fixture.instrument, symbol: id === 'hype' ? 'HYPEUSDT' : 'BTCUSDT' },
      candles: fixture.candles.map((c: any) => ({ ...c, open: price, close: price, high: price, low: price })),
    };
  };
  await h.start();
  t.after(h.close);
  assert.equal(chart(h).props.candles[0].open, '60000.00000000');
  h.chart = { instrumentId: 'hype', symbol: 'HYPEUSDT', displayPriceDecimals: 3 };
  await h.update();
  const node = chart(h);
  assert.equal(node.props.viewportResetKey, 'hype:4h');
  assert.equal(node.props.displayPriceDecimals, 3);
  assert.ok(node.props.candles.every((c: any) => c.open === '30.00000000'));
  assert.deepEqual(h.candleReads, ['btc', 'hype']);
});

test('뒤로 returns to the futures screen', async (t) => {
  const h = chartScreen();
  await h.start();
  t.after(h.close);
  assert.equal(h.node('futures-chart-back').props.accessibilityLabel, '차트 뒤로가기');
  await h.press('futures-chart-back');
  assert.deepEqual(h.navigation, [['goBack']]);
});
