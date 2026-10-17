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
import { Logger } from '@nestjs/common';
import { KoscomError, readKoscomConfig } from './koscom.config';
import {
  compareAssetListMetric,
  readAssetListTurnover,
} from '../../assets/asset-list-turnover';
import { normalizeMarketPriceEvent } from '../market-price-event.service';

const now = new Date('2026-09-30T01:00:01Z');
function create(count = 1, env: Record<string, string> = {}, budget?: object) {
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
      create: jest
        .fn<
          Promise<{ id: string }>,
          [{ data: Prisma.AssetOrderbookSnapshotUncheckedCreateInput }]
        >()
        .mockResolvedValue({ id: 'b' }),
    },
  };
  const key = randomUUID();
  const config = {
    getConfig: () =>
      readKoscomConfig({
        KOSCOM_API_KEY: key,
        PROVIDER_INGESTION_ENABLED: 'true',
        // These cases cover the (now opt-in) order-book poll as well; the
        // switch's own case passes 'false'.
        KOSCOM_ORDERBOOK_COLLECTION_ENABLED: 'true',
        ...env,
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
    setNxPx: jest
      .fn<Promise<boolean>, [string, string, number]>()
      .mockResolvedValue(true),
    delete: jest.fn<Promise<number>, [string]>().mockResolvedValue(1),
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
    budget as never,
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
    const disabled = await h.service.collect({ now });
    expect(disabled.errorCode).toBe('KOSCOM_DISABLED');
    expect(disabled.errorMessage).toBe('Background operation failed.');
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
      undefined,
      // Close recovery is a P2 budget category (design v2.1 §7.2).
      { category: 'recover_close' },
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

describe('KOSCOM stage-1 collection switches and instrumentation', () => {
  afterEach(() => jest.restoreAllMocks());

  it('stops the unused order-book poll and storage without changing price rows', async () => {
    const withBook = create(43);
    const withoutBook = create(43, {
      KOSCOM_ORDERBOOK_COLLECTION_ENABLED: 'false',
    });
    await withBook.service.collect({ now });
    const result = await withoutBook.service.collect({ now });
    expect(
      withoutBook.client.batch.mock.calls.every((call) => call[1] === 'price'),
    ).toBe(true);
    expect(withoutBook.client.batch).toHaveBeenCalledTimes(3);
    expect(
      withoutBook.prisma.assetOrderbookSnapshot.create,
    ).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.created).toBe(43);
    const rows = (h: ReturnType<typeof create>) =>
      JSON.stringify(
        h.prisma.assetPriceSnapshot.create.mock.calls
          .map(([{ data }]) =>
            JSON.stringify([
              data.assetId,
              data.price,
              (data.effectiveAt as Date).toISOString(),
            ]),
          )
          .sort(),
      );
    expect(rows(withoutBook) === rows(withBook)).toBe(true);
    expect(withBook.prisma.assetOrderbookSnapshot.create).toHaveBeenCalledTimes(
      43,
    );
  });

  it('writes one poll-log line per price batch only when enabled, without raw payloads', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const quiet = create(21);
    await quiet.service.collect({ now });
    expect(
      log.mock.calls.some((c) => String(c[0]).includes('koscom_poll')),
    ).toBe(false);

    const h = create(21, { KOSCOM_POLL_LOG_ENABLED: 'true' });
    h.client.batch.mockImplementationOnce(() =>
      Promise.reject(new KoscomError('KOSCOM_TIMEOUT')),
    );
    await h.service.collect({ now });
    const lines = log.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes('"koscom_poll"'))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBe(2);
    const failed = lines.find((line) => line.ok === false);
    const succeeded = lines.find((line) => line.ok === true);
    expect(failed?.errorCode).toBe('KOSCOM_TIMEOUT');
    expect(
      (failed?.quotes as unknown[][]).every((quote) => quote[1] === null),
    ).toBe(true);
    // 10:00:00.00 KST trade time of the fixture rows.
    expect((succeeded?.quotes as unknown[][])[0][1]).toBe(
      Date.parse('2026-09-30T01:00:00Z') / 1000,
    );
    expect(
      lines.every((line) => !JSON.stringify(line).includes('accTrdval')),
    ).toBe(true);
  });

  it('emits at most one cycle summary per minute, after the minute ends', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    let clock = Date.parse('2026-09-30T01:00:01.500Z');
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const h = create(2);
    await h.service.collect({ now });
    clock += 3000;
    await h.service.collect({ now });
    const summaries = () =>
      log.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('koscom_price_cycle_summary'));
    expect(summaries().length).toBe(0);
    clock = Date.parse('2026-09-30T01:01:00.100Z');
    await h.service.collect({ now });
    expect(summaries().length).toBe(1);
    const summary = JSON.parse(summaries()[0]) as Record<string, unknown>;
    expect(summary.windowStart).toBe('2026-09-30T01:00:00.000Z');
    expect(summary.cycles).toBe(2);
    expect(summary.completedCycles).toBe(2);
    expect(summary.requests).toBe(4);
    expect(summary.periodMs).toBe(5000);
  });
});

