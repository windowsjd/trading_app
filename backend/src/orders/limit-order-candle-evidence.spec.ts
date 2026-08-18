jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    OrderSide: {
      buy: 'buy',
      sell: 'sell',
    },
  };
});

import { OrderSide, Prisma } from '../generated/prisma/client';
import { LimitOrderCandleEvidenceService } from './limit-order-candle-evidence.service';
import type { EligibleClosedCandle } from './limit-order-candle-evidence.service';

const d = (value: string | number) => new Prisma.Decimal(value);

function candle(
  openIso: string,
  low: string,
  high = low,
): EligibleClosedCandle {
  const open = new Date(openIso);
  return {
    marketCandleId: `candle-${openIso}`,
    openTime: open,
    closeTime: new Date(open.getTime() + 300_000),
    low: d(low),
    high: d(high),
    sourceProvider: 'binance',
    sourceUpdatedAt: open,
    finalizedAt: open,
  };
}

describe('LimitOrderCandleEvidenceService.selectTriggerCandleForOrder', () => {
  // Only the pure selection is exercised here; DB-backed candle lookup and
  // evidence upsert are covered by the PostgreSQL integration suite.
  const service = new LimitOrderCandleEvidenceService(null as never);

  const seasonEndAt = new Date('2026-07-22T23:59:00.000Z');

  it('picks the earliest candle whose window opens at/after the first eligible boundary and reaches the limit', () => {
    const candles = [
      candle('2026-07-22T12:00:00.000Z', '95'), // pre-submission partial window
      candle('2026-07-22T12:05:00.000Z', '110'), // eligible window, but low above limit
      candle('2026-07-22T12:10:00.000Z', '90'), // eligible + reaches limit → picked
      candle('2026-07-22T12:15:00.000Z', '80'),
    ];
    const match = service.selectTriggerCandleForOrder(candles, {
      submittedAt: new Date('2026-07-22T12:00:00.500Z'), // → firstEligible 12:05
      limitPrice: d('100'),
      seasonEndAt,
    });
    expect(match?.openTime.toISOString()).toBe('2026-07-22T12:10:00.000Z');
  });

  it('never uses the partial candle the order was submitted into', () => {
    const candles = [candle('2026-07-22T12:00:00.000Z', '90')];
    const match = service.selectTriggerCandleForOrder(candles, {
      submittedAt: new Date('2026-07-22T12:00:00.500Z'), // firstEligible 12:05
      limitPrice: d('100'),
      seasonEndAt,
    });
    expect(match).toBeNull();
  });

  it('excludes a candle that closes after the season endAt', () => {
    const candles = [candle('2026-07-22T12:10:00.000Z', '90')];
    const match = service.selectTriggerCandleForOrder(candles, {
      submittedAt: new Date('2026-07-22T12:00:00.000Z'),
      limitPrice: d('100'),
      // Season ends inside the candle window → the candle closes after it.
      seasonEndAt: new Date('2026-07-22T12:12:00.000Z'),
    });
    expect(match).toBeNull();
  });

  it('returns null when no candle low reaches the limit', () => {
    const candles = [
      candle('2026-07-22T12:05:00.000Z', '110'),
      candle('2026-07-22T12:10:00.000Z', '105'),
    ];
    const match = service.selectTriggerCandleForOrder(candles, {
      submittedAt: new Date('2026-07-22T12:00:00.000Z'),
      limitPrice: d('100'),
      seasonEndAt,
    });
    expect(match).toBeNull();
  });

  it('fills at limit-price boundary (low == limit)', () => {
    const candles = [candle('2026-07-22T12:05:00.000Z', '100')];
    const match = service.selectTriggerCandleForOrder(candles, {
      submittedAt: new Date('2026-07-22T12:00:00.000Z'),
      limitPrice: d('100'),
      seasonEndAt,
    });
    expect(match?.openTime.toISOString()).toBe('2026-07-22T12:05:00.000Z');
  });

  it('uses candle high for a limit sell and picks the earliest reached window', () => {
    const candles = [
      candle('2026-07-22T12:05:00.000Z', '80', '99'),
      candle('2026-07-22T12:10:00.000Z', '85', '101'),
      candle('2026-07-22T12:15:00.000Z', '90', '110'),
    ];
    const match = service.selectTriggerCandleForOrder(candles, {
      submittedAt: new Date('2026-07-22T12:00:00.000Z'),
      limitPrice: d('100'),
      side: OrderSide.sell,
      seasonEndAt,
    });
    expect(match?.openTime.toISOString()).toBe('2026-07-22T12:10:00.000Z');
  });

  it('allows a participant-less general order without a season end horizon', () => {
    const match = service.selectTriggerCandleForOrder(
      [candle('2026-07-22T12:05:00.000Z', '80', '100')],
      {
        submittedAt: new Date('2026-07-22T12:00:00.000Z'),
        limitPrice: d('100'),
        side: OrderSide.sell,
        seasonEndAt: null,
      },
    );
    expect(match?.openTime.toISOString()).toBe('2026-07-22T12:05:00.000Z');
  });
});
