jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    Prisma: { Decimal },
  };
});

import { Prisma } from '../../generated/prisma/client';
import {
  calculateCandleMatchingEligibleFrom,
  checkCanonicalClosedCandle,
  FIVE_MINUTES_MS,
  type CanonicalCandleRow,
} from './limit-order-candle-eligibility';
import {
  calculateLimitOrderCandleExecutionAmounts,
  calculateLimitOrderExecutionAmounts,
  LimitOrderCandleReservationMismatchError,
} from './limit-order-execution.policy';
import { readLimitOrderCandleReconciliationConfig } from './limit-order-candle-reconciliation.config';
import { LimitOrderMatchingConfigError } from './limit-order-matching.config';
import {
  LIMIT_ORDER_MATCH_BOUNDARY_KEY,
  LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
  LimitOrderMatchBoundaryService,
} from './limit-order-match-boundary.service';

const D = (value: string) => new Prisma.Decimal(value);
const iso = (value: string) => new Date(value);

function candle(
  overrides: Partial<CanonicalCandleRow> = {},
): CanonicalCandleRow {
  return {
    id: 'candle-1',
    assetId: 'asset-1',
    interval: '5m',
    openTime: iso('2026-07-22T01:00:00.000Z'),
    closeTime: iso('2026-07-22T01:05:00.000Z'),
    open: D('100'),
    high: D('110'),
    low: D('90'),
    close: D('105'),
    isClosed: true,
    sourceProvider: 'binance_spot_ws_5m_kline',
    sourceUpdatedAt: iso('2026-07-22T01:05:00.000Z'),
    ...overrides,
  };
}

describe('calculateCandleMatchingEligibleFrom', () => {
  it.each([
    ['2026-07-22T10:00:00.000Z', '2026-07-22T10:00:00.000Z'],
    ['2026-07-22T10:00:00.001Z', '2026-07-22T10:05:00.000Z'],
    ['2026-07-22T10:02:30.000Z', '2026-07-22T10:05:00.000Z'],
    ['2026-07-22T10:04:59.999Z', '2026-07-22T10:05:00.000Z'],
    ['2026-07-22T10:05:00.000Z', '2026-07-22T10:05:00.000Z'],
  ])('rounds %s up to %s', (submittedAt, expected) => {
    expect(
      calculateCandleMatchingEligibleFrom(iso(submittedAt)).toISOString(),
    ).toBe(expected);
  });

  it('always lands on an exact five-minute boundary', () => {
    for (let offset = 0; offset < FIVE_MINUTES_MS; offset += 7919) {
      const result = calculateCandleMatchingEligibleFrom(
        new Date(Date.UTC(2026, 6, 22, 10, 0, 0) + offset),
      );
      expect(result.getTime() % FIVE_MINUTES_MS).toBe(0);
      expect(result.getTime()).toBeGreaterThanOrEqual(
        Date.UTC(2026, 6, 22, 10, 0, 0) + offset,
      );
    }
  });

  it('excludes the candle the order was submitted into', () => {
    // Order at 10:02 inside the 10:00-10:05 window: that window's low may
    // predate the order, so the first usable window opens at 10:05.
    const eligibleFrom = calculateCandleMatchingEligibleFrom(
      iso('2026-07-22T10:02:00.000Z'),
    );
    expect(iso('2026-07-22T10:00:00.000Z') >= eligibleFrom).toBe(false);
    expect(iso('2026-07-22T10:05:00.000Z') >= eligibleFrom).toBe(true);
  });
});

describe('checkCanonicalClosedCandle', () => {
  it('accepts a canonical closed 5m row', () => {
    expect(checkCanonicalClosedCandle(candle())).toEqual({ ok: true });
  });

  it.each([
    ['candle_not_closed', { isClosed: false }],
    ['candle_interval_unsupported', { interval: '1m' }],
    [
      'candle_window_not_five_minutes',
      { closeTime: iso('2026-07-22T01:06:00.000Z') },
    ],
    ['candle_window_invalid', { closeTime: iso('2026-07-22T00:55:00.000Z') }],
    [
      'candle_window_unaligned',
      {
        openTime: iso('2026-07-22T01:01:00.000Z'),
        closeTime: iso('2026-07-22T01:06:00.000Z'),
      },
    ],
    ['candle_price_not_positive', { low: D('0') }],
    ['candle_ohlc_inconsistent', { low: D('101'), open: D('100') }],
    ['candle_ohlc_inconsistent', { high: D('99'), close: D('105') }],
    ['candle_source_unsupported', { sourceProvider: 'synthetic_preview' }],
    ['candle_source_missing', { sourceProvider: '  ' }],
  ])('rejects with %s', (reason, overrides) => {
    const result = checkCanonicalClosedCandle(
      candle(overrides as Partial<CanonicalCandleRow>),
    );
    expect(result).toEqual({ ok: false, reason, permanent: true });
  });
});

