jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
  PrismaClient: class PrismaClient {},
}));
import { Prisma, type AssetType } from '../generated/prisma/client';
import { DailyChangeRateService } from './daily-change-rate.service';

const krx = {
  id: 'samsung',
  assetType: 'domestic_stock' as AssetType,
  market: 'KRX',
};
const crypto = {
  id: 'btc',
  assetType: 'crypto' as AssetType,
  market: 'BINANCE',
};
const day = 86_400_000;
function candle(open: string, provider = 'kis', close = '100') {
  const openTime = new Date(open);
  const closeTime = new Date(openTime.getTime() + day);
  return {
    assetId: provider === 'kis' ? krx.id : crypto.id,
    interval: '1d',
    openTime,
    closeTime,
    sourceUpdatedAt: closeTime,
    sourceProvider: provider,
    isClosed: true,
    open: new Prisma.Decimal('100'),
    high: new Prisma.Decimal('200'),
    low: new Prisma.Decimal('50'),
    close: new Prisma.Decimal(close),
  };
}
function setup(rows: unknown[]) {
  const findRange = jest.fn().mockResolvedValue(rows);
  return {
    findRange,
    service: new DailyChangeRateService({ findRange } as never),
  };
}

describe('canonical daily return', () => {
  afterEach(() => jest.useRealTimers());
  it.each([
    [
      'Monday opening',
      '2026-06-22T00:00:00Z',
      '2026-06-22T00:00:00Z',
      '2026-06-18T15:00:00Z',
    ],
    [
      'Monday intraday',
      '2026-06-22T03:00:00Z',
      '2026-06-22T03:00:00Z',
      '2026-06-18T15:00:00Z',
    ],
    [
      'Monday after close',
      '2026-06-22T10:00:00Z',
      '2026-06-22T06:30:00Z',
      '2026-06-18T15:00:00Z',
    ],
    [
      'Saturday retains Friday return',
      '2026-06-20T03:00:00Z',
      '2026-06-19T06:30:00Z',
      '2026-06-17T15:00:00Z',
    ],
    [
      'preopen retains Friday return',
      '2026-06-21T23:59:59Z',
      '2026-06-19T06:30:00Z',
      '2026-06-17T15:00:00Z',
    ],
    [
      'July 17 holiday and weekend',
      '2026-07-20T03:00:00Z',
      '2026-07-20T03:00:00Z',
      '2026-07-15T15:00:00Z',
    ],
    [
      'holiday retains Thursday return',
      '2026-07-17T03:00:00Z',
      '2026-07-16T06:30:00Z',
      '2026-07-14T15:00:00Z',
    ],
    [
      'year boundary',
      '2026-01-02T02:00:00Z',
      '2026-01-02T02:00:00Z',
      '2025-12-29T15:00:00Z',
    ],
  ])(
    '%s uses the exact previous actual KRX session daily close',
    async (_, now, priceAt, baseline) => {
      const { service, findRange } = setup([candle(baseline)]);
      expect(
        await service.calculate({
          asset: krx,
          price: '110',
          effectiveAt: new Date(priceAt),
          now: new Date(now),
        }),
      ).toBe('10.00000000');
      expect(findRange).toHaveBeenCalledWith({
        assetId: krx.id,
        interval: '1d',
        from: new Date(baseline),
        to: new Date(Date.parse(baseline) + 1),
      });
    },
  );

  it('uses one fixed UTC daily close across price changes and immediately switches at 09:00 KST', async () => {
    const { service, findRange } = setup([
      candle('2026-06-18T00:00:00Z', 'binance'),
    ]);
    const calculate = (price: string, now: string) =>
      service.calculate({
        asset: crypto,
        price,
        effectiveAt: new Date(now),
        now: new Date(now),
      });
    expect(await calculate('110', '2026-06-19T23:59:59Z')).toBe('10.00000000');
    expect(await calculate('120', '2026-06-19T23:59:59Z')).toBe('20.00000000');
    expect(findRange).toHaveBeenCalledTimes(1);
    findRange.mockResolvedValue([
      candle('2026-06-19T00:00:00Z', 'binance', '120'),
    ]);
    expect(await calculate('126', '2026-06-20T00:00:00Z')).toBe('5.00000000');
    expect(findRange).toHaveBeenLastCalledWith({
      assetId: crypto.id,
      interval: '1d',
      from: new Date('2026-06-19T00:00:00Z'),
      to: new Date('2026-06-19T00:00:00.001Z'),
    });
  });

  it.each([
    'missing',
    'unclosed',
    'wrong day',
    'wrong provider',
    'bad close time',
    'zero',
    'negative',
    'NaN',
    'bad OHLC',
    'future observation',
    'unconfirmed close',
  ])(
    'returns null for %s without substituting another snapshot/day',
    async (reason) => {
      const row = candle('2026-06-18T15:00:00Z');
      if (reason === 'unclosed') row.isClosed = false;
      if (reason === 'wrong day')
        row.openTime = new Date('2026-06-17T15:00:00Z');
      if (reason === 'wrong provider') row.sourceProvider = 'manual';
      if (reason === 'bad close time')
        row.closeTime = new Date(row.closeTime.getTime() - 1);
      if (reason === 'zero') row.close = new Prisma.Decimal(0);
      if (reason === 'negative') row.close = new Prisma.Decimal(-1);
      if (reason === 'NaN') row.close = new Prisma.Decimal(NaN);
      if (reason === 'bad OHLC') row.close = new Prisma.Decimal(201);
      if (reason === 'future observation')
        row.sourceUpdatedAt = new Date('2027-01-01');
      if (reason === 'unconfirmed close')
        row.sourceUpdatedAt = new Date('2026-06-19T05:00:00Z');
      const { service, findRange } = setup(reason === 'missing' ? [] : [row]);
      const now = new Date('2026-06-22T03:00:00Z');
      expect(
        await service.calculate({
          asset: krx,
          price: '110',
          effectiveAt: now,
          now,
        }),
      ).toBeNull();
      expect(findRange).toHaveBeenCalledTimes(1);
    },
  );

  it('fails closed for unknown calendars and price timestamps outside the displayed stock session', async () => {
    const { service, findRange } = setup([]);
    for (const [now, effectiveAt] of [
      ['2030-01-02T03:00:00Z', '2030-01-02T03:00:00Z'],
      ['2026-06-22T03:00:00Z', '2026-06-19T03:00:00Z'],
      ['2026-06-22T03:00:00Z', '2026-06-22T04:00:00Z'],
    ])
      expect(
        await service.calculate({
          asset: krx,
          price: '110',
          now: new Date(now),
          effectiveAt: new Date(effectiveAt),
        }),
      ).toBeNull();
    expect(findRange).not.toHaveBeenCalled();
  });

  it("does not carry yesterday's crypto baseline across UTC midnight when the new closed candle is missing", async () => {
    const { service, findRange } = setup([
      candle('2026-06-18T00:00:00Z', 'binance'),
    ]);
    const before = new Date('2026-06-19T23:59:59Z');
    expect(
      await service.calculate({
        asset: crypto,
        price: '110',
        effectiveAt: before,
        now: before,
      }),
    ).toBe('10.00000000');
    findRange.mockResolvedValue([]);
    const after = new Date('2026-06-20T00:00:00Z');
    expect(
      await service.calculate({
        asset: crypto,
        price: '110',
        effectiveAt: after,
        now: after,
      }),
    ).toBeNull();
    expect(findRange).toHaveBeenCalledTimes(2);
  });

  it('coalesces users/ticks, retries missing daily rows, and does not serve expired evidence on a DB failure', async () => {
    jest.useFakeTimers();
    const now = new Date('2026-06-22T03:00:00Z');
    jest.setSystemTime(now);
    const { service, findRange } = setup([]);
    const input = { asset: krx, price: '110', effectiveAt: now, now };
    expect(
      await Promise.all(
        Array.from({ length: 100 }, () => service.calculate(input)),
      ),
    ).toEqual(Array(100).fill(null));
    expect(findRange).toHaveBeenCalledTimes(1);
    findRange.mockResolvedValue([candle('2026-06-18T15:00:00Z')]);
    jest.advanceTimersByTime(5001);
    expect(await service.calculate(input)).toBe('10.00000000');
    findRange.mockRejectedValue(new Error('database unavailable'));
    jest.advanceTimersByTime(30001);
    expect(await service.calculate(input)).toBeNull();
    expect(findRange).toHaveBeenCalledTimes(3);
  });
});
