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
import { Logger } from '@nestjs/common';
import { KoscomIngestionService } from './koscom-ingestion.service';
import { runWithKoscomCallCategory } from './koscom-call-context';
import { KoscomMarketMapService } from './koscom-market-map.service';
import { KoscomError, readKoscomConfig } from './koscom.config';

/**
 * In-memory Redis subset with a controllable clock. The services compare
 * pause deadlines with Date.now(), which every test pins to this clock.
 */
class MemoryRedis {
  now = Date.parse('2026-09-30T01:00:01Z');
  constructor() {
    jest.spyOn(Date, 'now').mockImplementation(() => this.now);
  }
  readonly values = new Map<string, { value: string; expiresAt: number }>();
  private alive(key: string) {
    const entry = this.values.get(key);
    if (entry && entry.expiresAt <= this.now) this.values.delete(key);
    return this.values.get(key);
  }
  get = jest.fn((key: string) =>
    Promise.resolve(this.alive(key)?.value ?? null),
  );
  setWithTtl = jest.fn((key: string, value: string, seconds: number) => {
    this.values.set(key, { value, expiresAt: this.now + seconds * 1000 });
    return Promise.resolve();
  });
  setNxPx = jest.fn((key: string, value: string, ttlMs: number) => {
    if (this.alive(key)) return Promise.resolve(false);
    this.values.set(key, { value, expiresAt: this.now + ttlMs });
    return Promise.resolve(true);
  });
  increment = jest.fn((key: string) => {
    const next = Number(this.alive(key)?.value ?? '0') + 1;
    this.values.set(key, {
      value: String(next),
      expiresAt: this.alive(key)?.expiresAt ?? Number.MAX_SAFE_INTEGER,
    });
    return Promise.resolve(next);
  });
  expire = jest.fn((key: string, seconds: number) => {
    const entry = this.alive(key);
    if (entry) entry.expiresAt = this.now + seconds * 1000;
    return Promise.resolve(Boolean(entry));
  });
  delete = jest.fn((key: string) =>
    Promise.resolve(this.values.delete(key) ? 1 : 0),
  );
  publish = jest.fn().mockResolvedValue(1);
}

const KEY = 'retry-caps-key';
const namespace = readKoscomConfig({ KOSCOM_API_KEY: KEY }).namespace;

function ingestion(env: Record<string, string>, redis = new MemoryRedis()) {
  const config = {
    getConfig: () =>
      readKoscomConfig({
        KOSCOM_API_KEY: KEY,
        PROVIDER_INGESTION_ENABLED: 'true',
        KOSCOM_ORDERBOOK_COLLECTION_ENABLED: 'false',
        KOSCOM_CYCLE_METRICS_ENABLED: 'false',
        ...env,
      }),
  };
  type Batch = { targets: { symbol: string }[] };
  type Reply = { receivedAt: Date; rows: Record<string, unknown>[] };
  const client = {
    batch: jest.fn<
      Promise<Reply>,
      [Batch, string, AbortSignal?, { retries?: number }?]
    >((batch) =>
      Promise.resolve({
        receivedAt: new Date(redis.now),
        rows: batch.targets.map((t) => ({
          isuSrtCd: t.symbol,
          trdPrc: '70000',
          cmpprevddPrc: '0',
          cmpprevddTpCd: '3',
          trdTm: '10000000',
          accTrdvol: '1',
          accTrdval: '70000',
        })),
      }),
    ),
    get: jest.fn(),
  };
  const prisma = {
    asset: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'a0', symbol: '000001', market: 'KRX' }]),
    },
    assetPriceSnapshot: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'p' }),
    },
    assetOrderbookSnapshot: { create: jest.fn() },
  };
  const locks = {
    acquire: jest.fn().mockResolvedValue({
      status: 'acquired',
      lock: { key: 'lease', token: 'owner', ttlMs: 60000 },
    }),
    extend: jest.fn().mockResolvedValue(true),
    release: jest.fn().mockResolvedValue(true),
  };
  const health = { checkActiveAssetCoverage: jest.fn() };
  const service = new KoscomIngestionService(
    prisma as never,
    config as never,
    client as never,
    { resolve: jest.fn().mockResolvedValue('kospi') } as never,
    locks as never,
    redis as never,
    { publish: jest.fn() } as never,
    health as never,
  );
  return { service, client, prisma, health, redis };
}

