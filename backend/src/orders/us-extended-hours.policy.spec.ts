jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  OrderType: { market: 'market', limit: 'limit' },
}));

import { AssetType, OrderType } from '../generated/prisma/client';
import {
  applyMarketSessionOverrideSnapshot,
  markMarketSessionOverrideStoreRequired,
  resetMarketSessionOverrideStoreForTest,
} from './market-calendar/market-session-override.store';
import { assertOrderSessionAllowed } from './market-hours.policy';
import {
  resolveUsExtendedHoursState,
  resolveUsExtendedHoursWindow,
} from './us-extended-hours.policy';
import { classifyUsEquitySegment } from '../providers/tiingo/tiingo-session';

const us = { assetType: AssetType.us_stock, market: 'NAS' };
const at = (iso: string) => new Date(iso);
const state = (iso: string) => resolveUsExtendedHoursState(us, at(iso))?.state;

describe('US extended trading hours (real exchange calendar)', () => {
  afterEach(() => resetMarketSessionOverrideStoreForTest());

  it('splits an EST trading day at 04:00, 09:30, 16:00 and 20:00 New York', () => {
    // 2026-11-10 (Tuesday), EST = UTC−5.
    expect(state('2026-11-10T08:59:59.999Z')).toBe('closed');
    expect(state('2026-11-10T09:00:00.000Z')).toBe('pre_market');
    expect(state('2026-11-10T14:29:59.999Z')).toBe('pre_market');
    expect(state('2026-11-10T14:30:00.000Z')).toBe('regular');
    expect(state('2026-11-10T20:59:59.999Z')).toBe('regular');
    expect(state('2026-11-10T21:00:00.000Z')).toBe('after_hours');
    expect(state('2026-11-11T00:59:59.999Z')).toBe('after_hours');
    expect(state('2026-11-11T01:00:00.000Z')).toBe('closed');

    const pre = resolveUsExtendedHoursWindow(us, at('2026-11-10T10:00:00Z'));
    expect(pre?.startsAt.toISOString()).toBe('2026-11-10T09:00:00.000Z');
    expect(pre?.endsAt.toISOString()).toBe('2026-11-10T14:30:00.000Z');
    expect(pre?.session.localDate).toBe('2026-11-10');
    const after = resolveUsExtendedHoursWindow(us, at('2026-11-10T22:00:00Z'));
    expect(after?.startsAt.toISOString()).toBe('2026-11-10T21:00:00.000Z');
    expect(after?.endsAt.toISOString()).toBe('2026-11-11T01:00:00.000Z');
  });

  it('follows daylight saving time on both sides of the March switch', () => {
    // Friday 2026-03-06 is EST (UTC−5); Monday 2026-03-09 is EDT (UTC−4).
    expect(state('2026-03-06T08:59:59.999Z')).toBe('closed');
    expect(state('2026-03-06T09:00:00.000Z')).toBe('pre_market');
    expect(state('2026-03-09T07:59:59.999Z')).toBe('closed');
    expect(state('2026-03-09T08:00:00.000Z')).toBe('pre_market');
    expect(state('2026-03-09T13:29:59.999Z')).toBe('pre_market');
    expect(state('2026-03-09T13:30:00.000Z')).toBe('regular');
    expect(state('2026-03-09T20:00:00.000Z')).toBe('after_hours');
    expect(state('2026-03-09T23:59:59.999Z')).toBe('after_hours');
    expect(state('2026-03-10T00:00:00.000Z')).toBe('closed');
  });

  it('has no extended hours on a holiday or a weekend', () => {
    // Thanksgiving 2026-11-26 and Saturday 2026-11-14.
    for (const iso of [
      '2026-11-26T10:00:00Z',
      '2026-11-26T15:00:00Z',
      '2026-11-26T22:00:00Z',
      '2026-11-14T10:00:00Z',
      '2026-11-14T22:00:00Z',
    ])
      expect(state(iso)).toBe('closed');
  });

  it('ends after-hours at 17:00 New York on a 13:00 early close', () => {
    // Day after Thanksgiving 2026-11-27 closes at 13:00 ET (18:00Z).
    expect(state('2026-11-27T09:00:00.000Z')).toBe('pre_market');
    expect(state('2026-11-27T17:59:59.999Z')).toBe('regular');
    expect(state('2026-11-27T18:00:00.000Z')).toBe('after_hours');
    expect(state('2026-11-27T21:59:59.999Z')).toBe('after_hours');
    expect(state('2026-11-27T22:00:00.000Z')).toBe('closed');
    expect(state('2026-11-28T00:30:00.000Z')).toBe('closed');
    const window = resolveUsExtendedHoursWindow(us, at('2026-11-27T19:00Z'));
    expect(window?.endsAt.toISOString()).toBe('2026-11-27T22:00:00.000Z');
    // Christmas Eve 2026-12-24 as well.
    expect(state('2026-12-24T21:59:00.000Z')).toBe('after_hours');
    expect(state('2026-12-24T22:00:00.000Z')).toBe('closed');
    // Tiingo's segment classification uses the same windows.
    expect(classifyUsEquitySegment(at('2026-11-27T21:59:59.999Z'))).toBe(
      'after_hours',
    );
    expect(classifyUsEquitySegment(at('2026-11-27T22:00:00.000Z'))).toBe(
      'overnight',
    );
    expect(classifyUsEquitySegment(at('2026-11-10T09:00:00.000Z'))).toBe(
      'pre_market',
    );
    expect(classifyUsEquitySegment(at('2026-11-26T22:00:00.000Z'))).toBe(
      'non_trading_day',
    );
  });

  it('fails closed without calendar coverage or before the override snapshot loads', () => {
    expect(state('2031-01-07T10:00:00Z')).toBe('calendar_unavailable');
    expect(resolveUsExtendedHoursWindow(us, at('2031-01-07T10:00:00Z'))).toBe(
      null,
    );
    markMarketSessionOverrideStoreRequired();
    expect(state('2026-11-10T10:00:00Z')).toBe('calendar_unavailable');
  });

  it('follows operator session overrides (closure and a late open)', () => {
    applyMarketSessionOverrideSnapshot(
      [
        {
          market: 'US',
          localDate: '2026-11-10',
          overrideType: 'closed',
          openTime: null,
          closeTime: null,
          reason: 'test closure',
        },
        {
          market: 'US',
          localDate: '2026-11-12',
          overrideType: 'custom',
          openTime: '103000',
          closeTime: '160000',
          reason: 'test late open',
        },
      ],
      new Date('2026-11-09T00:00:00Z'),
    );
    expect(state('2026-11-10T10:00:00Z')).toBe('closed');
    expect(state('2026-11-10T22:00:00Z')).toBe('closed');
    // Pre-market runs until the (late) regular open.
    expect(state('2026-11-12T15:29:59.999Z')).toBe('pre_market');
    expect(state('2026-11-12T15:30:00.000Z')).toBe('regular');
  });

  it('is US-stock only', () => {
    const now = at('2026-11-10T10:00:00Z');
    expect(
      resolveUsExtendedHoursState(
        { assetType: AssetType.domestic_stock, market: 'KRX' },
        now,
      ),
    ).toBe(null);
    expect(
      resolveUsExtendedHoursState(
        { assetType: AssetType.crypto, market: 'BINANCE' },
        now,
      ),
    ).toBe(null);
  });

  it('never opens market orders in extended hours; limit registration keeps its rule', () => {
    const previous = { ...process.env };
    try {
      process.env.US_STOCK_PRICE_PROVIDER = 'tiingo';
      process.env.US_STOCK_EXTENDED_HOURS_PRICE_ENABLED = 'true';
      process.env.US_STOCK_EXTENDED_HOURS_LIMIT_MATCHING_ENABLED = 'true';
      for (const iso of ['2026-11-10T10:00:00Z', '2026-11-10T22:00:00Z']) {
        expect(() =>
          assertOrderSessionAllowed(us, at(iso), OrderType.market),
        ).toThrow('US market is closed.');
        expect(() =>
          assertOrderSessionAllowed(us, at(iso), OrderType.limit),
        ).not.toThrow();
      }
    } finally {
      process.env = previous;
    }
  });
});
