jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<{
    Decimal: unknown;
    sqltag: unknown;
    join: unknown;
    raw: unknown;
    empty: unknown;
  }>('@prisma/client/runtime/client');
  return {
    Prisma: {
      Decimal: runtime.Decimal,
      sql: runtime.sqltag,
      join: runtime.join,
      raw: runtime.raw,
      empty: runtime.empty,
    },
    PrismaClient: class PrismaClient {},
  };
});

import { MarketCandleIngestionService } from './market-candle-ingestion.service';
import { KisCandleNormalizerService } from '../providers/kis/candles/kis-candle-normalizer.service';
import { KisDomesticFiveMinuteBuilder } from '../providers/kis/candles/kis-domestic-five-minute.builder';

const domesticRow = (minute: number) => ({
  value: {
    stck_bsop_date: '20260710',
    stck_cntg_hour: `090${minute}00`,
    stck_oprc: '100',
    stck_hgpr: '102',
    stck_lwpr: '99',
    stck_prpr: '101',
    cntg_vol: '10',
    cntg_tr_pbmn: '1000',
  },
  receivedAt: new Date('2026-07-10T00:06:00Z'),
  sequence: minute,
});

// 2026-07-09 is an ordinary US trading day (Thursday, EDT): the regular
// session is 13:30–20:00 UTC.
const usRow = (
  time: string,
  overrides: Record<string, unknown> = {},
  sequence = 0,
) => ({
  value: {
    xymd: '20260709',
    xhms: time,
    open: '100',
    high: '102',
    low: '99',
    last: '101',
    evol: '10',
    eamt: '1000',
    ...overrides,
  },
  receivedAt: new Date('2026-07-09T20:10:00Z'),
  sequence,
});