describe('KOSCOM 2c price retry caps', () => {
  afterEach(() => jest.restoreAllMocks());

  it('asks for zero in-cycle price retries only when capped', async () => {
    const legacy = ingestion({});
    await legacy.service.collect({ now: new Date(legacy.redis.now) });
    expect(legacy.client.batch.mock.calls[0][3]).toEqual({});
    const capped = ingestion({ KOSCOM_PRICE_RETRY_CAPS_ENABLED: 'true' });
    await capped.service.collect({ now: new Date(capped.redis.now) });
    expect(capped.client.batch.mock.calls[0][3]).toEqual({ retries: 0 });
  });

  it('pauses the cluster 15/30/60 s after 3+ fully failed cycles and resumes on success', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const h = ingestion({ KOSCOM_PRICE_RETRY_CAPS_ENABLED: 'true' });
    h.client.batch.mockRejectedValue(new KoscomError('KOSCOM_TIMEOUT', true));
    const cycle = async () => {
      h.redis.now += 3000;
      return h.service.collect({ now: new Date(h.redis.now) });
    };
    for (let i = 0; i < 3; i++) await cycle();
    expect(h.client.batch).toHaveBeenCalledTimes(3);
    // Paused: no provider call inside the 15 s window.
    const paused = await cycle();
    expect(paused.errorCode).toBe('KOSCOM_PRICE_BACKOFF');
    expect(h.client.batch).toHaveBeenCalledTimes(3);
    h.redis.now += 15_000;
    await cycle(); // 4th failure → 30 s
    expect(h.client.batch).toHaveBeenCalledTimes(4);
    const until = Number(
      h.redis.values.get(`koscom:${namespace}:price-backoff-until`)?.value,
    );
    expect(until - h.redis.now).toBe(30_000);
    // Recovery: the next allowed cycle succeeds and clears the streak.
    h.redis.now = until;
    h.client.batch.mockImplementation((batch) =>
      Promise.resolve({
        receivedAt: new Date(h.redis.now),
        rows: batch.targets.map((t) => ({
          isuSrtCd: t.symbol,
          trdPrc: '70000',
          cmpprevddPrc: '0',
          cmpprevddTpCd: '3',
          trdTm: hhmmss(h.redis.now),
          accTrdvol: '1',
          accTrdval: '70000',
        })),
      }),
    );
    const recovered = await cycle();
    expect(recovered.success).toBe(true);
    expect(h.redis.values.has(`koscom:${namespace}:price-fail-streak`)).toBe(
      false,
    );
    const backoffs = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('koscom_price_backoff'));
    expect(backoffs.length).toBe(2);
  });

  it('never pauses collection when the caps are off', async () => {
    const h = ingestion({});
    h.client.batch.mockRejectedValue(new KoscomError('KOSCOM_TIMEOUT', true));
    for (let i = 0; i < 6; i++) {
      h.redis.now += 3000;
      await h.service.collect({ now: new Date(h.redis.now) });
    }
    expect(h.client.batch).toHaveBeenCalledTimes(6);
  });
});

describe('KOSCOM 2c close-recovery cap', () => {
  afterEach(() => jest.restoreAllMocks());
  const closedAt = new Date('2026-09-30T07:00:00Z');
  const asset = {
    assetId: 'a0',
    symbol: '000001',
    market: 'KRX',
    assetType: 'domestic_stock',
    state: 'unavailable',
  };

  it('stops after the per-asset/day cap with one alert and stops re-checking', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const h = ingestion({ KOSCOM_CLOSE_RECOVERY_MAX_ATTEMPTS: '3' });
    h.redis.now = closedAt.getTime();
    h.health.checkActiveAssetCoverage.mockResolvedValue({ assets: [asset] });
    h.client.get.mockRejectedValue(new KoscomError('KOSCOM_HTTP_FAILED'));
    const results: Awaited<ReturnType<typeof h.service.collect>>[] = [];
    for (let i = 0; i < 5; i++) {
      // The "already checked" marker of an incomplete round lasts 60 s.
      h.redis.now += 61_000;
      results.push(await h.service.collect({ now: new Date(h.redis.now) }));
    }
    expect(h.client.get).toHaveBeenCalledTimes(3);
    expect(results[3].snapshots[0]?.reason).toBe(
      'KOSCOM_CLOSE_RECOVERY_CAPPED',
    );
    // Every remaining asset is capped: the day is marked checked (6 h).
    expect(results[3].errorCode).toBeUndefined();
    expect(results[4].errorCode).toBe('KOSCOM_CLOSE_ALREADY_CHECKED');
    const alerts = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('koscom_close_recovery_capped'));
    expect(alerts.length).toBe(1);
  });

  it('is unlimited by default (existing behaviour)', async () => {
    const h = ingestion({});
    h.redis.now = closedAt.getTime();
    h.health.checkActiveAssetCoverage.mockResolvedValue({ assets: [asset] });
    h.client.get.mockRejectedValue(new KoscomError('KOSCOM_HTTP_FAILED'));
    for (let i = 0; i < 5; i++) {
      h.redis.now += 61_000;
      await h.service.collect({ now: new Date(h.redis.now) });
    }
    expect(h.client.get).toHaveBeenCalledTimes(5);
  });
});

