import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { homeUnrealizedPnlKrw, orderHomeHoldings, usdKrwRefetchDelay } from './homePortfolio.ts';
import type { PositionItemDto } from '../position/api';
import type { FuturesPosition } from '../futures/api';
import type { FxRateDto } from '../wallet/api';

const require = createRequire(import.meta.url);
const { futuresFixture } = require('../../../test/futuresFixtures.cjs');

describe('Home 평가 손익 = spot + futures Mark unrealized PnL', () => {
  const pnl = (unrealizedPnlKrw: unknown, futuresUnrealizedPnlKrw: unknown) =>
    homeUnrealizedPnlKrw({ unrealizedPnlKrw, futuresUnrealizedPnlKrw } as never);

  it('spot only, futures only, and both directions mixed', () => {
    assert.equal(pnl('12345.67000000', '0.00000000'), '12345.67000000');
    assert.equal(pnl('0.00000000', '-2500.25000000'), '-2500.25000000');
    assert.equal(pnl('1000.50000000', '-2500.25000000'), '-1499.75000000', 'spot profit, futures loss');
    assert.equal(pnl('-1000.50000000', '2500.25000000'), '1499.75000000', 'spot loss, futures profit');
  });

  it('a sum of zero is zero, and long amounts stay exact', () => {
    assert.equal(pnl('1234.50000000', '-1234.50000000'), '0.00000000');
    assert.equal(pnl('9876543210123456.12345678', '0.00000001'), '9876543210123456.12345679');
  });

  it('a missing or malformed part is unknown, never zero', () => {
    for (const [spot, futures] of [
      ['100', undefined], ['100', null], [undefined, '100'], ['100', ''], ['100', 'NaN'], ['1e3', '0'], ['100', ' 1'],
    ]) assert.equal(pnl(spot, futures), null, `${spot} + ${futures}`);
  });
});

const now = Date.now();
const rate = (overrides: Partial<FxRateDto> = {}): FxRateDto => ({ state: 'available', baseCurrency: 'USD', quoteCurrency: 'KRW',
  rate: '1350', validUntil: new Date(now + 60_000).toISOString(), ...overrides });
const spot = (id: string, valueKrw: string | null, state: 'available' | 'stale_cache' | 'unavailable' = 'available') => ({
  positionId: id, assetId: `asset-${id}`, valuation: state === 'unavailable' ? { state, reason: 'X', message: 'x' }
    : { state, positionValueKrw: valueKrw },
}) as unknown as PositionItemDto;
const book = futuresFixture('A', { position: true }).positions;
const futures = (id: string, markNotional: string | null, stale = false) => {
  const base = (stale ? futuresFixture('A', { position: true, stale: true }) : futuresFixture('A', { position: true })).positions.positions[0];
  return { ...base, id, markNotional: stale ? null : markNotional } as FuturesPosition;
};
const order = (s: PositionItemDto[], f: FuturesPosition[], usdKrw: FxRateDto | null = rate()) =>
  orderHomeHoldings({ spot: s, futures: f, futuresEvaluatedAt: book.evaluatedAt, usdKrw, now });
const keys = (result: ReturnType<typeof orderHomeHoldings>) => result.entries.map(entry => entry.key).join(' ');

describe('Home holdings: one list, largest amount first', () => {
  it('interleaves spot KRW value with futures Mark notional converted to KRW', () => {
    // 202 USD × 1350 = 272,700 KRW sits between the two spot rows; 50 USD = 67,500 is last.
    const result = order([spot('a', '300000.00000000'), spot('b', '150000.00000000')], [futures('small', '50'), futures('big', '202')]);
    assert.equal(keys(result), 'spot:a futures:big spot:b futures:small');
    assert.equal(result.topComparable, true);
    assert.equal(result.futuresUncompared, false);
  });

  it('compares KRW and USD spot holdings by their KRW value, not by their local price', () => {
    const us = { ...spot('us', '135000.00000000'), currencyCode: 'USD' } as PositionItemDto;
    assert.equal(keys(order([us, spot('kr', '140000.00000000')], [])), 'spot:kr spot:us');
  });

  it('keeps cached spot values comparable and puts rows without a shown amount last in server order', () => {
    const result = order([spot('none', null, 'unavailable'), spot('cached', '1000', 'stale_cache')], [futures('stale', '999999', true), futures('live', '1')]);
    assert.equal(keys(result), 'futures:live spot:cached spot:none futures:stale');
    assert.equal(result.topComparable, true);
  });

  it('without any comparable amount the top row is not a representative', () => {
    const result = order([spot('x', null, 'unavailable')], [futures('stale', '1', true)]);
    assert.equal(keys(result), 'spot:x futures:stale');
    assert.equal(result.topComparable, false);
  });

  for (const [label, usdKrw] of [
    ['missing', null], ['expired', rate({ validUntil: new Date(now - 1).toISOString() })],
    ['unavailable', rate({ state: 'unavailable' })], ['malformed', rate({ rate: '-1' })],
  ] as const) it(`a ${label} USD/KRW rate never compares USD with KRW`, () => {
    const result = order([spot('a', '1.00000000')], [futures('small', '50'), futures('big', '202')], usdKrw);
    assert.equal(keys(result), 'spot:a futures:big futures:small', 'futures follow, ordered among themselves in USD');
    assert.equal(result.futuresUncompared, true);
    assert.equal(result.topComparable, false);
    const only = order([], [futures('small', '50'), futures('big', '202')], usdKrw);
    assert.equal(keys(only), 'futures:big futures:small', 'futures alone need no rate');
    assert.equal(only.futuresUncompared, false);
    assert.equal(only.topComparable, true);
  });

  it('equal amounts keep spot before futures, each in server order, without mutating inputs', () => {
    const s = [spot('a', '135000'), spot('b', '135000')], f = [futures('f', '100')];
    assert.equal(keys(order(s, f)), 'spot:a spot:b futures:f');
    assert.equal(s.map(p => p.positionId).join(), 'a,b');
  });

  it('a malformed amount is never ordered as a value', () => {
    assert.equal(keys(order([spot('bad', '1e9'), spot('ok', '1')], [futures('neg', '-5')])), 'spot:ok spot:bad futures:neg');
  });
});

describe('USD/KRW re-read', () => {
  it('follows the display validity and falls back to the wallet interval', () => {
    assert.equal(usdKrwRefetchDelay(new Date(now + 10_000).toISOString(), now), 11_001);
    assert.equal(usdKrwRefetchDelay(new Date(now - 10_000).toISOString(), now), 300_000);
    assert.equal(usdKrwRefetchDelay(undefined, now), 300_000);
    assert.equal(usdKrwRefetchDelay(new Date(now + 3_600_000).toISOString(), now), 300_000);
  });
});
