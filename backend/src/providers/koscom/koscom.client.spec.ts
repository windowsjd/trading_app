import { randomUUID } from 'node:crypto';
import {
  KoscomClient,
  koscomBatches,
  parseKoscomJson,
  type KoscomTarget,
} from './koscom.client';
import { readKoscomConfig, KoscomError } from './koscom.config';

const targets = (count: number, market: KoscomTarget['market'] = 'kospi') =>
  Array.from({ length: count }, (_, i) => ({
    assetId: `a${i}`,
    symbol: String(i + 1).padStart(6, '0'),
    market,
  }));

function harness() {
  const apiKey = randomUUID();
  const config = {
    getConfig: () => ({
      ...readKoscomConfig({
        KOSCOM_API_KEY: apiKey,
        PROVIDER_INGESTION_ENABLED: 'true',
      }),
      timeoutMs: 40,
      minIntervalMs: 1,
    }),
  };
  const held = new Set<string>();
  let maxActive = 0;
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    setNxPx: jest.fn().mockResolvedValue(true),
  };
  const locks = {
    acquire: jest.fn((key: string, ttlMs: number) => {
      if (held.has(key)) return Promise.resolve({ status: 'busy' });
      held.add(key);
      maxActive = Math.max(maxActive, held.size);
      return Promise.resolve({
        status: 'acquired',
        lock: { key, ttlMs, token: randomUUID() },
      });
    }),
    release: jest.fn((lock: { key: string }) =>
      Promise.resolve(held.delete(lock.key)),
    ),
  };
  return {
    client: new KoscomClient(config as never, redis as never, locks as never),
    config,
    redis,
    locks,
    apiKey,
    maxActive: () => maxActive,
  };
}

describe('KOSCOM v3 client', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });
  it.each([1, 20, 21, 43])(
    'partitions %s symbols with the 20-symbol cap',
    (count) => {
      const batches = koscomBatches(targets(count));
      expect(batches.map((b) => b.targets.length)).toEqual(
        count === 43 ? [20, 20, 3] : count === 21 ? [20, 1] : [count],
      );
    },
  );
  it('separates markets, deduplicates requests and never batches KONEX', () => {
    expect(
      koscomBatches([
        ...targets(2),
        ...targets(1),
        ...targets(2, 'kosdaq'),
        ...targets(2, 'konex'),
      ]).map((b) => [b.market, b.targets.length]),
    ).toEqual([
      ['kospi', 2],
      ['kosdaq', 2],
      ['konex', 1],
      ['konex', 1],
    ]);
  });
  it('keeps large JSON numbers and fractional tokens lossless', () => {
    expect(
      parseKoscomJson(
        '{"accTrdval":1234567890123456789012,"p":123.00000001,"s":"005930"}',
      ),
    ).toEqual({
      accTrdval: '1234567890123456789012',
      p: '123.00000001',
      s: '005930',
    });
  });
  it('constructs v3 query authentication and single-flights an identical request', async () => {
    const h = harness();
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        new Response('{"jsonrpc":"2.0","result":{"isulist":[]}}'),
      );
    const batch = koscomBatches(targets(20))[0];
    await Promise.all([
      h.client.batch(batch, 'price'),
      h.client.batch(batch, 'price'),
    ]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = new URL(fetchUrl(jest.mocked(global.fetch).mock.calls[0][0]));
    expect(url.pathname).toBe(
      '/v3/market/realtime/kospi/multiquote/stocks/price',
    );
    expect(url.searchParams.get('isuCd')?.split(',').length).toBe(20);
    expect(url.searchParams.get('apikey') === h.apiKey).toBe(true);
  });
  it('uses single-symbol KONEX and keeps at most two concurrent HTTP requests', async () => {
    const h = harness();
    const paths: string[] = [];
    global.fetch = jest.fn(async (url) => {
      paths.push(new URL(fetchUrl(url)).pathname);
      await new Promise((r) => setTimeout(r, 5));
      return new Response('{"jsonrpc":"2.0","result":{"isuSrtCd":"000001"}}');
    });
    await Promise.all(
      koscomBatches(targets(5, 'konex')).map((b) =>
        h.client.batch(b, 'orderbook'),
      ),
    );
    expect(h.maxActive()).toBe(2);
    expect(
      paths.every((p) => /\/konex\/stocks\/\d{6}\/orderbook$/.test(p)),
    ).toBe(true);
  });
  it.each([401, 403, 429])(
    'does not retry authentication/rate-limit HTTP %s or expose error body',
    async (status) => {
      const h = harness();
      global.fetch = jest
        .fn()
        .mockResolvedValue(new Response(h.apiKey, { status }));
      const error = await h.client.get('/v3/market/closed/kospi/lists').then(
        (): never => {
          throw new Error('Expected rejection');
        },
        (e: unknown) => {
          if (!(e instanceof KoscomError)) throw e;
          return e;
        },
      );
      expect(error.message.includes(h.apiKey)).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(error.code).toBe(
        status === 429 ? 'KOSCOM_RATE_LIMITED' : 'KOSCOM_AUTH_FAILED',
      );
    },
  );
  it('retries a timeout once and suppresses transport URL/secret text', async () => {
    const h = harness();
    global.fetch = jest.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new Error(h.apiKey)),
            { once: true },
          );
        }),
    );
    await expect(
      h.client.get('/v3/market/closed/kospi/lists'),
    ).rejects.toMatchObject({
      code: 'KOSCOM_TIMEOUT',
      message: 'KOSCOM_TIMEOUT',
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(h.locks.release).toHaveBeenCalledTimes(2);
  });
  it('retries a 503 once while another batch can succeed', async () => {
    const h = harness();
    let failed = false;
    global.fetch = jest.fn((url) => {
      if (fetchUrl(url).includes('kospi') && !failed) {
        failed = true;
        return Promise.resolve(new Response('', { status: 503 }));
      }
      return Promise.resolve(
        new Response('{"jsonrpc":"2.0","result":{"isulist":[]}}'),
      );
    });
    const result = await Promise.allSettled([
      h.client.batch(koscomBatches(targets(1))[0], 'price'),
      h.client.batch(koscomBatches(targets(1, 'kosdaq'))[0], 'price'),
    ]);
    expect(result.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
  it.each([
    '{}',
    '[]',
    '{"jsonrpc":"2.0","error":{"message":"private"}}',
    'not json',
  ])('rejects unusable HTTP 200: %s', async (body) => {
    const h = harness();
    global.fetch = jest.fn().mockResolvedValue(new Response(body));
    await expect(h.client.get('/v3/market/closed/kospi/lists')).rejects.toThrow(
      /^KOSCOM_/,
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not make calls without a key or coordination', async () => {
    const h = harness();
    global.fetch = jest.fn();
    h.config.getConfig = () => ({
      ...readKoscomConfig({}),
      timeoutMs: 40,
      minIntervalMs: 1,
    });
    await expect(
      h.client.get('/v3/market/closed/kospi/lists'),
    ).rejects.toMatchObject({ code: 'KOSCOM_DISABLED' });
    expect(global.fetch).not.toHaveBeenCalled();
    const healthy = harness();
    healthy.locks.acquire.mockRejectedValueOnce(new Error('private'));
    await expect(
      healthy.client.get('/v3/market/closed/kospi/lists'),
    ).rejects.toMatchObject({ code: 'KOSCOM_COORDINATION_UNAVAILABLE' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}