describe('KOSCOM 2c market-list backoff (F15)', () => {
  afterEach(() => jest.restoreAllMocks());
  const lists = (redis: MemoryRedis, client: { get: jest.Mock }) =>
    new KoscomMarketMapService(
      client as never,
      redis as never,
      {
        getConfig: () => ({
          enabled: true,
          namespace: 'lists',
          listBackoffEnabled: true,
        }),
      } as never,
    );

  it('shares an exponential back-off and one fetcher across instances', async () => {
    const redis = new MemoryRedis();
    const failing = {
      get: jest.fn().mockRejectedValue(new KoscomError('KOSCOM_HTTP_FAILED')),
    };
    await expect(
      lists(redis, failing).resolve('005930', 'KRX'),
    ).rejects.toThrow('KOSCOM_HTTP_FAILED');
    expect(failing.get).toHaveBeenCalledTimes(3);
    // A second instance (no process-local memory) honours the shared pause.
    const other = { get: jest.fn() };
    await expect(lists(redis, other).resolve('005930', 'KRX')).rejects.toThrow(
      'KOSCOM_LIST_BACKOFF',
    );
    expect(other.get).not.toHaveBeenCalled();
    // After 30 s one more failure doubles the pause to 60 s.
    redis.now += 30_000;
    await expect(
      lists(redis, failing).resolve('005930', 'KRX'),
    ).rejects.toThrow();
    const until = Number(
      redis.values.get('koscom:lists:lists:backoff-until:kospi')?.value,
    );
    expect(until - redis.now).toBe(60_000);
    // While another instance holds the fetch lease nobody else calls.
    redis.now = until;
    await redis.setNxPx('koscom:lists:lists:fetching:kospi', '1', 30_000);
    await redis.setNxPx('koscom:lists:lists:fetching:kosdaq', '1', 30_000);
    await redis.setNxPx('koscom:lists:lists:fetching:konex', '1', 30_000);
    const waiting = { get: jest.fn() };
    await expect(
      lists(redis, waiting).resolve('005930', 'KRX'),
    ).rejects.toThrow('KOSCOM_LIST_FETCH_IN_PROGRESS');
    expect(waiting.get).not.toHaveBeenCalled();
  });

  it('clears the failure streak after a successful list', async () => {
    const redis = new MemoryRedis();
    await redis.setWithTtl('koscom:lists:lists:failures:kospi', '4', 3600);
    const ok = {
      get: jest.fn((path: string) =>
        Promise.resolve({
          result: {
            isuLists: [
              { isuSrtCd: path.includes('/kospi/') ? '005930' : '000001' },
            ],
          },
        }),
      ),
    };
    expect(await lists(redis, ok).resolve('005930', 'KRX')).toBe('kospi');
    expect(redis.values.has('koscom:lists:lists:failures:kospi')).toBe(false);
  });

  it('counts a list fetch as P1 lists even inside another call category', async () => {
    const redis = new MemoryRedis();
    const ok = {
      get: jest.fn((path: string) =>
        Promise.resolve({
          result: {
            isuLists: [
              { isuSrtCd: path.includes('/kospi/') ? '005930' : '000001' },
            ],
          },
        }),
      ),
    };
    await runWithKoscomCallCategory('minute', () =>
      lists(redis, ok).resolve('005930', 'KRX'),
    );
    expect(ok.get.mock.calls.length > 0).toBe(true);
    expect(
      ok.get.mock.calls.every(
        (call) =>
          JSON.stringify((call as unknown[])[3]) ===
          JSON.stringify({ category: 'lists' }),
      ),
    ).toBe(true);
  });
});

function hhmmss(ms: number): string {
  const kst = new Date(ms + 9 * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(kst.getUTCHours())}${pad(kst.getUTCMinutes())}${pad(
    kst.getUTCSeconds(),
  )}00`;
}
