import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';

const require = createRequire(import.meta.url);
const { createTradingUiHarness, elements } = require('../../../test/tradingUiHarness.cjs');
// The module instance the screen loads (shared Node cache).
const guestState = require('../../features/auth/guestBrowsing.ts');

/** The KRX fixture asset (KRW) on the chart screen, with one of each line. */
function chartHarness() {
  const h = createTradingUiHarness('asset/AssetChartScreen.tsx');
  h.candles = [{ time: '2026-09-16T00:00:00Z', open: '70000', high: '71000', low: '69000', close: '70500', volume: '20' }];
  h.positionQuery = { data: { positions: [{ positionId: 'p-1', assetId: 'asset-1', currencyCode: 'KRW', quantity: '10', averageCost: '68000',
    valuation: { state: 'available', returnRate: '3.68' } }] }, isLoading: false, isError: false };
  h.ordersQuery = { data: { tradingAccountId: 'account-1', items: [
    { orderId: 'o-1', assetId: 'asset-1', currencyCode: 'KRW', side: 'buy', orderType: 'limit', status: 'submitted', limitPrice: '65000', quantity: '1' },
    { orderId: 'o-2', assetId: 'asset-2', currencyCode: 'KRW', side: 'buy', orderType: 'limit', status: 'submitted', limitPrice: '1000', quantity: '1' },
  ] } };
  h.sellQuery = { data: { tradingAccountId: 'account-1', capabilities: {}, pagination: {}, conditionalOrders: [
    { id: 'sl', assetId: 'asset-1', currencyCode: 'KRW', kind: 'stop_loss', state: 'watching', triggerPrice: '60000' },
    { id: 'cond', assetId: 'asset-1', currencyCode: 'KRW', kind: 'condition', state: 'watching', triggerPrice: '75000' },
  ] } };
  return h;
}
const lines = (h: any) => {
  const chart = elements(h.render(), 'CandlestickChart')[0];
  return chart.props.priceLines.map((line: any) => [line.kind, line.title, line.price, line.note ?? null]);
};
// The reads this chart shares with the order screen (same keys).
const lineKeys = [
  QUERY_KEYS.tradingAccount.positions('account-1', { assetId: 'asset-1', limit: 20 }),
  QUERY_KEYS.tradingAccount.pendingOrders('account-1'),
  QUERY_KEYS.tradingAccount.conditionalBuy.open('account-1'),
  QUERY_KEYS.tradingAccount.conditionalSell.open('account-1', 'condition'),
  QUERY_KEYS.tradingAccount.conditionalSell.open('account-1', 'protection'),
  QUERY_KEYS.tradingAccount.protections.list('account-1', 'spot', 'asset-1'),
].map((key) => JSON.stringify(key));
const lineQueries = (h: any) => {
  h.render();
  return h.queries.filter((query: any) => lineKeys.includes(JSON.stringify(query.queryKey)));
};

describe('the spot chart draws the selected account\'s own prices', () => {
  it('holding average with its return rate, the open limit order and the watched triggers of this asset', () => {
    const h = chartHarness();
    assert.deepEqual(lines(h), [
      ['average', '평단가', 68000, '+3.68%'], ['limit', '지정가 매수', 65000, null],
      ['trigger', '조건 매도 감시가', 75000, null], ['trigger', '손절가', 60000, null],
    ]);
    // The order screen's own reads, one each, enabled while this screen is in front.
    const queries = lineQueries(h);
    assert.equal(queries.length, lineKeys.length);
    assert.equal(queries.every((query: any) => query.enabled === true), true);
  });

  it('reads repeat only while something on this asset can still change', () => {
    const h = chartHarness();
    h.render();
    const interval = (key: unknown[]) => {
      const query = lineQueries(h).find((item: any) => JSON.stringify(item.queryKey) === JSON.stringify(key));
      return typeof query.refetchInterval === 'function' ? query.refetchInterval() : query.refetchInterval;
    };
    assert.equal(interval(QUERY_KEYS.tradingAccount.positions('account-1', { assetId: 'asset-1', limit: 20 })), 4000);
    assert.equal(interval(QUERY_KEYS.tradingAccount.pendingOrders('account-1')), 4000);
    // Nothing held, ordered or watched here: no repeating reads.
    h.positionQuery = { data: { positions: [] }, isLoading: false, isError: false };
    h.ordersQuery = undefined;
    h.sellQuery = undefined;
    h.render();
    assert.equal(interval(QUERY_KEYS.tradingAccount.positions('account-1', { assetId: 'asset-1', limit: 20 })), false);
    assert.equal(interval(QUERY_KEYS.tradingAccount.pendingOrders('account-1')), false);
  });

  it('never draws another account\'s answer', () => {
    const h = chartHarness();
    h.positionQuery.data.tradingAccountId = 'account-2';
    h.ordersQuery.data.tradingAccountId = 'account-2';
    h.sellQuery.data.tradingAccountId = 'account-2';
    assert.deepEqual(lines(h), []);
  });

  it('a guest, a selection still changing or another screen in front: no account reads and no lines', (t) => {
    const cases: Array<[string, (h: any) => void]> = [
      ['guest', () => { guestState.setGuestBrowsing(true); }],
      ['switching', (h) => { h.selectedAccountId = 'account-2'; }],
      ['unfocused', (h) => { h.isFocused = false; }],
    ];
    t.after(() => guestState.setGuestBrowsing(false));
    for (const [label, apply] of cases) {
      guestState.setGuestBrowsing(false);
      const h = chartHarness();
      apply(h);
      assert.equal(lineQueries(h).every((query: any) => query.enabled === false), true, label);
      if (label !== 'unfocused') assert.deepEqual(lines(h), [], label);
    }
  });
});
