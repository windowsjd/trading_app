import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Decimal from 'decimal.js';
import type { FuturesCandle, FuturesCandles } from './api';
import {
  FUTURES_PREVIOUS_DAY_WINDOW,
  futuresKrwPrice,
  futuresPreviousDayChange,
  futuresPreviousDayChangeLabel,
  futuresPreviousDayClose,
  futuresPreviousUtcDayStart,
} from './detailDisplay.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-20T03:00:00.000Z');
const OCT_18 = Date.parse('2026-10-18T00:00:00.000Z');
const OCT_19 = Date.parse('2026-10-19T00:00:00.000Z');
const OCT_20 = Date.parse('2026-10-20T00:00:00.000Z');
const OCT_21 = Date.parse('2026-10-21T00:00:00.000Z');
const rate = (overrides: Record<string, unknown> = {}) => ({
  state: 'available',
  baseCurrency: 'USD',
  quoteCurrency: 'KRW',
  rate: '1400.50000000',
  validUntil: new Date(NOW + 60_000).toISOString(),
  ...overrides,
}) as never;
const btc = { id: 'btc', underlying: { assetId: 'asset-btc', symbol: 'BTCUSDT', name: '비트코인', market: 'BINANCE', displayPriceDecimals: 2 } };
const day = (openMs: number, close: string, provisional = false): FuturesCandle => ({
  time: new Date(openMs).toISOString(), open: '100.00000000', high: '200.00000000', low: '50.00000000', close,
  volume: '10.00000000', amount: '1000.00000000', provisional,
});
/** The 1d read as the server answers `limit=2`: the previous UTC day settled, today's open. */
const daily = (candles: FuturesCandle[] = [day(OCT_19, '100.00000000'), day(OCT_20, '102.00000000', true)],
  patch: { instrument?: Record<string, unknown>; source?: Record<string, unknown>; [key: string]: unknown } = {}): FuturesCandles => ({
  state: 'available', priceBasis: 'contract_last_trade', range: '1y', interval: '1d', candles, ...patch,
  instrument: { id: 'btc', symbol: 'BTCUSDT', name: 'Bitcoin', productType: 'synthetic_perpetual', settlementCurrency: 'USD',
    isActive: true, displayPriceDecimals: 2, ...patch.instrument },
  source: { provider: 'binance_usdm', endpoint: '/fapi/v1/klines', symbol: 'BTCUSDT', contractType: 'PERPETUAL', requestedCount: 2,
    returnedCount: candles.length, provisionalUpdatedAt: null, delivery: 'provider', fetchedAt: new Date(NOW - 1_000).toISOString(),
    stale: false, ...patch.source },
} as FuturesCandles);
/** `instrument: null` = the contract is not (yet) in the list. */
const close = (read: FuturesCandles | undefined, now = NOW, instrument: typeof btc | null = btc) =>
  futuresPreviousDayClose(read, instrument ?? undefined, now)?.toString() ?? null;
const change = (last: string | null, previousClose: string | null, lastFresh = true) =>
  futuresPreviousDayChange({ last, lastFresh, previousClose: previousClose === null ? null : new Decimal(previousClose) });

