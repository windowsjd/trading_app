import { randomUUID } from 'node:crypto';
import {
  KoscomClient,
  koscomBatches,
  parseKoscomJson,
  type KoscomTarget,
} from './koscom.client';
import { readKoscomConfig, KoscomError } from './koscom.config';
import {
  inferKoscomCallCategory,
  runWithKoscomCallCategory,
  type KoscomCallCategory,
} from './koscom-call-context';

type QuotaObservation = {
  limitDay: number | null;
  remainingDay: number | null;
  observedAt: Date;
};
type AdmitInput = {
  namespace: string;
  category: KoscomCallCategory;
  enforce: boolean;
  caps: { dailyCap: number; monthlyCap: number };
};
type BudgetMock = {
  admitAttempt: jest.Mock<Promise<string>, [AdmitInput]>;
  recordQuotaHeaders: jest.Mock<Promise<boolean>, [string, QuotaObservation]>;
};

const targets = (count: number, market: KoscomTarget['market'] = 'kospi') =>
  Array.from({ length: count }, (_, i) => ({
    assetId: `a${i}`,
    symbol: String(i + 1).padStart(6, '0'),
    market,
  }));

function harness(budget?: BudgetMock, env: Record<string, string> = {}) {
  const apiKey = randomUUID();
  const config = {
    getConfig: () => ({
      ...readKoscomConfig({
        KOSCOM_API_KEY: apiKey,
        PROVIDER_INGESTION_ENABLED: 'true',
        ...env,
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
    client: new KoscomClient(
      config as never,
      redis as never,
      locks as never,
      budget as never,
    ),
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
  it('records the daily quota headers of a successful response without exposing them elsewhere', async () => {
    const h = harness();
    expect(h.client.getLastObservedRateLimit()).toBeNull();
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        '{"jsonrpc":"2.0","result":{"isuSrtCd":"005930","hisLists":[]}}',
        {
          headers: {
            'X-RateLimit-Limit-Day': '50000',
            'X-RateLimit-Remaining-Day': '33540',
          },
        },
      ),
    );
    await h.client.get('/v3/market/realtime/kospi/stocks/005930/intraday', {
      inddCycleTpCd: '600',
    });
    const observed = h.client.getLastObservedRateLimit();
    expect(observed?.limitDay).toBe(50000);
    expect(observed?.remainingDay).toBe(33540);
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        '{"jsonrpc":"2.0","result":{"isuSrtCd":"005930","hisLists":[]}}',
        {
          headers: { 'X-RateLimit-Remaining-Day': 'n/a' },
        },
      ),
    );
    await h.client.get('/v3/market/realtime/kospi/stocks/005930/intraday', {
      inddCycleTpCd: '60',
    });
    // A non-numeric header is not an observation; the last one is kept.
    expect(h.client.getLastObservedRateLimit()?.remainingDay).toBe(33540);
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

describe('KOSCOM call budget attribution (stage 1, observation only)', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });
  const budget = (): BudgetMock => ({
    admitAttempt: jest
      .fn<Promise<string>, [AdmitInput]>()
      .mockResolvedValue('admitted'),
    recordQuotaHeaders: jest
      .fn<Promise<boolean>, [string, QuotaObservation]>()
      .mockResolvedValue(true),
  });
  const ok = () =>
    Promise.resolve(
      new Response('{"jsonrpc":"2.0","result":{"isuSrtCd":"005930"}}'),
    );

  it.each([
    ['/v3/market/realtime/kospi/multiquote/stocks/price', {}, 'price'],
    ['/v3/market/realtime/konex/stocks/000001/orderbook', {}, 'orderbook'],
    ['/v3/market/closed/kosdaq/lists', {}, 'lists'],
    [
      '/v3/market/realtime/kospi/stocks/005930/intraday',
      { inddCycleTpCd: '60' },
      'minute',
    ],
    [
      '/v3/market/realtime/kospi/stocks/005930/intraday',
      { inddCycleTpCd: '600' },
      'long_4h',
    ],
    [
      '/v3/market/closed/kospi/005930/history',
      { trnsmCycleTpCd: 'D' },
      'daily',
    ],
    [
      '/v3/market/closed/kospi/005930/history',
      { trnsmCycleTpCd: 'W' },
      'weekly',
    ],
    ['/v3/market/closed/kospi/005930/master', {}, 'other'],
  ] as const)('infers %s %j as %s', (path, query, category) => {
    expect(inferKoscomCallCategory(path, query)).toBe(category);
  });

  it('counts every sent attempt, retries included, under the endpoint category', async () => {
    const b = budget();
    const h = harness(b);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockImplementationOnce(ok);
    await h.client.get('/v3/market/closed/kospi/005930/history', {
      trnsmCycleTpCd: 'D',
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(b.admitAttempt.mock.calls.map((c) => c[0].category)).toEqual([
      'daily',
      'daily',
    ]);
    // The namespace, never the API key, scopes the counters; unenforced.
    expect(
      b.admitAttempt.mock.calls.every(
        (c) =>
          c[0].namespace === h.config.getConfig().namespace &&
          c[0].enforce === false,
      ),
    ).toBe(true);
  });

  it('lets an explicit option beat the async context, and the context beat the endpoint', async () => {
    const b = budget();
    const h = harness(b);
    global.fetch = jest.fn(ok);
    await runWithKoscomCallCategory('gap_repair', async () => {
      await h.client.get('/v3/market/realtime/kospi/stocks/005930/intraday', {
        inddCycleTpCd: '60',
      });
      await h.client.get(
        '/v3/market/closed/kospi/005930/history',
        { trnsmCycleTpCd: 'D' },
        undefined,
        { category: 'recover_close' },
      );
    });
    expect(b.admitAttempt.mock.calls.map((c) => c[0].category)).toEqual([
      'gap_repair',
      'recover_close',
    ]);
  });

  it('does not retry when the caller asks for zero retries', async () => {
    const b = budget();
    const h = harness(b);
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response('', { status: 503 }));
    await expect(
      h.client.batch(koscomBatches(targets(1))[0], 'price', undefined, {
        retries: 0,
      }),
    ).rejects.toMatchObject({ code: 'KOSCOM_HTTP_FAILED' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(b.admitAttempt.mock.calls.map((c) => c[0].category)).toEqual([
      'price',
    ]);
  });

  it('never waits on or fails because of the counter store', async () => {
    const hanging: BudgetMock = {
      admitAttempt: jest.fn<Promise<string>, [AdmitInput]>(
        () => new Promise<string>(() => undefined),
      ),
      recordQuotaHeaders: jest.fn<Promise<boolean>, [string, QuotaObservation]>(
        () => new Promise<boolean>(() => undefined),
      ),
    };
    const h = harness(hanging);
    global.fetch = jest.fn(ok);
    await expect(
      h.client.get('/v3/market/closed/kospi/lists'),
    ).resolves.toBeDefined();
    expect(hanging.admitAttempt).toHaveBeenCalledTimes(1);
  });

  it('records quota headers and counts nothing that was never sent or when metrics are off', async () => {
    const b = budget();
    const h = harness(b);
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response('{"jsonrpc":"2.0","result":{"isuSrtCd":"005930"}}', {
          headers: {
            'X-RateLimit-Limit-Day': '50000',
            'X-RateLimit-Remaining-Day': '41000',
          },
        }),
      ),
    );
    await h.client.get('/v3/market/closed/kospi/005930/master');
    expect(b.recordQuotaHeaders).toHaveBeenCalledTimes(1);
    expect(b.recordQuotaHeaders.mock.calls[0][1].remainingDay).toBe(41000);

    // A shared 429 cooldown refuses before sending: not an attempt.
    const cooling = harness(budget());
    cooling.redis.get.mockResolvedValue('1');
    await expect(
      cooling.client.get('/v3/market/closed/kospi/lists'),
    ).rejects.toMatchObject({ code: 'KOSCOM_RATE_LIMITED' });

    const off = budget();
    const disabled = harness(off, { KOSCOM_CALL_METRICS_ENABLED: 'false' });
    await disabled.client.get('/v3/market/closed/kospi/005930/master');
    expect(off.admitAttempt).not.toHaveBeenCalled();
    expect(off.recordQuotaHeaders).not.toHaveBeenCalled();
  });
});

function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

describe('KOSCOM budget enforcement and price priority lane (3c)', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });
  const enforced = { KOSCOM_BUDGET_ENFORCEMENT_ENABLED: 'true' };
  const ok = () =>
    Promise.resolve(
      new Response('{"jsonrpc":"2.0","result":{"isuSrtCd":"005930"}}'),
    );
  const budgetAnswering = (answer: () => Promise<string>): BudgetMock => ({
    admitAttempt: jest.fn<Promise<string>, [AdmitInput]>(answer),
    recordQuotaHeaders: jest
      .fn<Promise<boolean>, [string, QuotaObservation]>()
      .mockResolvedValue(true),
  });

  it('never sends (nor retries) an attempt the governor refuses', async () => {
    const b = budgetAnswering(() => Promise.resolve('denied'));
    const h = harness(b, enforced);
    global.fetch = jest.fn(ok);
    await expect(
      h.client.get('/v3/market/realtime/kospi/stocks/005930/intraday', {
        inddCycleTpCd: '60',
      }),
    ).rejects.toMatchObject({ code: 'KOSCOM_BUDGET_EXHAUSTED' });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(b.admitAttempt).toHaveBeenCalledTimes(1);
    const input = b.admitAttempt.mock.calls[0][0];
    expect(input.category).toBe('minute');
    expect(input.enforce).toBe(true);
    expect(input.caps).toEqual({ dailyCap: 50000, monthlyCap: 1000000 });
    // The HTTP slot is released for the next caller.
    expect(h.locks.release).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the governor cannot decide', async () => {
    const b = budgetAnswering(() => Promise.reject(new Error('redis down')));
    const h = harness(b, enforced);
    global.fetch = jest.fn(ok);
    await expect(
      h.client.get('/v3/market/closed/kospi/005930/history', {
        trnsmCycleTpCd: 'D',
      }),
    ).rejects.toMatchObject({ code: 'KOSCOM_COORDINATION_UNAVAILABLE' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('sends admitted attempts and counts each retry as its own attempt', async () => {
    const b = budgetAnswering(() => Promise.resolve('admitted'));
    const h = harness(b, enforced);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockImplementationOnce(ok);
    await h.client.get('/v3/market/closed/kospi/005930/history', {
      trnsmCycleTpCd: 'D',
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(b.admitAttempt).toHaveBeenCalledTimes(2);
  });

  it('holds background calls while a price cycle owns the lane, never price or lists', async () => {
    const b = budgetAnswering(() => Promise.resolve('admitted'));
    const h = harness(b, { KOSCOM_PRICE_PRIORITY_LANE_ENABLED: 'true' });
    const lane = `koscom:${h.config.getConfig().namespace}:price-lane`;
    let laneReads = 0;
    h.redis.get.mockImplementation((key: string) => {
      if (key !== lane) return Promise.resolve(null);
      laneReads += 1;
      return Promise.resolve(laneReads <= 3 ? 'held' : null);
    });
    global.fetch = jest.fn(ok);
    await h.client.get('/v3/market/realtime/kospi/stocks/005930/intraday', {
      inddCycleTpCd: '60',
    });
    // Waited until the lane was released (fourth read), then sent once.
    expect(laneReads).toBe(4);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    laneReads = 0;
    h.redis.get.mockImplementation((key: string) =>
      Promise.resolve(key === lane ? 'held' : null),
    );
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response('{"jsonrpc":"2.0","result":{"isulist":[]}}'),
      ),
    );
    await h.client.batch(koscomBatches(targets(1))[0], 'price');
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response('{"isuLists":[]}')),
    );
    await h.client.get('/v3/market/closed/kospi/lists');
    expect(laneReads).toBe(0);
  });
});
