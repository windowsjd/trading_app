import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const { futuresHarness, futuresCandlesFixture } = createRequire(import.meta.url)(
  '../../../test/futuresHarness.cjs',
);

const chart = (h: any) =>
  h.renderer.root.findAll((node: any) => node.type === 'CandlestickChart')[0];

test('shows the selected contract chart from the account-free futures market-data route', async (t) => {
  const h = futuresHarness();
  await h.start();
  t.after(h.close);
  const node = chart(h);
  assert.equal(node === undefined, false);
  assert.equal(node.props.candles.length, 4);
  assert.equal(node.props.viewportResetKey, 'btc:4h');
  assert.equal(node.props.currencyCode, 'USD');
  assert.equal(node.props.displayPriceDecimals, 2);
  // Fresh Futures Last is the current-price line; the chart never uses Mark.
  assert.equal(node.props.currentPrice, '102');
  assert.deepEqual(h.candleReads, ['btc']);
  const keys = h.client
    .getQueryCache()
    .findAll({ queryKey: ['futuresMarket'] })
    .map((query: any) => JSON.stringify(query.queryKey));
  assert.deepEqual(keys, [JSON.stringify(['futuresMarket', 'candles', 'btc', '96d', '4h', 600])]);
  // Contract basis and the separate Mark role are both stated.
  assert.match(h.text(), /선물 계약 거래가격\(Last\) 기준/);
  assert.match(h.text(), /Mark Price · 평가\/청산 기준/);
  assert.match(h.text(), /마지막 봉은 진행 중인 잠정 봉입니다/);
});

test('switching contracts remounts the chart with the other contract only (futures-only HYPEUSDT included)', async (t) => {
  const h = futuresHarness({ futuresOnly: true });
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
  await h.choose('HYPEUSDT');
  const node = chart(h);
  assert.equal(node.props.viewportResetKey, 'hype:4h');
  assert.equal(node.props.displayPriceDecimals, 3);
  assert.ok(node.props.candles.every((c: any) => c.open === '30.00000000'));
  assert.deepEqual(h.candleReads, ['btc', 'hype']);
});

test('a response for another contract is never drawn under the selected one', async (t) => {
  const h = futuresHarness();
  h.futuresCandles = (id: string) => ({
    ...futuresCandlesFixture(id),
    instrument: { ...futuresCandlesFixture(id).instrument, id: 'other' },
  });
  await h.start();
  t.after(h.close);
  assert.equal(chart(h) === undefined, true);
  assert.equal(
    h.renderer.root.findAll((n: any) => n.props?.message === '선물 차트를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.').length > 0,
    true,
  );
});

test('shows an empty state before collection and an error state on failure, without hiding the trade form', async (t) => {
  const empty = futuresHarness();
  empty.futuresCandles = (id: string) => ({ ...futuresCandlesFixture(id), state: 'empty', candles: [] });
  await empty.start();
  t.after(empty.close);
  assert.equal(chart(empty) === undefined, true);
  assert.match(empty.text(), /아직 수집된 선물 차트 데이터가 없습니다/);
  assert.equal(empty.node('futures-submit') === undefined, false);

  const failed = futuresHarness();
  failed.candleFailure = Object.assign(new Error('network'), { code: 'ERR_NETWORK' });
  await failed.start();
  t.after(failed.close);
  assert.equal(chart(failed) === undefined, true);
  assert.equal(failed.node('futures-submit') === undefined, false);
});

test('switching the trading account drops the account-bound screen before any chart of the old account is reused', async (t) => {
  const h = futuresHarness();
  await h.start();
  t.after(h.close);
  assert.equal(chart(h) === undefined, false);
  h.accountId = 'B';
  await h.update();
  assert.equal(chart(h) === undefined, true);
  assert.match(h.text(), /선택한 계정이 변경되었습니다/);
});