describe('futures detail: 전일대비 against the previous UTC day', () => {
  it('reads the 1d chart window, two buckets only', () => {
    assert.deepEqual(FUTURES_PREVIOUS_DAY_WINDOW, { interval: '1d', range: '1y', limit: 2 });
  });

  it('a futures day is 00:00–24:00 UTC (not KST): its open is the 1d kline time', () => {
    assert.equal(futuresPreviousUtcDayStart(NOW), OCT_19);
    assert.equal(futuresPreviousUtcDayStart(OCT_20), OCT_19, 'midnight starts the new day');
    assert.equal(futuresPreviousUtcDayStart(OCT_20 - 1), OCT_18);
    // 2026-10-20 08:59 KST is still 10-19 in UTC.
    assert.equal(futuresPreviousUtcDayStart(Date.parse('2026-10-20T08:59:59.999+09:00')), OCT_18);
    assert.equal(futuresPreviousUtcDayStart(Date.parse('2026-10-20T09:00:00.000+09:00')), OCT_19);
  });

  it("takes the close of the contract's own settled bucket of exactly the previous UTC day", () => {
    assert.equal(close(daily()), '100');
    // A server copy that also holds older days (or no current bucket yet) gives the same day.
    assert.equal(close(daily([day(OCT_18, '90'), day(OCT_19, '100.5')])), '100.5');
  });

  it('moves to the next day at 00:00 UTC, and only to a settled bucket', () => {
    const read = daily([day(OCT_19, '100'), day(OCT_20, '102', true)]);
    assert.equal(close(read, OCT_21 - 1), '100', '23:59:59.999 UTC still compares with 10-19');
    // 10-20 is the previous day from 00:00 UTC: the read taken before then holds it open — no figure.
    assert.equal(close(read, OCT_21), null);
    assert.equal(close(daily([day(OCT_20, '102'), day(OCT_21, '103', true)], { source: { fetchedAt: new Date(OCT_21 + 1_000).toISOString() } }),
      OCT_21), '102');
  });

  it('never an older day, a provisional or doubled bucket, another contract or interval, or a non-Last series', () => {
    // The previous day withheld (open when received): 10-18 never stands in.
    assert.equal(close(daily([day(OCT_18, '90'), day(OCT_20, '102', true)])), null);
    assert.equal(close(daily([day(OCT_18, '90')])), null);
    assert.equal(close(daily([day(OCT_19, '100', true), day(OCT_20, '102', true)])), null, 'not settled yet');
    assert.equal(close(daily([day(OCT_19, '100'), day(OCT_19, '101'), day(OCT_20, '102', true)])), null, 'ambiguous');
    // Marked settled, but the read itself was received before that day ended, or carries no receipt time.
    assert.equal(close(daily(undefined, { source: { fetchedAt: new Date(OCT_20 - 1).toISOString() } })), null);
    assert.equal(close(daily(undefined, { source: { fetchedAt: null } })), null);
    assert.equal(close(daily(undefined, { source: { fetchedAt: new Date(OCT_20).toISOString() } })), '100', 'received at 00:00 UTC');
    assert.equal(close(daily([])), null);
    assert.equal(close(undefined), null);
    assert.equal(close(daily(), NOW, null), null);
    assert.equal(close(daily(undefined, { instrument: { id: 'eth' } })), null);
    assert.equal(close(daily(undefined, { instrument: { symbol: 'ETHUSDT' } })), null);
    assert.equal(close(daily(undefined, { source: { symbol: 'ETHUSDT' } })), null);
    assert.equal(close(daily(undefined, { interval: '4h' })), null);
    assert.equal(close(daily(undefined, { priceBasis: 'mark_price' })), null);
    assert.equal(close(daily(undefined, { source: { provider: 'binance_spot' } })), null);
    assert.equal(close(daily(undefined, { source: { contractType: 'CURRENT_QUARTER' } })), null);
    for (const bad of ['0', '-1', 'abc', '', 'Infinity']) {
      assert.equal(close(daily([day(OCT_19, bad), day(OCT_20, '102', true)])), null, bad);
    }
  });

  it('a server copy marked stale still gives a bucket that was settled when received', () => {
    assert.equal(close(daily(undefined, { source: { stale: true } })), '100');
  });

  it('is (fresh Last − previous close) / previous close × 100 in USD; unknown without either, never 0', () => {
    assert.equal(change('102', '100')?.toString(), '2');
    assert.equal(change('99.34', '100')?.toString(), '-0.66');
    assert.equal(change('100', '100')?.toString(), '0');
    assert.equal(change('102', '100', false), null, 'a stale Last');
    assert.equal(change(null, '100'), null);
    assert.equal(change('0', '100'), null);
    assert.equal(change('abc', '100'), null);
    assert.equal(change('102', null), null, 'no settled previous close');
  });

  it("labels it 전일대비 in the asset detail's signed percent format", () => {
    assert.equal(futuresPreviousDayChangeLabel(change('102.345', '100')), '전일대비 +2.35%');
    assert.equal(futuresPreviousDayChangeLabel(change('99.34', '100')), '전일대비 -0.66%');
    assert.equal(futuresPreviousDayChangeLabel(change('100', '100')), '전일대비 0%');
    assert.equal(futuresPreviousDayChangeLabel(null), '전일대비 -');
    // A whole contract-price figure keeps its precision before rounding: (67,890.1 − 66,000) / 66,000.
    assert.equal(futuresPreviousDayChangeLabel(change('67890.1', '66000')), '전일대비 +2.86%');
  });
});

describe('futures detail: won display of the Last', () => {
  it('converts a fresh Last at a current USD/KRW rate (display only, whole won)', () => {
    assert.equal(
      futuresKrwPrice({ last: '102.25', lastFresh: true, fxRate: rate(), now: NOW }),
      '143,201원',
    );
  });

  it('gives no won figure for a stale Last, a missing/expired/foreign rate or a non-positive rate', () => {
    assert.equal(futuresKrwPrice({ last: '102', lastFresh: false, fxRate: rate(), now: NOW }), null);
    assert.equal(futuresKrwPrice({ last: null, lastFresh: true, fxRate: rate(), now: NOW }), null);
    assert.equal(futuresKrwPrice({ last: '102', lastFresh: true, fxRate: null, now: NOW }), null);
    assert.equal(
      futuresKrwPrice({ last: '102', lastFresh: true, fxRate: rate({ validUntil: new Date(NOW - 1).toISOString() }), now: NOW }),
      null,
    );
    assert.equal(
      futuresKrwPrice({ last: '102', lastFresh: true, fxRate: rate({ state: 'unavailable' }), now: NOW }),
      null,
    );
    assert.equal(
      futuresKrwPrice({ last: '102', lastFresh: true, fxRate: rate({ baseCurrency: 'KRW', quoteCurrency: 'USD' }), now: NOW }),
      null,
    );
    assert.equal(futuresKrwPrice({ last: '102', lastFresh: true, fxRate: rate({ rate: '0' }), now: NOW }), null);
  });
});