describe('calculateLimitOrderCandleExecutionAmounts', () => {
  const base = {
    limitPrice: D('100'),
    quantity: D('10'),
    reservationFeeRate: D('0.001'),
    // 100 * 10 = 1000 gross, fee 1.00000000, debit 1001.00000000
    reservedAmount: D('1001'),
  };

  it('executes at the limit price, never at the candle low', () => {
    const amounts = calculateLimitOrderCandleExecutionAmounts(base);
    expect(amounts.executedPrice.toString()).toBe('100');
    expect(amounts.grossAmount.toString()).toBe('1000');
    expect(amounts.feeAmount.toString()).toBe('1');
    expect(amounts.actualDebit.toString()).toBe('1001');
    // No price improvement exists on path B.
    expect(amounts.priceImprovementAmount.toString()).toBe('0');
  });

  it('debits exactly the order reservation', () => {
    const amounts = calculateLimitOrderCandleExecutionAmounts(base);
    expect(amounts.actualDebit.eq(base.reservedAmount)).toBe(true);
    expect(amounts.reservationRelease.eq(base.reservedAmount)).toBe(true);
  });

  it('uses the order fee rate, not a current season rate', () => {
    const amounts = calculateLimitOrderCandleExecutionAmounts({
      ...base,
      reservationFeeRate: D('0.005'),
      reservedAmount: D('1005'),
    });
    expect(amounts.feeAmount.toString()).toBe('5');
    expect(amounts.actualDebit.toString()).toBe('1005');
  });

  it('refuses to fill when the recomputed debit drifts from the reservation', () => {
    expect(() =>
      calculateLimitOrderCandleExecutionAmounts({
        ...base,
        reservedAmount: D('1000'),
      }),
    ).toThrow(LimitOrderCandleReservationMismatchError);
    expect(() =>
      calculateLimitOrderCandleExecutionAmounts({
        ...base,
        reservedAmount: D('1002'),
      }),
    ).toThrow(LimitOrderCandleReservationMismatchError);
  });

  it('never exceeds what path A would debit at the same limit price', () => {
    const pathA = calculateLimitOrderExecutionAmounts({
      eventPrice: D('100'),
      quantity: base.quantity,
      reservationFeeRate: base.reservationFeeRate,
      reservedAmount: base.reservedAmount,
    });
    const pathB = calculateLimitOrderCandleExecutionAmounts(base);
    expect(pathB.actualDebit.eq(pathA.actualDebit)).toBe(true);
  });
});

describe('readLimitOrderCandleReconciliationConfig', () => {
  it('defaults to disabled', () => {
    expect(readLimitOrderCandleReconciliationConfig({}).enabled).toBe(false);
  });

  it('rejects path B without path A (combination D)', () => {
    expect(() =>
      readLimitOrderCandleReconciliationConfig({
        LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED: 'true',
        LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'false',
      }),
    ).toThrow(LimitOrderMatchingConfigError);
  });

  it('accepts path A + path B (combination C)', () => {
    const config = readLimitOrderCandleReconciliationConfig({
      LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED: 'true',
      LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
      LIMIT_ORDER_CANDLE_RECONCILIATION_LOOKBACK_MS: '1800000',
      LIMIT_ORDER_CANDLE_RECONCILIATION_CANDLE_BATCH_SIZE: '50',
      LIMIT_ORDER_CANDLE_RECONCILIATION_ORDER_BATCH_SIZE: '25',
    });
    expect(config).toEqual({
      enabled: true,
      lookbackMs: 1_800_000,
      candleBatchSize: 50,
      orderBatchSize: 25,
    });
  });

  it('rejects an unparseable flag instead of silently reading it as off', () => {
    expect(() =>
      readLimitOrderCandleReconciliationConfig({
        LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED: 'yes',
      }),
    ).toThrow();
  });

  it('rejects out-of-range bounds', () => {
    expect(() =>
      readLimitOrderCandleReconciliationConfig({
        LIMIT_ORDER_CANDLE_RECONCILIATION_CANDLE_BATCH_SIZE: '0',
      }),
    ).toThrow(LimitOrderMatchingConfigError);
  });
});

describe('LimitOrderMatchBoundaryService', () => {
  it('uses one fixed advisory key for every participant', async () => {
    const service = new LimitOrderMatchBoundaryService();
    const queries: Array<{ sql: string; values: unknown[] }> = [];
    await service.lockInTransaction({
      $queryRaw: ((strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push({ sql: strings.join('?'), values });
        return Promise.resolve([]);
      }) as never,
    } as never);

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('pg_advisory_xact_lock');
    expect(queries[0].values).toEqual([
      LIMIT_ORDER_MATCH_BOUNDARY_NAMESPACE,
      LIMIT_ORDER_MATCH_BOUNDARY_KEY,
    ]);
  });

  it('separates the boundary key from the matcher leader key', () => {
    // Leader uses (1244660901, 1); sharing the key would make a standby
    // matcher block every create.
    expect(LIMIT_ORDER_MATCH_BOUNDARY_KEY).not.toBe(1);
  });
});