describe('MarketCandleIngestionService', () => {
  const input = {
    asset: { id: 'asset-1', symbol: '005930', marketCode: 'J' },
    from: new Date('2026-07-10T00:00:00Z'),
    to: new Date('2026-07-10T00:10:00Z'),
    now: new Date('2026-07-10T00:06:00Z'),
  };

  const create = (
    overrides: { domestic?: object; repository?: object } = {},
  ) => {
    const domestic = {
      fetchDomesticOneMinuteRows: jest.fn().mockResolvedValue({
        pagesFetched: 2,
        providerReturnedRows: 5,
        rows: [0, 1, 2, 3, 4].map(domesticRow),
        duplicateRows: 0,
        complete: true,
        stopReason: 'target_reached',
        oldestOpenTime: new Date('2026-07-10T00:00:00Z'),
        latestOpenTime: new Date('2026-07-10T00:04:00Z'),
        ...overrides.domestic,
      }),
    };
    const usAdapter = { fetchUsFiveMinuteRows: jest.fn() };
    const repository = {
      upsertMany: jest.fn().mockResolvedValue({ writtenCount: 1 }),
      ...overrides.repository,
    };
    const cache = {
      invalidateAsset: jest
        .fn()
        .mockResolvedValue({ status: 'invalidated', generation: 1 }),
    };
    const service = new MarketCandleIngestionService(
      domestic as never,
      usAdapter as never,
      new KisCandleNormalizerService(),
      new KisDomesticFiveMinuteBuilder(),
      repository as never,
      cache as never,
    );
    return { service, repository, cache };
  };

  it('writes only canonical 5m rows and returns complete ingestion metadata', async () => {
    const { service, repository, cache } = create();
    const result = await service.ingestDomesticFiveMinuteCandles(input);
    expect(result).toMatchObject({
      provider: 'kis_domestic_minute',
      assetId: 'asset-1',
      pagesFetched: 2,
      acceptedRows: 5,
      writtenRows: 1,
      complete: true,
      stopReason: 'target_reached',
      completeBuckets: 1,
      incompleteBuckets: 0,
    });
    expect(repository.upsertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        assetId: 'asset-1',
        interval: '5m',
        sourceProvider: 'kis_domestic_minute',
        isClosed: true,
      }),
    ]);
    expect(cache.invalidateAsset).toHaveBeenCalledWith('asset-1');
  });

  it('returns explicit incomplete metadata and does not write when all rows are malformed', async () => {
    const { service, repository } = create({
      domestic: {
        rows: [{ value: {}, receivedAt: new Date(), sequence: 0 }],
        providerReturnedRows: 1,
        stopReason: 'malformed_response',
        complete: false,
      },
    });
    await expect(
      service.ingestDomesticFiveMinuteCandles(input),
    ).resolves.toMatchObject({
      writtenRows: 0,
      complete: false,
      stopReason: 'malformed_response',
    });
    expect(repository.upsertMany).not.toHaveBeenCalled();
  });

  it('propagates repository failure instead of returning successful metadata', async () => {
    const { service, cache } = create({
      repository: {
        upsertMany: jest.fn().mockRejectedValue(new Error('write failed')),
      },
    });
    await expect(
      service.ingestDomesticFiveMinuteCandles(input),
    ).rejects.toThrow('write failed');
    expect(cache.invalidateAsset).not.toHaveBeenCalled();
  });

  it('does not turn an empty provider page into a successful zero-row ingestion', async () => {
    const { service, repository } = create({
      domestic: {
        rows: [],
        providerReturnedRows: 0,
        stopReason: 'empty_page',
        complete: false,
      },
    });
    await expect(
      service.ingestDomesticFiveMinuteCandles(input),
    ).resolves.toMatchObject({
      writtenRows: 0,
      complete: false,
      stopReason: 'empty_page',
    });
    expect(repository.upsertMany).not.toHaveBeenCalled();
  });

  it('does not claim a domestic range complete when a historical bucket is incomplete', async () => {
    const { service } = create({
      domestic: {
        rows: [0, 1, 3, 4].map(domesticRow),
        providerReturnedRows: 4,
      },
    });
    const result = await service.fetchDomesticFiveMinuteCandles(input);
    expect(result).toMatchObject({
      complete: false,
      completeBuckets: 0,
      incompleteBuckets: 1,
    });
  });

  describe('US data completeness through the real normalizer', () => {
    const usInput = {
      asset: { id: 'us-1', symbol: 'AAPL', marketCode: 'NAS' },
      from: new Date('2026-07-09T13:30:00Z'),
      to: new Date('2026-07-09T13:45:00Z'),
      now: new Date('2026-07-10T00:00:00Z'),
    };
    const createUs = (adapterResult: {
      rows: ReturnType<typeof usRow>[];
      providerReturnedRows: number;
    }) => {
      const usAdapter = {
        fetchUsFiveMinuteRows: jest.fn().mockResolvedValue({
          pagesFetched: 1,
          duplicateRows: 0,
          complete: true,
          stopReason: 'target_reached',
          oldestOpenTime: usInput.from,
          latestOpenTime: new Date('2026-07-09T13:40:00Z'),
          ...adapterResult,
        }),
      };
      const service = new MarketCandleIngestionService(
        { fetchDomesticOneMinuteRows: jest.fn() } as never,
        usAdapter as never,
        new KisCandleNormalizerService(),
        new KisDomesticFiveMinuteBuilder(),
        { upsertMany: jest.fn() } as never,
        { invalidateAsset: jest.fn() } as never,
      );
      return service;
    };

    it('never declares complete when a regular-session row fails strict validation, even with accepted rows', async () => {
      // The provider sweep reached its target (adapter.complete=true) and
      // two of three regular-session buckets are valid — but the malformed
      // 13:35 bucket is an observable hole, so the range is NOT complete.
      const service = createUs({
        rows: [
          usRow('093000'),
          usRow('093500', { high: '90' }, 1),
          usRow('094000', {}, 2),
        ],
        providerReturnedRows: 3,
      });
      const result = await service.fetchUsFiveMinuteCandles(usInput);
      expect(result).toMatchObject({
        complete: false,
        acceptedRows: 2,
        integrityFailedRows: 1,
        stopReason: 'target_reached',
      });
      expect(result.candles).toHaveLength(2);
    });

    it('keeps complete=true when only benign pre/after-hours rows are excluded', async () => {
      const service = createUs({
        rows: [
          usRow('090000'), // pre-market: benign
          usRow('093000', {}, 1),
          usRow('093500', {}, 2),
          usRow('094000', {}, 3),
          usRow('163000', {}, 4), // after-hours: benign
        ],
        providerReturnedRows: 5,
      });
      const result = await service.fetchUsFiveMinuteCandles(usInput);
      expect(result).toMatchObject({
        complete: true,
        acceptedRows: 3,
        rejectedRows: 2,
        integrityFailedRows: 0,
      });
    });
  });
});
