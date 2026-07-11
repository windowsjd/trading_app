import { Logger } from '@nestjs/common';
import type { RedisService } from '../redis/redis.service';
import { RedisKeyError, RedisUnavailableError } from '../redis/redis.types';
import type { AssetCandlesResponse } from './asset-candles.service';
import {
  AssetCandlesCacheService,
  CANDLE_CACHE_ENVELOPE_VERSION,
  CANDLE_CACHE_TTL_SECONDS,
} from './asset-candles-cache.service';
import type { CandleCacheConfig } from './asset-candles-cache.config';
import {
  buildCandleDataKey,
  buildCandleGenerationKey,
  CandleCacheKeyInput,
  CandleCacheKeyError,
  CANDLE_CACHE_GENERATION_NAMESPACE,
} from './asset-candles-cache.keys';

type FakeRedis = {
  get: jest.Mock<Promise<string | null>, [string]>;
  setWithTtl: jest.Mock<Promise<void>, [string, string, number]>;
  delete: jest.Mock<Promise<number>, [string]>;
  increment: jest.Mock<Promise<number>, [string]>;
  eval: jest.Mock<
    Promise<unknown>,
    [string, readonly string[], readonly string[]]
  >;
};

const keyInput: CandleCacheKeyInput = {
  assetId: 'asset-1',
  range: '1d',
  interval: '5m',
  limit: 100,
  requestedDate: '2026-07-10',
};

const createResponse = (
  state: 'available' | 'empty',
): AssetCandlesResponse => ({
  success: true,
  data: {
    state,
    asset: {
      id: 'asset-1',
      symbol: 'BTCUSDT',
      name: 'Bitcoin',
      assetType: 'crypto',
      market: 'BINANCE',
      priceCurrency: 'USD',
    },
    range: '1d',
    interval: '5m',
    requestedDate: '2026-07-10',
    candles:
      state === 'available'
        ? [
            {
              time: '2026-07-10T00:00:00.000Z',
              open: '100.00000000',
              high: '110.00000000',
              low: '95.00000000',
              close: '105.00000000',
              volume: '10.00000000',
              amount: '1000.00000000',
              sourceDate: '20260710',
              sourceTime: '000000',
            },
          ]
        : [],
    source: {
      provider: 'binance',
      endpoint: '/api/v3/klines',
      symbol: 'BTCUSDT',
      interval: '5m',
      requestedCount: 100,
      returnedCount: state === 'available' ? 1 : 0,
    },
  },
});

const createFakeRedis = (generation: string | null = null): FakeRedis => {
  const store = new Map<string, string>();

  return {
    get: jest.fn((key: string): Promise<string | null> => {
      if (key.startsWith(CANDLE_CACHE_GENERATION_NAMESPACE)) {
        return Promise.resolve(generation);
      }
      return Promise.resolve(store.get(key) ?? null);
    }),
    setWithTtl: jest.fn((): Promise<void> => Promise.resolve()),
    delete: jest.fn((): Promise<number> => Promise.resolve(1)),
    increment: jest.fn((): Promise<number> => Promise.resolve(1)),
    eval: jest.fn((): Promise<unknown> => Promise.resolve(1)),
  };
};

const createService = (
  redis: FakeRedis,
  config: Partial<CandleCacheConfig> = {},
) => {
  const fullConfig: CandleCacheConfig = {
    enabled: true,
    maxPayloadBytes: 2 * 1024 * 1024,
    ...config,
  };
  return new AssetCandlesCacheService(
    redis as unknown as RedisService,
    fullConfig,
  );
};

const dataKeyFor = (
  generation: number,
  overrides: Partial<CandleCacheKeyInput> = {},
) => buildCandleDataKey({ ...keyInput, ...overrides, generation });

// Makes the fake return `dataValue` for the data key and null for the
// generation key (so generation resolves to 0 unless otherwise configured).
const mockDataValue = (redis: FakeRedis, dataValue: string | null): void => {
  redis.get.mockImplementation(
    (key: string): Promise<string | null> =>
      Promise.resolve(
        key.startsWith(CANDLE_CACHE_GENERATION_NAMESPACE) ? null : dataValue,
      ),
  );
};

