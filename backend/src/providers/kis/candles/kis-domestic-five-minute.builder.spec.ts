jest.mock('../../../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return { Prisma: { Decimal: runtime.Decimal } };
});

import { Prisma } from '../../../generated/prisma/client';
import { KisDomesticFiveMinuteBuilder } from './kis-domestic-five-minute.builder';
import type { NormalizedKisCandleRow } from './kis-candle.types';

const minute = (
  minuteOffset: number,
  overrides: Partial<NormalizedKisCandleRow> = {},
): NormalizedKisCandleRow => ({
  openTime: new Date(Date.UTC(2026, 6, 10, 0, minuteOffset)),
  open: new Prisma.Decimal(100 + minuteOffset),
  high: new Prisma.Decimal(105 + minuteOffset),
  low: new Prisma.Decimal(99 + minuteOffset),
  close: new Prisma.Decimal(102 + minuteOffset),
  volume: new Prisma.Decimal(10),
  amount: new Prisma.Decimal(1000),
  sourceUpdatedAt: new Date(Date.UTC(2026, 6, 10, 0, minuteOffset, 30)),
  ...overrides,
});

describe('KisDomesticFiveMinuteBuilder', () => {
  const builder = new KisDomesticFiveMinuteBuilder();

  it('combines five rows across arbitrary page ordering into the 09:00 anchored OHLCV bucket', () => {
    const result = builder.build({
      rows: [minute(2), minute(0), minute(4), minute(1), minute(3)],
      now: new Date('2026-07-10T00:06:00Z'),
    });
    expect(result).toMatchObject({ completeBuckets: 1, incompleteBuckets: 0 });
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0].openTime.toISOString()).toBe(
      '2026-07-10T00:00:00.000Z',
    );
    expect(result.candles[0].open.toString()).toBe('100');
    expect(result.candles[0].high.toString()).toBe('109');
    expect(result.candles[0].low.toString()).toBe('99');
    expect(result.candles[0].close.toString()).toBe('106');
    expect(result.candles[0].volume.toString()).toBe('50');
    expect(result.candles[0].amount?.toString()).toBe('5000');
    expect(result.candles[0].isClosed).toBe(true);
  });

  it('does not emit a historical bucket with missing constituents', () => {
    const result = builder.build({
      rows: [minute(0), minute(1), minute(3), minute(4)],
      now: new Date('2026-07-10T00:06:00Z'),
    });
    expect(result).toMatchObject({
      completeBuckets: 0,
      incompleteBuckets: 1,
      candles: [],
    });
  });

  it('emits a contiguous current partial bucket and preserves nullable amount', () => {
    const result = builder.build({
      rows: [minute(0), minute(1, { amount: null }), minute(2)],
      now: new Date('2026-07-10T00:02:30Z'),
    });
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0].isClosed).toBe(false);
    expect(result.candles[0].amount).toBeNull();
  });

  it('does not emit a bucket for a weekend trading date', () => {
    const nextDay = [0, 1, 2, 3, 4].map((offset) =>
      minute(offset, { openTime: new Date(Date.UTC(2026, 6, 11, 0, offset)) }),
    );
    const result = builder.build({
      rows: [...[0, 1, 2, 3, 4].map((offset) => minute(offset)), ...nextDay],
      now: new Date('2026-07-11T01:00:00Z'),
    });
    expect(result.candles).toHaveLength(1);
    expect(result.rejectedBuckets).toBeGreaterThan(0);
  });

  it('uses the delayed 10:00 open as the first bucket anchor', () => {
    const rows = [0, 1, 2, 3, 4].map((offset) =>
      minute(offset, {
        openTime: new Date(Date.UTC(2026, 0, 2, 1, offset)),
        sourceUpdatedAt: new Date(Date.UTC(2026, 0, 2, 1, offset, 30)),
      }),
    );
    const result = builder.build({
      rows: [
        minute(0, { openTime: new Date('2026-01-02T00:00:00.000Z') }),
        ...rows,
      ],
      now: new Date('2026-01-02T01:06:00.000Z'),
    });
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0].openTime.toISOString()).toBe(
      '2026-01-02T01:00:00.000Z',
    );
  });

  it('keeps the 16:25 final bucket on the 16:30 KRX session', () => {
    const rows = [0, 1, 2, 3, 4].map((offset) =>
      minute(offset, {
        openTime: new Date(Date.UTC(2026, 10, 19, 7, 25 + offset)),
        sourceUpdatedAt: new Date(Date.UTC(2026, 10, 19, 7, 25 + offset, 30)),
      }),
    );
    const result = builder.build({
      rows,
      now: new Date('2026-11-19T07:31:00.000Z'),
    });
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0].closeTime.toISOString()).toBe(
      '2026-11-19T07:30:00.000Z',
    );
    expect(result.candles[0].isClosed).toBe(true);
  });

  it('does not create a candle on the 2026-07-17 KRX holiday', () => {
    const rows = [0, 1, 2, 3, 4].map((offset) =>
      minute(offset, {
        openTime: new Date(Date.UTC(2026, 6, 17, 0, offset)),
      }),
    );
    const result = builder.build({
      rows,
      now: new Date('2026-07-17T01:00:00.000Z'),
    });
    expect(result.candles).toEqual([]);
  });

  it('deterministically keeps the latest duplicate minute instead of rejecting the bucket', () => {
    const duplicate = minute(2, {
      close: new Prisma.Decimal(103.5),
      sourceUpdatedAt: new Date('2026-07-10T00:10:00Z'),
    });
    const result = builder.build({
      rows: [...[0, 1, 2, 3, 4].map((offset) => minute(offset)), duplicate],
      now: new Date('2026-07-10T00:20:00Z'),
    });
    expect(result.candles).toHaveLength(1);
    expect(result.completeBuckets).toBe(1);
  });
});
