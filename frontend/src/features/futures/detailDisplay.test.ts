import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FUTURES_DAY_CHANGE_MAX_AGE_MS,
  futuresDayChange,
  futuresDayChangeLabel,
  futuresKrwPrice,
} from './detailDisplay.ts';

const NOW = Date.parse('2026-10-20T03:00:00.000Z');
const stats = (receivedAt: number, priceChangePercent = '1.234') => ({
  state: 'available' as const,
  priceChangePercent,
  quoteVolume: '100',
  windowOpenTime: new Date(NOW - 86_400_000).toISOString(),
  windowCloseTime: new Date(NOW).toISOString(),
  receivedAt: new Date(receivedAt).toISOString(),
});
const rate = (overrides: Record<string, unknown> = {}) => ({
  state: 'available',
  baseCurrency: 'USD',
  quoteCurrency: 'KRW',
  rate: '1400.50000000',
  validUntil: new Date(NOW + 60_000).toISOString(),
  ...overrides,
}) as never;

describe('futures detail: rolling 24h change', () => {
  it('is the contract ticker while its read is within the server window', () => {
    assert.equal(futuresDayChange(stats(NOW - 1_000), NOW)?.toString(), '1.234');
    assert.equal(
      futuresDayChange(stats(NOW - FUTURES_DAY_CHANGE_MAX_AGE_MS), NOW)?.toString(),
      '1.234',
    );
  });

  it('is unknown when old, from the future, unavailable or malformed — never 0%', () => {
    assert.equal(futuresDayChange(stats(NOW - FUTURES_DAY_CHANGE_MAX_AGE_MS - 1), NOW), null);
    assert.equal(futuresDayChange(stats(NOW + 6_000), NOW), null);
    assert.equal(futuresDayChange(undefined, NOW), null);
    assert.equal(
      futuresDayChange({ state: 'unavailable', priceChangePercent: null, quoteVolume: null, windowOpenTime: null, windowCloseTime: null, receivedAt: null } as never, NOW),
      null,
    );
    assert.equal(futuresDayChange(stats(NOW, 'abc'), NOW), null);
  });

  it('labels the rolling window, signed, with the asset detail percent format', () => {
    assert.equal(futuresDayChangeLabel(futuresDayChange(stats(NOW, '2.345'), NOW)), '24시간 변동률 +2.35%');
    assert.equal(futuresDayChangeLabel(futuresDayChange(stats(NOW, '-0.5'), NOW)), '24시간 변동률 -0.5%');
    assert.equal(futuresDayChangeLabel(futuresDayChange(stats(NOW, '0'), NOW)), '24시간 변동률 0%');
    assert.equal(futuresDayChangeLabel(null), '24시간 변동률 -');
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