describe('AssetCandlesCacheService', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when disabled', () => {
    it('returns disabled/skipped statuses and never touches Redis', async () => {
      const redis = createFakeRedis();
      const service = createService(redis, { enabled: false });

      expect(await service.get(keyInput)).toEqual({ status: 'disabled' });
      expect(await service.set(keyInput, createResponse('available'))).toEqual({
        status: 'skipped_disabled',
      });
      expect(await service.delete(keyInput)).toEqual({ status: 'disabled' });
      expect(await service.invalidateAsset('asset-1')).toEqual({
        status: 'disabled',
      });

      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.setWithTtl).not.toHaveBeenCalled();
      expect(redis.delete).not.toHaveBeenCalled();
      expect(redis.increment).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('returns miss when the entry is absent', async () => {
      const redis = createFakeRedis();
      const service = createService(redis);

      expect(await service.get(keyInput)).toEqual({ status: 'miss' });
    });

    it('returns a hit with the restored value and cachedAt', async () => {
      const redis = createFakeRedis();
      const service = createService(redis);
      const response = createResponse('available');
      const cachedAt = '2026-07-10T12:00:00.000Z';
      mockDataValue(
        redis,
        JSON.stringify({
          version: CANDLE_CACHE_ENVELOPE_VERSION,
          cachedAt,
          value: response,
        }),
      );

      const result = await service.get(keyInput);

      expect(result).toEqual({
        status: 'hit',
        value: response,
        cachedAt: new Date(cachedAt),
      });
    });

    it('reads the entry at the current asset generation', async () => {
      const redis = createFakeRedis('4');
      const service = createService(redis);

      await service.get(keyInput);

      const dataReadKey = redis.get.mock.calls
        .map((call) => call[0])
        .find((key) => !key.startsWith(CANDLE_CACHE_GENERATION_NAMESPACE));
      expect(dataReadKey).toBe(dataKeyFor(4));
    });

    it('treats corrupt JSON as a miss after best-effort delete', async () => {
      const redis = createFakeRedis();
      const service = createService(redis);
      mockDataValue(redis, 'not-json{');

      expect(await service.get(keyInput)).toEqual({ status: 'miss' });
      expect(redis.delete).toHaveBeenCalledWith(dataKeyFor(0));
    });

    it('treats an unsupported envelope version as a miss', async () => {
      const redis = createFakeRedis();
      const service = createService(redis);
      mockDataValue(
        redis,
        JSON.stringify({
          version: 999,
          cachedAt: '2026-07-10T12:00:00.000Z',
          value: createResponse('available'),
        }),
      );

      expect(await service.get(keyInput)).toEqual({ status: 'miss' });
    });

    it('treats an invalid cachedAt as a miss', async () => {
      const redis = createFakeRedis();
      const service = createService(redis);
      mockDataValue(
        redis,
        JSON.stringify({
          version: CANDLE_CACHE_ENVELOPE_VERSION,
          cachedAt: 'not-a-date',
          value: createResponse('available'),
        }),
      );

      expect(await service.get(keyInput)).toEqual({ status: 'miss' });
    });

    it('returns error when the Redis read fails', async () => {
      const redis = createFakeRedis();
      const service = createService(redis);
      redis.get.mockRejectedValue(new Error('connection lost'));

      expect(await service.get(keyInput)).toEqual({ status: 'error' });
    });
  });

  describe('set', () => {
    it('stores an available response atomically with the interval TTL', async () => {
      const redis = createFakeRedis();
      const service = createService(redis);
      const response = createResponse('available');

      const result = await service.set(keyInput, response);

      expect(result.status).toBe('stored');
      expect(redis.setWithTtl).toHaveBeenCalledTimes(1);
      const [key, serialized, ttl] = redis.setWithTtl.mock.calls[0];
      expect(key).toBe(dataKeyFor(0));
      expect(ttl).toBe(CANDLE_CACHE_TTL_SECONDS['5m']);
      const envelope = JSON.parse(serialized) as {
        version: number;
        cachedAt: string;
        value: AssetCandlesResponse;
      };
      expect(envelope.version).toBe(CANDLE_CACHE_ENVELOPE_VERSION);
      expect(typeof envelope.cachedAt).toBe('string');
      expect(envelope.value).toEqual(response);
    });

    it('stores an empty response', async () => {
      const redis = createFakeRedis();
      const service = createService(redis);

      const result = await service.set(keyInput, createResponse('empty'));

      expect(result.status).toBe('stored');
      expect(redis.setWithTtl).toHaveBeenCalledTimes(1);
    });

    it('applies the correct TTL for each interval', async () => {
      const redis = createFakeRedis();
      const service = createService(redis);

      for (const interval of Object.keys(
        CANDLE_CACHE_TTL_SECONDS,
      ) as (keyof typeof CANDLE_CACHE_TTL_SECONDS)[]) {
        redis.setWithTtl.mockClear();
        await service.set(
          { ...keyInput, interval },
          createResponse('available'),
        );
        const ttl = redis.setWithTtl.mock.calls[0][2];
        expect(ttl).toBe(CANDLE_CACHE_TTL_SECONDS[interval]);
      }
    });

    it('skips oversized payloads without storing and without failing', async () => {
      const redis = createFakeRedis();
      const service = createService(redis, { maxPayloadBytes: 10 });

      const result = await service.set(keyInput, createResponse('available'));

      expect(result.status).toBe('skipped_oversized');
      expect(redis.setWithTtl).not.toHaveBeenCalled();
    });

    it('returns error when the Redis write fails', async () => {
      const redis = createFakeRedis();
      const service = createService(redis);
      redis.setWithTtl.mockRejectedValue(new Error('write failed'));

      expect(
        (await service.set(keyInput, createResponse('available'))).status,
      ).toBe('error');
    });
  });

  describe('delete', () => {
    it('deletes exactly the current-generation data key', async () => {
      const redis = createFakeRedis('2');
      const service = createService(redis);

      const result = await service.delete(keyInput);

      expect(result).toEqual({ status: 'invalidated' });
      expect(redis.delete).toHaveBeenCalledTimes(1);
      expect(redis.delete).toHaveBeenCalledWith(dataKeyFor(2));
    });

    it('returns error when the Redis delete fails', async () => {
      const redis = createFakeRedis();
      const service = createService(redis);
      redis.delete.mockRejectedValue(new Error('del failed'));

      expect(await service.delete(keyInput)).toEqual({ status: 'error' });
    });
  });

  describe('invalidateAsset', () => {
    it('increments the asset generation counter', async () => {
      const redis = createFakeRedis();
      redis.increment.mockResolvedValueOnce(1);
      const service = createService(redis);

      const result = await service.invalidateAsset('asset-1');

      expect(result).toEqual({ status: 'invalidated', generation: 1 });
      expect(redis.increment).toHaveBeenCalledWith(
        buildCandleGenerationKey('asset-1'),
      );
    });

    it('routes subsequent reads/writes to a new data key after invalidation', async () => {
      const beforeRedis = createFakeRedis('1');
      const afterRedis = createFakeRedis('2');
      const beforeService = createService(beforeRedis);
      const afterService = createService(afterRedis);

      await beforeService.set(keyInput, createResponse('available'));
      await afterService.set(keyInput, createResponse('available'));

      expect(beforeRedis.setWithTtl.mock.calls[0][0]).toBe(dataKeyFor(1));
      expect(afterRedis.setWithTtl.mock.calls[0][0]).toBe(dataKeyFor(2));
      expect(beforeRedis.setWithTtl.mock.calls[0][0]).not.toBe(
        afterRedis.setWithTtl.mock.calls[0][0],
      );
    });

    it('returns error when the Redis increment fails', async () => {
      const redis = createFakeRedis();
      redis.increment.mockRejectedValue(new Error('incr failed'));
      const service = createService(redis);

      expect(await service.invalidateAsset('asset-1')).toEqual({
        status: 'error',
      });
    });
  });

  describe('generation counter parsing', () => {
    it('treats a missing generation key as generation 0', async () => {
      const redis = createFakeRedis(null);
      const service = createService(redis);

      await service.set(keyInput, createResponse('available'));

      expect(redis.setWithTtl.mock.calls[0][0]).toBe(dataKeyFor(0));
    });

    it('treats a non-integer generation value as 0', async () => {
      const redis = createFakeRedis('not-a-number');
      const service = createService(redis);

      await service.set(keyInput, createResponse('available'));

      expect(redis.setWithTtl.mock.calls[0][0]).toBe(dataKeyFor(0));
    });
  });

  describe('generation-aware conditional writes', () => {
    it('resolves one generation snapshot and derives both Redis keys', async () => {
      const redis = createFakeRedis('7');
      const service = createService(redis);
      await expect(service.resolveContext(keyInput)).resolves.toEqual({
        status: 'resolved',
        context: {
          input: keyInput,
          generation: 7,
          generationKey: buildCandleGenerationKey('asset-1'),
          dataKey: dataKeyFor(7),
        },
      });
    });

    it.each([
      [1, 'stored'],
      [-1, 'skipped_lock_lost'],
      [-2, 'skipped_generation_changed'],
    ])('maps atomic result %s to %s', async (atomicResult, status) => {
      const redis = createFakeRedis('3');
      redis.eval.mockResolvedValueOnce(atomicResult);
      const service = createService(redis);
      const resolved = await service.resolveContext(keyInput);
      if (resolved.status !== 'resolved') throw new Error('context missing');

      await expect(
        service.setIfOwnerAndGeneration(
          resolved.context,
          createResponse('available'),
          { lockKey: 'candles:lock:v1:hash', lockToken: 'owner-token' },
        ),
      ).resolves.toMatchObject({ status });
      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        [
          'candles:lock:v1:hash',
          buildCandleGenerationKey('asset-1'),
          dataKeyFor(3),
        ],
        [
          'owner-token',
          '3',
          expect.any(String),
          String(CANDLE_CACHE_TTL_SECONDS['5m']),
        ],
      );
    });
  });

  it('never logs cached payload contents or secrets on error', async () => {
    const redis = createFakeRedis();
    redis.get.mockRejectedValue(
      new Error('secret-token-xyz should not be logged'),
    );
    const service = createService(redis);

    await service.get(keyInput);

    const logged = (warnSpy.mock.calls as unknown[][])
      .flat()
      .map((arg) => String(arg))
      .join(' ');
    expect(logged).not.toContain('secret-token-xyz');
    expect(logged).not.toContain('BTCUSDT');
  });

  describe('error classification and envelope validation', () => {
    const envelope = (value: unknown) =>
      JSON.stringify({
        version: CANDLE_CACHE_ENVELOPE_VERSION,
        cachedAt: '2026-07-10T00:00:00.000Z',
        value,
      });

    it('does not hide candle key or Redis key programmer errors', async () => {
      const redis = createFakeRedis();
      const service = createService(redis);
      await expect(
        service.get({ ...keyInput, assetId: '' }),
      ).rejects.toBeInstanceOf(CandleCacheKeyError);

      redis.get.mockRejectedValueOnce(new RedisKeyError('bad key'));
      await expect(service.get(keyInput)).rejects.toBeInstanceOf(RedisKeyError);
    });

    it('fails open without duplicate warnings for RedisUnavailableError', async () => {
      const redis = createFakeRedis();
      redis.get.mockRejectedValue(new RedisUnavailableError('down'));
      const service = createService(redis);

      await expect(service.get(keyInput)).resolves.toEqual({ status: 'error' });
      await expect(service.get(keyInput)).resolves.toEqual({ status: 'error' });
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['empty object', {}],
      [
        'invalid state',
        {
          ...createResponse('available'),
          data: { ...createResponse('available').data, state: 'bad' },
        },
      ],
      [
        'invalid candle',
        {
          ...createResponse('available'),
          data: {
            ...createResponse('available').data,
            candles: [{ time: 'only-one-field' }],
          },
        },
      ],
    ])('rejects and deletes a %s envelope', async (_label, value) => {
      const redis = createFakeRedis();
      mockDataValue(redis, envelope(value));
      const service = createService(redis);

      await expect(service.get(keyInput)).resolves.toEqual({ status: 'miss' });
      expect(redis.delete).toHaveBeenCalledWith(dataKeyFor(0));
    });

    it('accepts valid Binance and KIS response envelopes', async () => {
      const binanceRedis = createFakeRedis();
      mockDataValue(binanceRedis, envelope(createResponse('available')));
      await expect(
        createService(binanceRedis).get(keyInput),
      ).resolves.toMatchObject({
        status: 'hit',
      });

      const kis = createResponse('empty');
      kis.data.asset.assetType = 'domestic_stock';
      kis.data.asset.priceCurrency = 'KRW';
      kis.data.source = {
        provider: 'kis',
        trId: 'FHKST03010200',
        path: '/uapi/candles',
        marketCode: 'KRX',
        requestedCount: 30,
        returnedCount: 0,
      };
      const kisRedis = createFakeRedis();
      mockDataValue(kisRedis, envelope(kis));
      await expect(
        createService(kisRedis).get(keyInput),
      ).resolves.toMatchObject({
        status: 'hit',
      });
    });
  });
});
