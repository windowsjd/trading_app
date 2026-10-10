import { RedisService } from '../../redis/redis.service';
import { ProviderHttpClient } from '../provider-http.client';
import { BinanceRestCoordinator } from './binance-rest-coordinator';

// Same opt-in convention as existing candle fixtures; never use runtime REDIS_URL.
const fixture =
  process.env.BINANCE_REST_REDIS_FIXTURE === '1' ? describe : describe.skip;
const STATE = 'provider:{binance-rest}:state';
const LEASES = 'provider:{binance-rest}:leases';
const url = 'https://fixture.invalid/api/v3/klines?symbol=BTCUSDT';
const options = { provider: 'binance' as const, timeoutMs: 1000 };
const success = () => new Response('{"price":"110"}', { status: 200 });
const limited = (status: number, seconds = '60') =>
  new Response('PRIVATE_ERROR token=secret', {
    status,
    headers: { 'Retry-After': seconds, 'X-MBX-USED-WEIGHT-1M': '123' },
  });

fixture('Binance REST shared Redis fixture (all HTTP is mocked)', () => {
  let redis: RedisService;
  let redisB: RedisService;
  const originalBudget = process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE;
  beforeAll(async () => {
    const fixtureUrl = process.env.BINANCE_REST_FIXTURE_REDIS_URL;
    if (
      !fixtureUrl ||
      !['127.0.0.1', 'localhost'].includes(new URL(fixtureUrl).hostname)
    )
      throw new Error(
        'An explicit local BINANCE_REST_FIXTURE_REDIS_URL is required.',
      );
    redis = new RedisService({
      url: fixtureUrl,
      connectTimeoutMs: 1000,
      commandTimeoutMs: 1000,
    });
    redisB = new RedisService({
      url: fixtureUrl,
      connectTimeoutMs: 1000,
      commandTimeoutMs: 1000,
    });
    await Promise.all([redis.connect(), redisB.connect()]);
  });
  beforeEach(async () => {
    delete process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE;
    await redis.delete(STATE);
    await redis.delete(LEASES);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    if (originalBudget === undefined)
      delete process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE;
    else process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE = originalBudget;
    if (redis) {
      await redis.delete(STATE);
      await redis.delete(LEASES);
      await redis.onModuleDestroy();
      await redisB.onModuleDestroy();
    }
  });
  const expireBlock = async () =>
    redis.eval(
      `local t=redis.call('TIME'); redis.call('HSET',KEYS[1],'until',tonumber(t[1])*1000-1); return 1`,
      [STATE],
    );

  it.each([429, 418])(
    'shares HTTP %s cooldown across new clients/restarts and discards private data',
    async (status) => {
      const fetch = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(limited(status));
      const first = new ProviderHttpClient(redis);
      const failure: unknown = await first
        .getJson(`${url}&token=secret`, options)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'PROVIDER_RATE_LIMITED',
        rateLimit: { status, retryAfterMs: 60_000, usedWeight1m: 123 },
      });
      expect(JSON.stringify(failure)).not.toMatch(
        /PRIVATE_ERROR|secret|fixture.invalid/,
      );
      await expect(
        new ProviderHttpClient(redis).getJson(url, options),
      ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
      for (const path of [
        '/api/v3/ticker/24hr?symbol=BTCUSDT',
        '/api/v3/exchangeInfo',
        '/fapi/v1/exchangeInfo',
        '/fapi/v1/premiumIndex',
      ]) {
        await expect(
          new ProviderHttpClient(redis).getJson(
            `https://fixture.invalid${path}`,
            options,
          ),
        ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
      }
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('allows exactly one recovery probe then reopens normal admission on success', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(limited(418));
    await expect(
      new ProviderHttpClient(redis).getJson(url, options),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    await expireBlock();
    let resolveProbe!: (response: Response) => void;
    let started!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetch.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        resolveProbe = resolve;
      });
    });
    const probe = new ProviderHttpClient(redis).getJson(url, options);
    await probeStarted;
    await expect(
      new ProviderHttpClient(redis).getJson(url, options),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    expect(fetch).toHaveBeenCalledTimes(2);
    resolveProbe(success());
    await expect(probe).resolves.toMatchObject({ json: { price: '110' } });
    fetch.mockResolvedValue(success());
    await expect(
      new ProviderHttpClient(redis).getJson(url, options),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not shorten an IP ban when another in-flight request returns a shorter 429', async () => {
    const resolvers: ((response: Response) => void)[] = [];
    let started!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    jest.spyOn(global, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
          if (resolvers.length === 2) started();
        }),
    );
    const first = new ProviderHttpClient(redis)
      .getJson(url, options)
      .catch((error: unknown) => error);
    const second = new ProviderHttpClient(redis)
      .getJson(url, options)
      .catch((error: unknown) => error);
    await bothStarted;
    resolvers[0](limited(418, '120'));
    await first;
    resolvers[1](limited(429, '1'));
    await second;
    const remaining = await redis.eval(
      `local t=redis.call('TIME'); return tonumber(redis.call('HGET',KEYS[1],'until'))-tonumber(t[1])*1000`,
      [STATE],
    );
    expect(Number(remaining) > 100_000).toBe(true);
  });

  it('bounds slot admission wait without issuing HTTP beyond the two active leases', async () => {
    let started!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resolvers: ((response: Response) => void)[] = [];
    const fetch = jest.spyOn(global, 'fetch').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
          if (resolvers.length === 2) started();
        }),
    );
    const requests = [
      new ProviderHttpClient(redis).getJson(url, options),
      new ProviderHttpClient(redis).getJson(url, options),
    ];
    await bothStarted;
    await expect(
      new ProviderHttpClient(redis).getJson(url, options),
    ).rejects.toMatchObject({ code: 'BINANCE_REST_BUSY' });
    expect(fetch).toHaveBeenCalledTimes(2);
    resolvers.forEach((resolve) => resolve(success()));
    await Promise.all(requests);
  });

  it('backs off an unsuccessful recovery probe rather than releasing all callers', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(limited(429));
    await expect(
      new ProviderHttpClient(redis).getJson(url, options),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    await expireBlock();
    fetch.mockResolvedValueOnce(new Response('private', { status: 503 }));
    await expect(
      new ProviderHttpClient(redis).getJson(url, options),
    ).rejects.toMatchObject({ code: 'PROVIDER_HTTP_ERROR' });
    await expect(
      new ProviderHttpClient(redis).getJson(url, options),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('recovers a dead process lease but prevents its late success from clearing a new probe', async () => {
    const coordinator = new BinanceRestCoordinator(redis);
    const original = await coordinator.acquire(url, 1000);
    await coordinator.complete(original, 'limited', 60_000, 418);
    await expireBlock();
    const orphan = await coordinator.acquire(url, 1000);
    await redis.eval(
      `redis.call('ZADD',KEYS[1],0,ARGV[1]);return 1`,
      [LEASES],
      [orphan],
    );
    const probe = await new BinanceRestCoordinator(redisB).acquire(url, 1000);
    await coordinator.complete(orphan, 'success');
    await expect(coordinator.acquire(url, 1000)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
    await coordinator.complete(probe, 'success');
    const next = await coordinator.acquire(url, 1000);
    await coordinator.complete(next, 'success');
  });

  it('reserves request weight atomically and uses observed IP weight', async () => {
    process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE = '20';
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() => Promise.resolve(success()));
    const client = new ProviderHttpClient(redis);
    for (let i = 0; i < 10; i++) await client.getJson(url, options);
    await expect(client.getJson(url, options)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
    expect(fetch).toHaveBeenCalledTimes(10);
    await redis.delete(STATE);
    fetch.mockResolvedValueOnce(
      new Response('{}', { headers: { 'X-MBX-USED-WEIGHT-1M': '600' } }),
    );
    await client.getJson(url, options);
    await expect(client.getJson(url, options)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
    expect(fetch).toHaveBeenCalledTimes(11);
  });

  it.each(['long-first', 'short-first', 'overlapped'] as const)(
    'preserves long unrecorded restrictions across %s write ordering and instances',
    async (order) => {
      let rejectLong!: (error: Error) => void;
      let longStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        longStarted = resolve;
      });
      let failed = false;
      const proxy = {
        eval: (script: string, keys: string[], args: string[]) => {
          if (args[0] === 'long' && !failed) {
            failed = true;
            longStarted();
            if (order === 'overlapped')
              return new Promise((_resolve, reject) => {
                rejectLong = reject;
              });
            return Promise.reject(new Error('redis://private:secret@host'));
          }
          return redis.eval(script, keys, args);
        },
      };
      const coordinator = new BinanceRestCoordinator(proxy as never);
      if (order === 'short-first')
        await coordinator.complete('short', 'limited', 1000, 429);
      const long = coordinator
        .complete('long', 'limited', 120_000, 418)
        .catch((error: unknown) => error);
      await started;
      if (order !== 'short-first')
        await coordinator.complete('short', 'limited', 1000, 429);
      if (order === 'overlapped')
        rejectLong(new Error('private write failure'));
      const error = await long;
      expect(error).toMatchObject({
        code: 'BINANCE_REST_COORDINATION_UNAVAILABLE',
      });
      expect(JSON.stringify(error)).not.toMatch(/secret|private|redis:\/\//);
      await expect(coordinator.acquire(url, 1000)).rejects.toMatchObject({
        code: 'PROVIDER_RATE_LIMITED',
      });
      await expect(
        new BinanceRestCoordinator(redisB).acquire(url, 1000),
      ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
      const remaining = await redis.eval(
        "local t=redis.call('TIME'); return tonumber(redis.call('HGET',KEYS[1],'until'))-tonumber(t[1])*1000",
        [STATE],
      );
      expect(Number(remaining)).toBeGreaterThan(119_000);
      await expireBlock();
      const token = await new BinanceRestCoordinator(redisB).acquire(url, 1000);
      await expect(
        new BinanceRestCoordinator(redisB).acquire(url, 1000),
      ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
      await coordinator.complete(token, 'success');
    },
  );

  it('publishes a newly unrecorded ban before an existing slot waiter can proceed', async () => {
    let restricted = false;
    let acquisitions = 0;
    let markWaiting!: () => void;
    const waiting = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });
    const proxy = {
      eval: (script: string, keys: string[], args: string[]) => {
        if (args.length === 5 && ++acquisitions === 3) markWaiting();
        if (args.length === 6 && args[1] === 'limited' && !restricted) {
          restricted = true;
          return Promise.reject(new Error('private Redis write failure'));
        }
        return redis.eval(script, keys, args);
      },
    };
    const owner = new BinanceRestCoordinator(proxy as never);
    const tokens = await Promise.all([
      owner.acquire(url, 1000),
      owner.acquire(url, 1000),
    ]);
    const pending = owner.acquire(url, 1000).catch((error: unknown) => error);
    await waiting;
    await expect(
      owner.complete(tokens[0], 'limited', 120_000, 418),
    ).rejects.toMatchObject({ code: 'BINANCE_REST_COORDINATION_UNAVAILABLE' });
    await owner.complete(tokens[1], 'success');
    expect(await pending).toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
  });

  it('waits for ordinary slot release across clients but never retries HTTP', async () => {
    const owner = new BinanceRestCoordinator(redis);
    const tokens = await Promise.all([
      owner.acquire(url, 1000),
      owner.acquire(url, 1000),
    ]);
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(success());
    const pending = new ProviderHttpClient(redis).getJson(url, options);
    await owner.complete(tokens[0], 'success');
    await expect(pending).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(1);
    await owner.complete(tokens[1], 'success');
  });

  it('stops a waiting caller immediately on a newly published ban', async () => {
    const owner = new BinanceRestCoordinator(redis);
    const tokens = await Promise.all([
      owner.acquire(url, 1000),
      owner.acquire(url, 1000),
    ]);
    const fetch = jest.spyOn(global, 'fetch');
    const pending = new ProviderHttpClient(redis)
      .getJson(url, options)
      .catch((error: unknown) => error);
    await owner.complete(tokens[0], 'limited', 120_000, 418);
    expect(await pending).toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    expect(fetch).not.toHaveBeenCalled();
    await owner.complete(tokens[1], 'failure');
  });

  it('retains a restriction when Redis recording fails and republishes it before another HTTP request', async () => {
    let failCompletion = true;
    const proxy = {
      eval: async (script: string, keys: string[], args: string[]) => {
        if (failCompletion && args.length === 6)
          throw new Error('private Redis outage');
        return redis.eval(script, keys, args);
      },
    };
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(limited(418));
    const client = new ProviderHttpClient(proxy as never);
    await expect(client.getJson(url, options)).rejects.toMatchObject({
      rateLimit: { status: 418 },
    });
    await expect(client.getJson(url, options)).rejects.toMatchObject({
      code: 'BINANCE_REST_COORDINATION_UNAVAILABLE',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    failCompletion = false;
    await expect(client.getJson(url, options)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
    await expect(
      new ProviderHttpClient(redis).getJson(url, options),
    ).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reserves documented Futures weights without unnecessarily exhausting normal Mark recovery', async () => {
    process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE = '20';
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() => Promise.resolve(success()));
    const client = new ProviderHttpClient(redis);
    for (const path of [
      '/fapi/v1/exchangeInfo',
      '/fapi/v1/premiumIndex',
      '/fapi/v1/premiumIndex?symbol=BTCUSDT',
    ])
      await client.getJson(`https://fixture.invalid${path}`, options);
    for (let i = 0; i < 4; i++) await client.getJson(url, options);
    await expect(client.getJson(url, options)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it('reserves Futures Last re-confirmation at its documented weight (2 all, 1 single)', async () => {
    process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE = '20';
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockImplementation(() => Promise.resolve(success()));
    const client = new ProviderHttpClient(redis);
    const all = 'https://fixture.invalid/fapi/v2/ticker/price';
    for (let i = 0; i < 9; i++) await client.getJson(all, options);
    await client.getJson(`${all}?symbol=BTCUSDT`, options);
    await client.getJson(`${all}?symbol=ETHUSDT`, options);
    await expect(client.getJson(all, options)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
    expect(fetch).toHaveBeenCalledTimes(11);
  });

  it('keeps non-Binance requests independent of an active ban', async () => {
    const fetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(limited(418))
      .mockImplementation(() => Promise.resolve(success()));
    const client = new ProviderHttpClient(redis);
    await expect(client.getJson(url, options)).rejects.toMatchObject({
      code: 'PROVIDER_RATE_LIMITED',
    });
    await expect(
      client.getJson('https://kis.fixture.invalid', {
        ...options,
        provider: 'kis',
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      client.getJson('https://fx.fixture.invalid', {
        ...options,
        provider: 'exchange_rate_api',
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
