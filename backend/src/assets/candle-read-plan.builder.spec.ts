jest.mock('../generated/prisma/client', () => ({
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
}));

import { AssetType, CurrencyCode } from '../generated/prisma/client';
import type { ParsedAssetCandlesQuery } from './asset-candles.service';
import { CandleReadPlanBuilder } from './candle-read-plan.builder';

describe('CandleReadPlanBuilder', () => {
  const builder = new CandleReadPlanBuilder({
    mode: 'database',
    currentFreshnessMs: 60_000,
    onDemandRefreshEnabled: true,
    onDemandRefreshMaxDurationMs: 1000,
    onDemandRefreshMaxPages: 10,
    onDemandRefreshMaxRows: 5000,
    staleWaiterMaxWaitMs: 100,
    maxManagedFiveMinuteRangeMs: 35 * 86_400_000,
    maxManagedPeriodRangeMs: 365 * 86_400_000,
    maxOnDemandRepairRangeMs: 2 * 86_400_000,
    coverageTailToleranceMs: 86_400_000,
  });
  const asset = {
    id: 'asset-1',
    symbol: '005930',
    name: 'Samsung',
    market: 'KOSPI',
    assetType: AssetType.domestic_stock,
    currencyCode: CurrencyCode.KRW,
    priceCurrency: CurrencyCode.KRW,
    settlementCurrency: CurrencyCode.KRW,
    isActive: true,
  };
  const base: ParsedAssetCandlesQuery = {
    range: '1d',
    rangeProvided: true,
    rangeStartAt: new Date('2026-07-12T00:00:00Z'),
    rangeEndAt: new Date('2026-07-13T00:00:00Z'),
    interval: '5m',
    intervalMinutes: 5,
    limit: 100,
    requestedDate: '2026-07-13',
    toHHmmss: '090000',
    toInstant: null,
    dateProvided: true,
    toProvided: true,
    includePrevious: true,
    explicitDate: false,
    explicitTo: false,
    clock: new Date('2026-07-13T00:00:00Z'),
  };

  it.each([
    ['5m', '5m', false],
    ['15m', '5m', true],
    ['30m', '5m', true],
    ['1h', '5m', true],
    ['4h', '5m', true],
    ['1d', '1d', false],
    ['1w', '1w', false],
  ] as const)('maps %s to source %s', (target, source, aggregated) => {
    const result = builder.build(asset, { ...base, interval: target });
    expect(result.sourceInterval).toBe(source);
    expect(result.requiresAggregation).toBe(aggregated);
    expect(result.sourceRange.from.getTime()).toBe(
      base.rangeStartAt!.getTime() - (aggregated ? 4 * 60 * 60_000 : 0),
    );
  });

  // The three chart tabs that must be owned by the database path.
  it.each([
    ['30m', '14d', 14, 672] as const,
    ['1h', '14d', 14, 336] as const,
    ['4h', '30d', 30, 200] as const,
  ])(
    'keeps the %s chart request (%s) managed on the stored 5m feed',
    (interval, range, days, limit) => {
      const to = new Date('2026-07-13T00:00:00Z');
      const from = new Date(to.getTime() - days * 86_400_000);
      const result = builder.build(asset, {
        ...base,
        range,
        interval,
        limit,
        rangeStartAt: from,
        rangeEndAt: to,
      });

      expect(result).toMatchObject({
        sourceInterval: '5m',
        requiresAggregation: true,
        managedByPersistence: true,
        outOfPolicyReason: null,
        limit,
      });
      // 4h source padding included, the window still fits the 35-day 5m
      // retention — that is what keeps it out of the legacy path.
      expect(result.sourceRange.from.getTime()).toBe(
        from.getTime() - 4 * 60 * 60_000,
      );
      expect(
        result.sourceRange.to.getTime() - result.sourceRange.from.getTime(),
      ).toBeLessThanOrEqual(35 * 86_400_000);
      expect(result.requestedRange.from.getTime()).toBe(from.getTime());
    },
  );

  it('keeps 1m and retention-exceeding source windows on legacy', () => {
    expect(builder.build(asset, { ...base, interval: '1m' })).toMatchObject({
      managedByPersistence: false,
      outOfPolicyReason: 'interval_not_persisted',
    });
    expect(
      builder.build(asset, {
        ...base,
        rangeStartAt: new Date(base.rangeEndAt!.getTime() - 36 * 86_400_000),
      }),
    ).toMatchObject({
      managedByPersistence: false,
      outOfPolicyReason: 'five_minute_range_exceeds_retention',
    });
  });
});