describe('KOSCOM stage-2a slim price raw payload', () => {
  // A realistic multiquote row: the audited fields plus the provider's other
  // descriptive fields that no reader uses.
  const fullRow = (symbol: string, turnover: string) => ({
    isuSrtCd: symbol,
    isuCd: `KR7${symbol}003`,
    isuKorNm: '가나다라마바사아자차카타파하'.repeat(2),
    isuEngNm: 'Sample Electronics Company Limited Common Stock',
    mktNm: 'KOSPI',
    trdDd: '20260930',
    trdTm: '10000000',
    trdPrc: '70000',
    cmpprevddPrc: '1000',
    cmpprevddTpCd: '2',
    flucRt: '1.45',
    opnprc: '69100',
    hgprc: '70500',
    lwprc: '68900',
    accTrdvol: '7',
    accTrdval: turnover,
    listShrs: '5969782550',
    mktcap: '417884778500000',
    bidordPrc_1: '69900',
    askordPrc_1: '70100',
    bidordRqty_1: '1234',
    askordRqty_1: '5678',
    ...Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`ext${i}`, `value-${i}-${symbol}`]),
    ),
  });

  const collectOne = async (slim: boolean, turnover: string) => {
    const h = create(1, slim ? { KOSCOM_PRICE_RAW_SLIM_ENABLED: 'true' } : {});
    h.client.batch.mockImplementation(
      (batch: { targets: { symbol: string }[] }) =>
        Promise.resolve({
          receivedAt: now,
          rows: batch.targets.map((t) => fullRow(t.symbol, turnover)),
        }),
    );
    await h.service.collect({ now });
    return h.prisma.assetPriceSnapshot.create.mock.calls[0][0].data;
  };

  it('keeps the audited fields only, under 0.6 KB, and the turnover the list sort reads', async () => {
    const full = await collectOne(false, '1234567890123456789012');
    const slim = await collectOne(true, '1234567890123456789012');
    const slimRaw = slim.rawPayloadJson as {
      truncated: boolean;
      payload: { payloadProfile?: string; row: Record<string, unknown> };
    };
    expect(slimRaw.truncated).toBe(false);
    expect(slimRaw.payload.payloadProfile).toBe('koscom_price_slim_v1');
    expect(Object.keys(slimRaw.payload.row).sort()).toEqual(
      [
        'accTrdval',
        'accTrdvol',
        'askordPrc_1',
        'bidordPrc_1',
        'cmpprevddPrc',
        'cmpprevddTpCd',
        'isuSrtCd',
        'trdDd',
        'trdPrc',
        'trdTm',
      ].sort(),
    );
    const bytes = (value: unknown) =>
      Buffer.byteLength(JSON.stringify(value), 'utf8');
    expect(bytes(slim.rawPayloadJson) <= 600).toBe(true);
    expect(bytes(slim.rawPayloadJson) < bytes(full.rawPayloadJson) / 2).toBe(
      true,
    );
    // Financial fields are columns and stay identical.
    expect(JSON.stringify(slim.price)).toBe(JSON.stringify(full.price));
    expect((slim.effectiveAt as Date).getTime()).toBe(
      (full.effectiveAt as Date).getTime(),
    );
    const turnover = (data: typeof slim) =>
      readAssetListTurnover({
        sourceType: data.sourceType,
        sourceName: data.sourceName ?? null,
        rawPayloadJson: data.rawPayloadJson,
      }).turnover;
    expect(turnover(slim)).toBe('1234567890123456789012');
    expect(turnover(full)).toBe(turnover(slim));
  });

  it('sorts a mix of pre-change full rows and slim rows exactly like full rows', async () => {
    const turnovers = ['900', '50000000000', '7', '123456789', '1000'];
    const rows = await Promise.all(
      turnovers.map(async (value, i) => ({
        id: `asset-${i}`,
        symbol: String(i + 1).padStart(6, '0'),
        full: await collectOne(false, value),
        // Alternate old/new evidence as it would coexist after the switch.
        mixed: await collectOne(i % 2 === 0, value),
      })),
    );
    const order = (pick: 'full' | 'mixed') =>
      rows
        .map((row) => ({
          id: row.id,
          symbol: row.symbol,
          changeRate: null,
          turnover: readAssetListTurnover({
            sourceType: row[pick].sourceType,
            sourceName: row[pick].sourceName ?? null,
            rawPayloadJson: row[pick].rawPayloadJson,
          }).turnover,
        }))
        .sort((a, b) => compareAssetListMetric(a, b, 'turnover', 'desc'))
        .map((row) => row.id)
        .join(',');
    expect(order('mixed')).toBe(order('full'));
    expect(order('full')).toBe('asset-1,asset-3,asset-4,asset-0,asset-2');
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

describe('KOSCOM 3c price priority lane, price plan and pacing', () => {
  afterEach(() => jest.restoreAllMocks());
  const budget = (permitted = true) => ({
    publishPricePlan: jest.fn().mockResolvedValue(undefined),
    priceSlotPermitted: jest.fn().mockResolvedValue(permitted),
  });

  it('queues every price batch before any order-book batch and holds the lane until the last price response', async () => {
    const h = create(43, { KOSCOM_PRICE_PRIORITY_LANE_ENABLED: 'true' });
    const timeline: string[] = [];
    h.redis.setNxPx.mockImplementation((key: string) => {
      timeline.push(`lane:${key.endsWith(':price-lane') ? 'set' : key}`);
      return Promise.resolve(true);
    });
    h.redis.delete.mockImplementation((key: string) => {
      timeline.push(`lane:${key.endsWith(':price-lane') ? 'released' : key}`);
      return Promise.resolve(1);
    });
    const original = h.client.batch.getMockImplementation()!;
    h.client.batch.mockImplementation((batch, kind) => {
      timeline.push(kind);
      return original(batch, kind);
    });
    const result = await h.service.collect({ now });
    // 43 price + 43 order-book rows, exactly as without the lane.
    expect(result.created).toBe(86);
    const kinds = timeline.filter((e) => !e.startsWith('lane:'));
    expect(kinds).toEqual([
      'price',
      'price',
      'price',
      'orderbook',
      'orderbook',
      'orderbook',
    ]);
    expect(timeline[0]).toBe('lane:set');
    expect(timeline.filter((e) => e === 'lane:released').length).toBe(1);
    const [laneKey, , laneTtl] = h.redis.setNxPx.mock.calls[0];
    expect(laneKey).toBe(`koscom:${h.config.getConfig().namespace}:price-lane`);
    // min(T, 10 s) with the 5 s default cadence.
    expect(laneTtl).toBe(5000);
  });

  it('leaves the request order and Redis untouched without the lane', async () => {
    const h = create(43);
    await h.service.collect({ now });
    expect(h.client.batch.mock.calls.map((call) => call[1])).toEqual([
      'price',
      'orderbook',
      'price',
      'orderbook',
      'price',
      'orderbook',
    ]);
    expect(h.redis.setNxPx).not.toHaveBeenCalled();
  });

  it('publishes the price plan (requests per cycle, period, stocks) every cycle', async () => {
    const b = budget();
    const h = create(43, {}, b);
    await h.service.collect({ now });
    expect(b.publishPricePlan).toHaveBeenCalledWith(
      h.config.getConfig().namespace,
      { batches: 3, periodMs: 5000, assets: 43 },
    );
    // A manual symbol subset never rewrites the plan.
    await h.service.collect({ now, symbols: ['000001'] });
    expect(b.publishPricePlan).toHaveBeenCalledTimes(1);
  });

  it('skips a slot the budget cannot pay for only when enforcement is on', async () => {
    const slot = { slot: 1, periodMs: 3000, now };
    const paced = budget(false);
    const enforced = create(
      1,
      {
        KOSCOM_PRICE_SLOT_ENABLED: 'true',
        KOSCOM_BUDGET_ENFORCEMENT_ENABLED: 'true',
      },
      paced,
    );
    const result = await enforced.service.collectSlot(slot);
    expect(result.errorCode).toBe('KOSCOM_BUDGET_PACING');
    expect(enforced.redis.setNxPx).not.toHaveBeenCalled();
    expect(enforced.client.batch).not.toHaveBeenCalled();

    const observing = budget(false);
    const off = create(1, { KOSCOM_PRICE_SLOT_ENABLED: 'true' }, observing);
    await off.service.collectSlot(slot);
    expect(observing.priceSlotPermitted).not.toHaveBeenCalled();
    expect(off.client.batch).toHaveBeenCalled();
  });
});
