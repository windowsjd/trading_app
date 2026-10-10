jest.mock('../market-snapshot-health.service', () => ({
  MarketSnapshotHealthService: class {},
}));
jest.mock('../../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<{
      Decimal: typeof import('@prisma/client/runtime/client').Decimal;
    }>('@prisma/client/runtime/client').Decimal,
  },
  PrismaClient: class {},
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  AssetType: { domestic_stock: 'domestic_stock' },
  AssetPriceSourceType: { provider_api: 'provider_api' },
}));
import type { KoscomClient, KoscomResponse } from './koscom.client';
import type { Prisma } from '../../generated/prisma/client';
import { randomUUID } from 'node:crypto';
import { KoscomIngestionService } from './koscom-ingestion.service';
import { KoscomMarketMapService } from './koscom-market-map.service';
import { KoscomError, readKoscomConfig } from './koscom.config';
import { readAssetListTurnover } from '../../assets/asset-list-turnover';
import { normalizeMarketPriceEvent } from '../market-price-event.service';

const now = new Date('2026-09-30T01:00:01Z');
function create(count = 1) {
  const assets = Array.from({ length: count }, (_, i) => ({
    id: `a${i}`,
    symbol: String(i + 1).padStart(6, '0'),
    market: 'KRX',
  }));
  const prisma = {
    asset: { findMany: jest.fn().mockResolvedValue(assets) },
    assetPriceSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn<
          Promise<{ id: string }>,
          [{ data: Prisma.AssetPriceSnapshotUncheckedCreateInput }]
        >()
        .mockResolvedValue({ id: 'p' }),
    },
    assetOrderbookSnapshot: {
      create: jest.fn().mockResolvedValue({ id: 'b' }),
    },
  };
  const key = randomUUID();
  const config = {
    getConfig: () =>
      readKoscomConfig({
        KOSCOM_API_KEY: key,
        PROVIDER_INGESTION_ENABLED: 'true',
      }),
  };
  const client = {
    get: jest.fn<Promise<KoscomResponse>, Parameters<KoscomClient['get']>>(),
    batch: jest.fn((batch: { targets: { symbol: string }[] }, kind: string) =>
      Promise.resolve({
        receivedAt: now,
        rows: batch.targets.map((t) =>
          kind === 'price'
            ? {
                isuSrtCd: t.symbol,
                trdPrc: '70000',
                cmpprevddPrc: '1000',
                cmpprevddTpCd: '2',
                trdTm: '10000000',
                accTrdvol: '7',
                accTrdval: '1234567890123456789012',
              }
            : {
                isuSrtCd: t.symbol,
                askStep1BstordPrc: '70100',
                bidStep1BstordPrc: '69900',
                askStep1BstordRqty: '10',
                bidStep1BstordRqty: '20',
              },
        ),
      }),
    ),
  };
  const markets = { resolve: jest.fn().mockResolvedValue('kospi') };
  const locks = {
    acquire: jest.fn().mockResolvedValue({
      status: 'acquired',
      lock: { key: 'lease', token: 'owner', ttlMs: 60000 },
    }),
    extend: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(true),
  };
  const redis = {
    publish: jest.fn<Promise<number>, [string, string]>().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    setWithTtl: jest
      .fn<Promise<void>, [string, string, number]>()
      .mockResolvedValue(undefined),
  };
  const events = { publish: jest.fn() };
  const health = { checkActiveAssetCoverage: jest.fn() };
  const service = new KoscomIngestionService(
    prisma as never,
    config as never,
    client as never,
    markets as never,
    locks as never,
    redis as never,
    events as never,
    health as never,
  );
  return {
    service,
    prisma,
    config,
    client,
    markets,
    locks,
    redis,
    events,
    health,
  };
}
describe('KOSCOM central ingestion', () => {
  it('writes PostgreSQL evidence and publishes the existing canonical Redis event', async () => {
    const h = create();
    const result = await h.service.collect({ now });
    expect(result.created).toBe(2);
    const data = h.prisma.assetPriceSnapshot.create.mock.calls[0][0].data;
    expect(data.sourceName).toBe('koscom_krx_realtime_price');
    expect(data.price).toBe('70000.00000000');
    expect((data.sourceTimestamp as Date).toISOString()).toBe(
      '2026-09-30T01:00:00.000Z',
    );
    expect(
      readAssetListTurnover({
        sourceType: data.sourceType,
        sourceName: data.sourceName ?? null,
        rawPayloadJson: data.rawPayloadJson,
      }).turnover,
    ).toBe('1234567890123456789012');
    const event = normalizeMarketPriceEvent(
      JSON.parse(h.redis.publish.mock.calls[0][1]),
    );
    expect(event?.type).toBe('market_price');
    expect(event?.delayed).toBe(false);
    expect(h.events.publish).not.toHaveBeenCalled();
    expect(h.locks.release).toHaveBeenCalledTimes(1);
  });
  it('limits per-market batches, preserves successful groups when another fails', async () => {
    const h = create(43);
    h.client.batch.mockRejectedValueOnce(new KoscomError('KOSCOM_TIMEOUT'));
    const result = await h.service.collect({ now });
    expect(h.client.batch.mock.calls.map((c) => c[0].targets.length)).toEqual([
      20, 20, 20, 20, 3, 3,
    ]);
    expect(result.success).toBe(false);
    expect(result.failed).toBe(20);
    expect(result.created).toBe(66);
  });
  it('rejects missing and duplicate symbols rather than inventing prices', async () => {
    const h = create(2);
    h.client.batch.mockResolvedValueOnce({
      receivedAt: now,
      rows: [{ isuSrtCd: '000001' }, { isuSrtCd: '000001' }],
    } as never);
    const result = await h.service.collect({ now });
    expect(result.failed).toBe(2);
    expect(h.prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
    expect(
      result.snapshots.filter((s) => s.kind === 'price').map((s) => s.reason),
    ).toEqual(['KOSCOM_DUPLICATE_SYMBOL', 'KOSCOM_MISSING_SYMBOL']);
  });
  it('never refreshes duplicate or older provider timestamps', async () => {
    const h = create();
    h.prisma.assetPriceSnapshot.findFirst.mockResolvedValue({
      effectiveAt: now,
    });
    const result = await h.service.collect({ now });
    expect(result.skipped).toBe(1);
    expect(h.prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
    expect(h.redis.publish).not.toHaveBeenCalled();
  });
  it('dry run validates data but does not write or broadcast', async () => {
    const h = create();
    const result = await h.service.collect({ now, dryRun: true });
    expect(result.wouldCreate).toBe(2);
    expect(h.prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
    expect(h.prisma.assetOrderbookSnapshot.create).not.toHaveBeenCalled();
    expect(h.redis.publish).not.toHaveBeenCalled();
  });
  it('enforces maxSnapshots across parallel requests', async () => {
    const h = create(43);
    const result = await h.service.collect({ now, maxSnapshots: 1 });
    expect(result.created).toBe(1);
    expect(result.skipped).toBe(85);
  });
  it('checks distributed ownership again before writing and stops after lease loss', async () => {
    const h = create();
    h.locks.extend.mockResolvedValue(false);
    const result = await h.service.collect({ now });
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('KOSCOM_LOCK_LOST');
    expect(h.prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
    expect(h.prisma.assetOrderbookSnapshot.create).not.toHaveBeenCalled();
    expect(h.redis.publish).not.toHaveBeenCalled();
  });
  it('does not call externally when disabled, market closed, or lease busy', async () => {
    const h = create();
    h.config.getConfig = () => readKoscomConfig({});
    expect((await h.service.collect({ now })).errorCode).toBe(
      'KOSCOM_DISABLED',
    );
    expect(h.client.batch).not.toHaveBeenCalled();
    const closed = create();
    expect(
      (await closed.service.collect({ now: new Date('2026-10-03T10:00:00Z') }))
        .errorCode,
    ).toBe('MARKET_CLOSED_EXPECTED_NO_DATA');
    expect(closed.markets.resolve).not.toHaveBeenCalled();
    const busy = create();
    busy.locks.acquire.mockResolvedValue({ status: 'busy' });
    expect((await busy.service.collect({ now })).errorCode).toBe(
      'KOSCOM_COLLECTION_BUSY',
    );
    expect(busy.client.batch).not.toHaveBeenCalled();
  });
  it('recovers only a dated completed-session close and rechecks coverage without emitting a realtime tick', async () => {
    const h = closing();
    const result = await h.service.collect({ now: h.closedAt });
    expect(result.created).toBe(1);
    expect(result.success).toBe(true);
    expect(h.client.get).toHaveBeenCalledWith(
      '/v3/market/closed/kospi/000001/history',
      {
        trnsmCycleTpCd: 'D',
        inqStrtDd: '20260930',
        inqEndDd: '20260930',
        reqCnt: '1',
      },
    );
    expect(
      h.prisma.assetPriceSnapshot.create.mock.calls[0][0].data,
    ).toMatchObject({
      sourceName: 'koscom_krx_realtime_price',
      sourceTimestamp: null,
      effectiveAt: new Date('2026-09-30T06:30:00Z'),
      price: '70000',
      capturedAt: h.closedAt,
    });
    expect(h.health.checkActiveAssetCoverage).toHaveBeenCalledTimes(2);
    expect(h.redis.publish).not.toHaveBeenCalled();
    expect(h.client.batch).not.toHaveBeenCalled();
    expect(h.redis.setWithTtl.mock.calls[0][2]).toBe(21600);
  });
  it('rejects a different closing business date and retries incomplete coverage later', async () => {
    const h = closing('20260929');
    h.health.checkActiveAssetCoverage.mockResolvedValue({ assets: [h.asset] });
    const result = await h.service.collect({ now: h.closedAt });
    expect(result.errorCode).toBe('KOSCOM_CLOSE_RECOVERY_INCOMPLETE');
    expect(result.snapshots[0].reason).toBe('KOSCOM_CLOSE_DATE_MISMATCH');
    expect(h.prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
    expect(h.redis.setWithTtl.mock.calls[0][2]).toBe(60);
  });
  it('does not recover when coverage is already present or write during a closing dry run', async () => {
    const complete = closing();
    complete.health.checkActiveAssetCoverage
      .mockReset()
      .mockResolvedValue({ assets: [] });
    expect(
      (await complete.service.collect({ now: complete.closedAt })).created,
    ).toBe(0);
    expect(complete.client.get).not.toHaveBeenCalled();
    const dry = closing();
    expect(
      (await dry.service.collect({ now: dry.closedAt, dryRun: true }))
        .wouldCreate,
    ).toBe(1);
    expect(dry.prisma.assetPriceSnapshot.create).not.toHaveBeenCalled();
    expect(dry.redis.setWithTtl).not.toHaveBeenCalled();
  });
});

function closing(date = '20260930') {
  const h = create(),
    closedAt = new Date('2026-09-30T07:00:00Z');
  const asset = {
    assetId: 'a0',
    symbol: '000001',
    market: 'KRX',
    assetType: 'domestic_stock',
    state: 'unavailable',
  };
  h.health.checkActiveAssetCoverage
    .mockResolvedValueOnce({ assets: [asset] })
    .mockResolvedValue({ assets: [{ ...asset, state: 'available' }] });
  h.client.get.mockResolvedValue({
    receivedAt: closedAt,
    result: {
      isuSrtCd: '000001',
      hisLists: [
        {
          trdDd: date,
          opnprc: '69500',
          hgprc: '70100',
          lwprc: '69000',
          trdPrc: '70000',
          accTrdvol: '10',
          accTrdval: '700000',
        },
      ],
    },
  });
  return { ...h, closedAt, asset };
}

describe('KOSCOM market resolution', () => {
  it('keeps proven KOSPI membership usable when another market list fails', async () => {
    const client = {
      get: jest.fn((path: string) =>
        path.includes('/kospi/')
          ? Promise.resolve({ result: { isuLists: [{ isuSrtCd: '005930' }] } })
          : Promise.reject(new KoscomError('KOSCOM_HTTP_FAILED')),
      ),
    };
    const redis = {
      get: () => Promise.resolve(null),
      setWithTtl: () => Promise.resolve(),
    };
    const map = new KoscomMarketMapService(
      client as never,
      redis as never,
      { getConfig: () => ({ enabled: true, namespace: 'test' }) } as never,
    );
    expect(await map.resolve('005930', 'KRX')).toBe('kospi');
    await expect(map.resolve('086520', 'KRX')).rejects.toThrow(
      'KOSCOM_MARKET_UNRESOLVED',
    );
    expect(client.get).toHaveBeenCalledTimes(3);
  });
  it('backs off a failed list load across assets and observes cancellation without issuing a request', async () => {
    const client = {
      get: jest.fn().mockRejectedValue(new KoscomError('KOSCOM_AUTH_FAILED')),
    };
    const map = new KoscomMarketMapService(
      client as never,
      { get: () => Promise.resolve(null) } as never,
      { getConfig: () => ({ enabled: true, namespace: 'test' }) } as never,
    );
    await expect(map.resolve('005930', 'KRX')).rejects.toThrow(
      'KOSCOM_AUTH_FAILED',
    );
    await expect(map.resolve('086520', 'KRX')).rejects.toThrow(
      'KOSCOM_AUTH_FAILED',
    );
    expect(client.get).toHaveBeenCalledTimes(3);
    const abort = new AbortController();
    abort.abort();
    await expect(map.resolve('005930', 'KRX', abort.signal)).rejects.toThrow(
      'KOSCOM_CANCELED',
    );
    expect(client.get).toHaveBeenCalledTimes(3);
  });
  it('uses official lists without mutating the KRX asset universe and shares concurrent loads', async () => {
    const client = {
      get: jest.fn((path: string) =>
        Promise.resolve({
          result: {
            isuLists: [
              {
                isuSrtCd: path.includes('kospi')
                  ? '005930'
                  : path.includes('kosdaq')
                    ? '086520'
                    : '000001',
              },
            ],
          },
        }),
      ),
    };
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      setWithTtl: jest
        .fn<Promise<void>, [string, string, number]>()
        .mockResolvedValue(undefined),
    };
    const config = { getConfig: () => ({ enabled: true, namespace: 'test' }) };
    const map = new KoscomMarketMapService(
      client as never,
      redis as never,
      config as never,
    );
    expect(
      await Promise.all([
        map.resolve('005930', 'KRX'),
        map.resolve('086520', 'KRX'),
      ]),
    ).toEqual(['kospi', 'kosdaq']);
    expect(client.get).toHaveBeenCalledTimes(3);
    await expect(map.resolve('086520', 'KOSPI')).rejects.toThrow(
      'KOSCOM_MARKET_MISMATCH',
    );
    await expect(map.resolve('999999', 'KRX')).rejects.toThrow(
      'KOSCOM_MARKET_UNRESOLVED',
    );
  });
});
