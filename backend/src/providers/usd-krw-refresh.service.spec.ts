jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    CurrencyCode: { USD: 'USD', KRW: 'KRW' },
    FxRateSourceType: {
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
  };
});

import { Prisma } from '../generated/prisma/client';
import { ProviderHttpError } from './provider.types';
import { UsdKrwRefreshService } from './usd-krw-refresh.service';

const now = new Date('2026-05-07T14:00:00Z');
const exim = 'korea_exim_exchange_rate';
const fallback = 'exchange_rate_api';
const row = (age: number, sourceName = exim) => ({
  id: `${sourceName}-${age}`,
  sourceName,
  sourceType: 'provider_api',
  rate: new Prisma.Decimal('1400'),
  capturedAt: new Date(now.getTime() - age * 1000),
  effectiveAt: new Date(now.getTime() - 86400000),
});
function fixture(age: number | null = 68) {
  const rows = age === null ? [] : [row(age)];
  const prisma = {
    fxRateSnapshot: {
      findMany: jest.fn(({ where }: { where: { sourceName: unknown } }) =>
        rows.filter(
          (r) =>
            typeof where.sourceName !== 'string' ||
            r.sourceName === where.sourceName,
        ),
      ),
    },
  };
  const primary = {
    ensureFreshUsdKrwSnapshot: jest.fn(async () => {
      rows.unshift(row(0));
      await Promise.resolve();
    }),
  };
  const secondary = {
    ingestUsdKrw: jest.fn(async () => {
      rows.unshift(row(0, fallback));
      return await Promise.resolve({ success: true });
    }),
  };
  const service = new UsdKrwRefreshService(
    prisma as never,
    primary as never,
    secondary as never,
  );
  return { service, prisma, rows, primary, secondary };
}
const fail = () =>
  new ProviderHttpError(
    exim,
    'PROVIDER_TIMEOUT',
    'Unsafe raw detail must not be returned',
  );

describe('UsdKrwRefreshService', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(now));
  afterEach(() => jest.useRealTimers());

  it.each([exim, fallback])(
    'reuses fresh %s with no provider call or observation write',
    async (source) => {
      const f = fixture(30);
      f.rows[0].sourceName = source;
      expect(await f.service.prepare('orders_execute')).toEqual({
        attempted: false,
        result: 'already_fresh',
        source,
      });
      expect(f.primary.ensureFreshUsdKrwSnapshot).not.toHaveBeenCalled();
      expect(f.secondary.ingestUsdKrw).not.toHaveBeenCalled();
      expect(f.rows).toHaveLength(1);
    },
  );

  it.each([68, null])(
    'recovers stale/missing (%s) evidence with Korea EXIM at the 60-second policy',
    async (age) => {
      const f = fixture(age);
      expect(await f.service.prepare('orders_execute')).toEqual({
        attempted: true,
        result: 'refreshed',
        source: exim,
      });
      expect(f.primary.ensureFreshUsdKrwSnapshot).toHaveBeenCalledWith({
        now,
        maxAgeSeconds: 60,
      });
      expect(f.secondary.ingestUsdKrw).not.toHaveBeenCalled();
      expect(f.rows[0].capturedAt).toEqual(now);
    },
  );

  it.each(['exception', 'no committed fresh observation'])(
    'falls back when EXIM produces %s',
    async (failure) => {
      const f = fixture();
      f.primary.ensureFreshUsdKrwSnapshot.mockImplementation(async () => {
        if (failure === 'exception') throw fail();
        await Promise.resolve();
      });
      expect(await f.service.prepare('orders_execute')).toEqual({
        attempted: true,
        result: 'refreshed',
        source: fallback,
      });
      expect(f.secondary.ingestUsdKrw).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps unavailable when both providers fail and returns no raw errors/rates', async () => {
    const f = fixture();
    f.primary.ensureFreshUsdKrwSnapshot.mockRejectedValue(fail());
    f.secondary.ingestUsdKrw.mockResolvedValue({ success: false });
    expect(await f.service.prepare('orders_execute')).toEqual({
      attempted: true,
      result: 'unavailable',
      source: null,
    });
    expect(f.rows).toHaveLength(1);
  });

  it('coalesces Orders and FX execution bursts in one process and clears completed work', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.primary.ensureFreshUsdKrwSnapshot.mockImplementation(async () => {
      await gate;
      f.rows.unshift(row(0));
    });
    const requests = Array.from({ length: 30 }, (_, i) =>
      f.service.prepare(i % 2 ? 'orders_execute' : 'fx_execute'),
    );
    release();
    const results = await Promise.all(requests);
    expect(results.every((r) => r.result === 'refreshed')).toBe(true);
    expect(f.primary.ensureFreshUsdKrwSnapshot).toHaveBeenCalledTimes(1);
    expect(await f.service.prepare('fx_execute')).toMatchObject({
      attempted: false,
      result: 'already_fresh',
    });
  });

  it('does not let quote freshness satisfy execute preparation', async () => {
    const f = fixture(68);
    expect(await f.service.prepare('fx_quote')).toMatchObject({
      attempted: false,
    });
    expect(await f.service.prepare('orders_execute')).toMatchObject({
      attempted: true,
    });
  });

  it('propagates storage failures and releases in-flight work for a later request', async () => {
    const f = fixture();
    f.primary.ensureFreshUsdKrwSnapshot.mockRejectedValueOnce(
      new Error('DB unavailable'),
    );
    await expect(f.service.prepare('orders_execute')).rejects.toThrow(
      'DB unavailable',
    );
    expect(await f.service.prepare('orders_execute')).toMatchObject({
      result: 'refreshed',
    });
  });
});
