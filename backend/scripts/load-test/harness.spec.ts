import {
  defaultManifest,
  validateCredentials,
  validateManifest,
  PRODUCTION_IDS,
  hash,
  workloadHash,
  type Credentials,
} from './manifest';
import { Histogram, Metrics } from './metrics';
import { ledgerChain, fxAuditAmounts } from './audit';
import { FxService } from '../../src/fx/fx.service';
import { Prisma } from '../../src/generated/prisma/client';
import { DOMESTIC_MARKET, providerFrames, Replay, STOCKS } from './replay';
import { KoscomClient } from '../../src/providers/koscom/koscom.client';
import { readKoscomConfig } from '../../src/providers/koscom/koscom.config';
import { KoscomMarketMapService } from '../../src/providers/koscom/koscom-market-map.service';
import { parseBinanceAggTrade } from '../../src/futures/futures-last-price';
import { parseBinanceMark } from '../../src/futures/futures-mark';
import { parseBinanceFiveMinuteKline } from '../../src/providers/binance/binance-kline.parser';
import { parseBinanceWebSocketMessage } from '../../src/providers/binance/binance-websocket.parser';
import { parseBinanceDepth } from '../../src/providers/binance/binance-order-book.parser';
import {
  parseBinanceFuturesDepth,
  parseBinanceFuturesTicker,
} from '../../src/futures/futures-market-data';
import { Actor, nextScreen, random, initialScreen } from './actor';
import { judge, type RunFacts } from './verdict';
import { AppClient } from './client';
import { instrumentPg, instrumentMethod } from './server-metrics';
import pg from 'pg';
import { HttpException } from '@nestjs/common';
import { installNetworkGuard } from './network-guard';
import net from 'node:net';
import { preflight } from './preflight';
import { hasMetricSamples } from './observe';
import { instrumentValkey } from './server-metrics';
import { PROVIDER_FRESHNESS_THRESHOLDS_SECONDS } from '../../src/providers/source-eligibility.policy';
import { AuthEmailService } from '../../src/auth/auth-email.service';
import { readEmailAuthConfig } from '../../src/auth/email-auth.config';
import {
  LOAD_TEST_EMAIL_API_KEY,
  authEmailMailboxKey,
  loadTestEmailEnvironment,
} from './auth-email';

const make = () => defaultManifest('a'.repeat(40), true);
const creds: Credentials = {
  databaseUrl:
    'postgresql://load_test_runner:load-test-local-only@127.0.0.1:55431/trading_load_test',
  valkeyUrl: 'redis://127.0.0.1:56381/0',
  jwtSecret: 'load-test-' + 'j'.repeat(30),
  userPassword: 'load-test-' + 'p'.repeat(30),
  controlSecret: 'load-test-' + 'c'.repeat(30),
};
describe('fail-closed target / manifest guards', () => {
  it('refreshes synthetic FX through its normal ingestion before execution evidence expires', () => {
    const m = make();
    expect(m.replay.fxIntervalSeconds * 2).toBeLessThanOrEqual(
      PROVIDER_FRESHNESS_THRESHOLDS_SECONDS.fxUsdKrwExecute,
    );
    m.replay.fxIntervalSeconds = 3600;
    expect(() => validateManifest(m)).toThrow();
    delete (m.replay as Partial<typeof m.replay>).fxIntervalSeconds;
    expect(() => validateManifest(m)).toThrow('replay FX cadence');
  });
  it('refuses an operational target before opening any database connection', async () => {
    const m = make();
    m.target.apiOrigin = 'https://trading-app-qtsw.onrender.com';
    const spy = jest.spyOn(pg.Client.prototype, 'connect');
    try {
      await expect(preflight(m, creds)).rejects.toThrow('production target');
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
  it('fails closed for uncoordinated multiple generators', () => {
    const m = make();
    m.generator.shardCount = 2;
    expect(() => validateManifest(m)).toThrow('single generator only');
  });
  it('accepts an explicitly dedicated local smoke target', () =>
    expect(() => validateCredentials(make(), creds)).not.toThrow());
  it.each(PRODUCTION_IDS)(
    'rejects production physical resource %s before connecting',
    (id) => {
      const m = make();
      m.target.databaseResourceId = id;
      expect(() => validateCredentials(m, creds)).toThrow('production target');
    },
  );
  it('rejects production API and encoded database host override', () => {
    const m = make();
    m.target.apiOrigin = 'https://trading-app-qtsw.onrender.com';
    expect(() => validateManifest(m)).toThrow('production target');
    expect(() =>
      validateCredentials(make(), {
        ...creds,
        databaseUrl: creds.databaseUrl + '?%68ost=production',
      }),
    ).toThrow('database credential scope');
  });
  it.each([
    'database',
    'user',
    'port',
    'connection_limit',
    'options',
    'password',
  ])('rejects pg query parameter override %s', (q) =>
    expect(() =>
      validateCredentials(make(), {
        ...creds,
        databaseUrl: creds.databaseUrl + `?${q}=foreign`,
      }),
    ).toThrow(),
  );
  it('rejects Redis DB-number/prefix pseudo-isolation', () =>
    expect(() =>
      validateCredentials(make(), {
        ...creds,
        valkeyUrl: creds.valkeyUrl.replace('/0', '/2'),
      }),
    ).toThrow('separate physical'));
  it('rejects inherited production-style secrets', () =>
    expect(() =>
      validateCredentials(make(), {
        ...creds,
        jwtSecret: 'production-like-secret',
      }),
    ).toThrow('test-only'));
  it('requires cloud approval and TLS', () => {
    const m = make();
    m.target.apiOrigin = 'https://approved-test.onrender.com';
    expect(() => validateManifest(m)).toThrow('cloud approval');
  });
  it('keeps smoke <=20 and the baseline at exactly 1000/5/60/5', () => {
    const m = make();
    m.users = 21;
    expect(() => validateManifest(m)).toThrow('maximum 20');
    const b = defaultManifest('a'.repeat(40));
    expect(() => validateManifest(b)).not.toThrow();
    b.holdSeconds = 90;
    expect(() => validateManifest(b)).toThrow('baseline must');
  });
  it('rejects an external socket before any connection/DNS attempt', async () => {
    let blocked = 0;
    const restore = await installNetworkGuard(make(), () => blocked++);
    try {
      expect(() => net.connect({ host: 'api.binance.com', port: 443 })).toThrow(
        'NETWORK_BLOCKED',
      );
      expect(blocked).toBe(1);
    } finally {
      restore();
    }
  });
});
describe('deterministic provider transports retain real parsers', () => {
  it('keeps workload identity across cloud targets while ratios change it', () => {
    const a = make(),
      b = make();
    b.runId = 'lightsail-baseline';
    b.target.apiOrigin = 'https://test.example.invalid';
    expect(workloadHash(a)).toBe(workloadHash(b));
    b.spot.buyRatio = 0.7;
    expect(workloadHash(a)).not.toBe(workloadHash(b));
  });
  it('has repeatable wire bytes and seed-sensitive prices', () => {
    const m = make();
    const f = providerFrames('BTCUSDT', 10, 1700000000000, m);
    expect(JSON.stringify(f)).toBe(
      JSON.stringify(providerFrames('BTCUSDT', 10, 1700000000000, m)),
    );
    m.seed++;
    expect(hash(f)).not.toBe(
      hash(providerFrames('BTCUSDT', 10, 1700000000000, m)),
    );
  });
  it('passes Spot ticker/candle/depth and Futures Last/Mark parsers', () => {
    const m = make(),
      epoch = 1700000000000,
      f = providerFrames('BTCUSDT', 10, epoch, m),
      at = new Date(epoch + 10 * m.replay.tickMs);
    expect(
      parseBinanceWebSocketMessage({
        frame: JSON.stringify(f.ticker),
        receivedAt: at,
      }).state,
    ).toBe('ticker');
    expect(parseBinanceFiveMinuteKline(JSON.stringify(f.candle)).state).toBe(
      'kline',
    );
    expect(parseBinanceDepth(JSON.stringify(f.book)).state).toBe('depth');
    expect(parseBinanceAggTrade(f.last, 'BTCUSDT', at) !== null).toBe(true);
    expect(
      parseBinanceMark(f.mark, 'binance_usdm_mark_ws', 'BTCUSDT', at) !== null,
    ).toBe(true);
  });
  it('passes the USDⓈ-M order book and 24h ticker parsers', () => {
    const m = make(),
      epoch = 1700000000000,
      f = providerFrames('BTCUSDT', 10, epoch, m),
      at = new Date(epoch + 10 * m.replay.tickMs);
    expect(parseBinanceFuturesDepth(f.futuresDepth).state).toBe('depth');
    expect(parseBinanceFuturesTicker(f.futuresTicker, at).state).toBe('ticker');
    // A Spot book (no `@500ms` stream, Spot shape) is not a futures book.
    // Tickers share a shape, so Spot/Futures separation is by connection:
    // display ingestion only ever connects to fstream.binance.com routes.
    expect(parseBinanceFuturesDepth(f.book).state).toBe('other');
  });
  it.each([
    [
      'wss://fstream.binance.com/public/stream',
      'btcusdt@depth10@500ms',
      'futuresDepth',
    ],
    [
      'wss://fstream.binance.com/market/stream',
      'btcusdt@ticker',
      'futuresTicker',
    ],
    ['wss://fstream.binance.com/market/stream', 'btcusdt@aggTrade', 'last'],
    ['wss://fstream.binance.com/market/stream', 'btcusdt@markPrice@1s', 'mark'],
  ])('classifies %s subscribing %s as %s', (url, stream, kind) => {
    const replay = new Replay(make(), new Metrics());
    const socket = replay.createSocket(url);
    socket.send(
      JSON.stringify({ method: 'SUBSCRIBE', params: [stream], id: 1 }),
    );
    expect(socket.kind).toBe(kind);
    socket.close();
  });
  it('routes the CURRENT shared Futures URL by its subscribed stream', async () => {
    const replay = new Replay(make(), new Metrics());
    const socket = replay.createSocket(
      'wss://fstream.binance.com/market/stream',
    );
    socket.send(
      JSON.stringify({
        method: 'SUBSCRIBE',
        params: ['btcusdt@aggTrade'],
        id: 1,
      }),
    );
    expect(socket.kind).toBe('last');
    socket.close();
  });
  it('returns JSON transport responses without external HTTP and blocks unknown paths', async () => {
    const metrics = new Metrics(),
      replay = new Replay(make(), metrics);
    const r = await replay.fetch(
      'https://fapi.binance.com/fapi/v1/exchangeInfo',
    );
    expect(Array.isArray((await r.json()).symbols)).toBe(true);
    await expect(
      replay.fetch('https://api.binance.com/unapproved'),
    ).rejects.toThrow('EXTERNAL_PROVIDER_HTTP_BLOCKED');
    expect(
      metrics.counters['prepare:failure:EXTERNAL_PROVIDER_HTTP_BLOCKED'],
    ).toBe(1);
  });
  it('serves the KOSCOM paths the client requests only while KRX is open', async () => {
    const metrics = new Metrics(),
      replay = new Replay(make(), metrics);
    const list = async (market: string) => {
      const response = await replay.fetch(
        `https://oap.k-mydata.org/v3/market/closed/${market}/lists?apikey=load-test-koscom-key`,
      );
      const body = (await response.json()) as {
        isuLists: Array<{ isuSrtCd: string }>;
      };
      return body.isuLists.map((row) => row.isuSrtCd);
    };
    const kospi = await list('kospi');
    const kosdaq = await list('kosdaq');
    const konex = await list('konex');
    expect(kospi.includes('005930')).toBe(true);
    expect(kosdaq.includes('005930')).toBe(false);
    expect(kosdaq.includes('086520')).toBe(true);
    expect(kospi.includes('086520')).toBe(false);
    // KRX KIND membership: the 3 first-phase KOSDAQ stocks, then the 13 of
    // the 2026-10-17 expansion (KOSPI 54 / KOSDAQ 16 in all).
    expect(kosdaq).toEqual([
      '086520',
      '247540',
      '028300',
      '036930',
      '010170',
      '032820',
      '080220',
      '196170',
      '403870',
      '240810',
      '090710',
      '000250',
      '277810',
      '108490',
      '058470',
      '298380',
    ]);
    expect(kospi).toHaveLength(54);
    expect(konex.length).toBe(0);
    expect(kospi.some((symbol) => kosdaq.includes(symbol))).toBe(false);
    // Every fixed domestic stock is listed exactly once, and nothing else is.
    const domestic = STOCKS.filter((a) => a.assetType === 'domestic_stock').map(
      (a) => a.symbol,
    );
    const listed = [...kospi, ...kosdaq, ...konex];
    expect(domestic.length).toBe(70);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...domestic].sort());
    expect(listed.every((symbol) => /^\d{6}$/.test(symbol))).toBe(true);
    expect(
      STOCKS.some(
        (a) => a.assetType === 'us_stock' && listed.includes(a.symbol),
      ),
    ).toBe(false);
    const intraday = await replay.fetch(
      'https://oap.k-mydata.org/v3/market/realtime/kospi/stocks/005930/intraday?inddCycleTpCd=60&inqStrtDd=20261014&strtTm=1020&endTm=1027&apikey=load-test-koscom-key',
    );
    const page = (await intraday.json()) as {
      jsonrpc: string;
      result: { isuSrtCd: string; hisLists: unknown[] };
    };
    expect(page.jsonrpc).toBe('2.0');
    expect(page.result.isuSrtCd).toBe('005930');
    expect(page.result.hisLists.length).toBe(0);
    expect(
      metrics.counters['prepare:failure:EXTERNAL_PROVIDER_HTTP_BLOCKED'],
    ).toBe(undefined);
    await expect(
      replay.fetch(
        'https://oap.k-mydata.org/v3/market/closed/kosdaq/086520/history?apikey=load-test-koscom-key',
      ),
    ).rejects.toThrow('EXTERNAL_PROVIDER_HTTP_BLOCKED');
    expect(
      metrics.counters['prepare:failure:EXTERNAL_PROVIDER_HTTP_BLOCKED'],
    ).toBe(1);
  });
  it('lets the KOSCOM market map tell KOSPI from KOSDAQ through replayed lists', async () => {
    const metrics = new Metrics(),
      replay = new Replay(make(), metrics);
    const env = {
      KOSCOM_API_KEY: 'load-test-koscom-key',
      PROVIDER_INGESTION_ENABLED: 'true',
      KOSCOM_MIN_REQUEST_INTERVAL_MS: '50',
    };
    const config = { getConfig: () => readKoscomConfig(env) };
    const redis = {
      get: () => Promise.resolve(null),
      setNxPx: () => Promise.resolve(true),
      setWithTtl: () => Promise.resolve(),
    };
    const locks = {
      acquire: () => Promise.resolve({ status: 'acquired', lock: {} }),
      release: () => Promise.resolve(true),
    };
    const map = new KoscomMarketMapService(
      new KoscomClient(config as never, redis as never, locks as never),
      redis as never,
      config as never,
    );
    const savedFetch = globalThis.fetch;
    globalThis.fetch = replay.fetch as typeof fetch;
    try {
      expect(await map.resolve('005930', 'KRX')).toBe('kospi');
      expect(await map.resolve('086520', 'KRX')).toBe('kosdaq');
      const domestic = STOCKS.filter((a) => a.assetType === 'domestic_stock');
      const resolved = await Promise.all(
        domestic.map((a) => map.resolve(a.symbol, a.market)),
      );
      expect(resolved).toEqual(domestic.map((a) => DOMESTIC_MARKET[a.symbol]));
      await expect(map.resolve('086520', 'KOSPI')).rejects.toThrow(
        'KOSCOM_MARKET_MISMATCH',
      );
      await expect(map.resolve('005930', 'KOSDAQ')).rejects.toThrow(
        'KOSCOM_MARKET_MISMATCH',
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
    expect(
      metrics.counters['prepare:failure:EXTERNAL_PROVIDER_HTTP_BLOCKED'],
    ).toBe(undefined);
  });
  it('answers the server’s own signup mail into the run mailbox and blocks any other mail', async () => {
    const env = loadTestEmailEnvironment(creds);
    // The server's settings pass the app's own email configuration check.
    expect(readEmailAuthConfig(env)).toEqual({
      apiKey: LOAD_TEST_EMAIL_API_KEY,
      from: 'Trading Class <admin@nanghwa.com>',
      secret: env.EMAIL_VERIFICATION_SECRET,
    });
    const metrics = new Metrics(),
      replay = new Replay(make(), metrics);
    const mailService = new AuthEmailService({
      get: (key: string) => env[key as keyof typeof env],
    } as never);
    const challengeId = '0b9f3c2e-4f6a-4c1d-9e8b-7a6d5c4b3a21';
    const savedFetch = globalThis.fetch;
    globalThis.fetch = replay.fetch as typeof fetch;
    try {
      // Without the server's mailbox there is no mail provider at all.
      await expect(
        mailService.send(
          'a-1@example.invalid',
          'signup',
          '012345',
          challengeId,
        ),
      ).rejects.toMatchObject({
        response: { error: { code: 'EMAIL_UNAVAILABLE' } },
      });
      const delivered: { challengeId: string; code: string }[] = [];
      replay.mailbox = (mail) => {
        delivered.push(mail);
        return Promise.resolve();
      };
      // The real AuthEmailService request: exactly its code, keyed by challenge.
      await mailService.send(
        'a-1@example.invalid',
        'signup',
        '012345',
        challengeId,
      );
      expect(delivered).toEqual([{ challengeId, code: '012345' }]);
      const blocked = (init: RequestInit) =>
        expect(
          replay.fetch('https://api.resend.com/emails', init),
        ).rejects.toThrow('EXTERNAL_PROVIDER_HTTP_BLOCKED');
      const body = {
        from: 'Trading Class <admin@nanghwa.com>',
        to: ['a-2@example.invalid'],
        text: 'Trading Class 이메일 인증번호\n\n인증번호: 654321\n',
      };
      const headers = {
        Authorization: `Bearer ${LOAD_TEST_EMAIL_API_KEY}`,
        'Idempotency-Key': `auth-email/${challengeId}`,
      };
      await blocked({
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, to: ['someone@example.com'] }),
      });
      await blocked({
        method: 'POST',
        headers: { ...headers, Authorization: 'Bearer re_other' },
        body: JSON.stringify(body),
      });
      await blocked({
        method: 'POST',
        headers: { Authorization: headers.Authorization },
        body: JSON.stringify(body),
      });
      expect(delivered.length).toBe(1);
    } finally {
      globalThis.fetch = savedFetch;
    }
    expect(authEmailMailboxKey(challengeId)).toBe(
      `load-test:auth-email:${challengeId}`,
    );
  });
});
describe('workload, histogram and exact financial checks', () => {
  it('allocates the 1000 initial states to 30/25/10/15/15/5', () => {
    const m = defaultManifest('a'.repeat(40));
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      const s = initialScreen(m, i);
      counts[s] = (counts[s] ?? 0) + 1;
    }
    expect(JSON.stringify(counts)).toBe(
      JSON.stringify({
        market: 300,
        detail: 250,
        spot: 100,
        futures: 150,
        home: 150,
        historyFx: 50,
      }),
    );
  });
  it('uses dwell-weighted transitions and users actually move', () => {
    const m = make(),
      r = random(7);
    const counts: Record<string, number> = {};
    const time: Record<string, number> = {};
    for (let i = 0; i < 100000; i++) {
      const s = nextScreen(m, r);
      counts[s] = (counts[s] ?? 0) + 1;
      time[s] =
        (time[s] ?? 0) + (m.dwellSeconds[s][0] + m.dwellSeconds[s][1]) / 2;
    }
    const total = Object.values(time).reduce((a, b) => a + b, 0);
    for (const [s, v] of Object.entries(m.screenWeights))
      expect(Math.abs(time[s] / total - v)).toBeLessThan(0.01);
    expect(Object.keys(counts).length).toBe(6);
  });
  it('merges buckets rather than averaging shard p95', () => {
    const a = new Histogram(),
      b = new Histogram();
    for (let i = 0; i < 100; i++) a.add(10);
    for (let i = 0; i < 5; i++) b.add(1000);
    a.merge(b);
    expect(a.count).toBe(105);
    expect(a.percentile(0.95)).toBeLessThan(11);
    expect(a.percentile(0.99)).toBe(1000);
  });
  it('checks same-time ledger legs in economic balance order', () => {
    const at = new Date(1);
    const rows = [
      { amount: '2', direction: 'debit', balanceAfter: '8', occurredAt: at },
      { amount: '10', direction: 'credit', balanceAfter: '10', occurredAt: at },
    ];
    expect(ledgerChain(rows, '8')).toBe(true);
    expect(ledgerChain(rows, '8.00000001')).toBe(false);
    expect(ledgerChain([...rows, rows[0]], '6')).toBe(false);
  });
  it('audits standalone provider FX at its existing persistence rounding boundary', () => {
    const input = {
      fromCurrency: 'KRW' as const,
      toCurrency: 'USD' as const,
      sourceAmount: '1400000',
      appliedRate: '1400.5',
      feeRate: '0.001000',
    };
    // Execute the actual unchanged financial calculation, rather than the
    // historical helper that the provider execute path no longer calls.
    const service = new FxService({} as never) as unknown as {
      buildProviderFxExecutePlan(input: unknown): {
        grossTargetAmount: string;
        feeAmount: string;
        netTargetAmount: string;
      };
    };
    const plan = service.buildProviderFxExecutePlan({
      normalizedRequest: { ...input, userId: 'user', idempotencyKey: 'key' },
      quote: {
        quotedRate: new Prisma.Decimal(input.appliedRate),
        maxChangeBps: 30,
      },
      sourceWallet: {
        id: 'source',
        currencyCode: 'KRW',
        balanceAmount: '2000000',
      },
      targetWallet: { id: 'target', currencyCode: 'USD', balanceAmount: '0' },
      fxFeeRate: input.feeRate,
      providerSnapshot: {
        id: 'rate',
        sourceType: 'provider_api',
        rate: new Prisma.Decimal(input.appliedRate),
        capturedAt: new Date(),
        effectiveAt: new Date(),
        sourceDecision: {
          sourceType: 'provider_api',
          sourceName: 'exchange_rate_api_usd_krw',
        },
      },
      executeNow: new Date(),
    });
    const expected = fxAuditAmounts(input);
    expect(expected.grossTargetAmount).toBe('999.64298465');
    expect(expected.feeAmount).toBe('0.99964298');
    expect(expected.netTargetAmount).toBe('998.64334166');
    for (const key of [
      'grossTargetAmount',
      'feeAmount',
      'netTargetAmount',
    ] as const) {
      expect(plan[key]).toBe(expected[key]);
      // A single storage unit of damage must still fail exact equality.
      expect(
        new Prisma.Decimal(plan[key]).add('0.00000001').eq(expected[key]),
      ).toBe(false);
    }
    expect(
      new Prisma.Decimal(expected.grossTargetAmount)
        .sub(expected.feeAmount)
        .toFixed(8),
    ).toBe('998.64334167');
    expect(() => fxAuditAmounts({ ...input, feeRate: '-0.001' })).toThrow();
    expect(() => fxAuditAmounts({ ...input, feeRate: '2' })).toThrow();
  });
  it('separates correctness / performance / capacity and invalidates missing workload', () => {
    const metrics = new Metrics();
    metrics.phase = 'hold';
    metrics.count('http.request.GET /me', 10000);
    metrics.time('http.GET /me', 100);
    metrics.count('ws.message.asset_ticker');
    metrics.time('ws.ingressLatency.asset_ticker', 20);
    const facts: RunFacts = {
      completed: true,
      rampAcked: 10,
      expectedUsers: 10,
      connectedUserSeconds: 900,
      holdSeconds: 90,
      observerFailures: 0,
      generatorInvalidReasons: [],
      serviceFailures: [],
      auditVerdict: 'CORRECTNESS FAIL',
    };
    const result = judge(make(), metrics, facts);
    expect(result.correctness).toBe('CORRECTNESS FAIL');
    expect(result.performance).toBe('PERFORMANCE PASS');
    expect(result.capacityHeadroom.verdict).toBe('REVIEW MEASURED HEADROOM');
    facts.generatorInvalidReasons.push('GENERATOR_CPU');
    expect(judge(make(), metrics, facts).performance).toBe('NOT EVALUATED');
  });
});

describe('real client request contracts', () => {
  it('uses amount for Crypto BUY and six-place quantity for SELL', async () => {
    const m = make(),
      metrics = new Metrics();
    const bodies: any[] = [];
    const http: any = {
      get: async (path: string) =>
        path.includes('/positions')
          ? {
              positions: [
                {
                  assetId: 'asset',
                  quantity: '1.00000000',
                  reservedQuantity: '0',
                },
              ],
            }
          : { asset: { price: { currentPrice: '100' } } },
      request: async (_method: string, path: string, body: any) => {
        bodies.push({ path, body });
        return path.endsWith('/quote')
          ? { quoteId: 'quote' }
          : { order: { id: 'order' } };
      },
      invalidate: () => {},
    };
    const f: any = {
      assets: [{ id: 'asset', assetType: 'crypto', symbol: 'BTCUSDT' }],
      instruments: [],
    };
    const a = new Actor(
      m,
      {
        index: 0,
        email: 'test@example.invalid',
        userId: 'user',
        accountId: 'account',
        mode: 'general',
      },
      f,
      http,
      metrics,
      '/tmp/load-test-contract.commands.jsonl',
    );
    await a.spotTrade('buy', f.assets[0], 'market');
    await a.spotTrade('sell', f.assets[0], 'market');
    expect(bodies[0].body.amount).toBe('10.00000000');
    expect(bodies[0].body.quantity === undefined).toBe(true);
    expect(bodies[2].body.quantity).toBe('0.100000');
    expect(bodies[2].body.amount === undefined).toBe(true);
  });
  it('distinguishes Mark valuation from Last execution and emits bounded candles', () => {
    const f = providerFrames('BTCUSDT', 10, 1700000000000, make());
    expect(f.mark.p === f.last.p).toBe(false);
    expect(Number(f.candle.data.k.h) >= Number(f.candle.data.k.c)).toBe(true);
    expect(Number(f.candle.data.k.l) <= Number(f.candle.data.k.c)).toBe(true);
    expect(f.candle.data.k.x).toBe(false);
  });
});

describe('measurement preserves existing behavior', () => {
  it('rejects empty cloud metrics rather than treating them as zero CPU', () => {
    expect(hasMetricSamples([])).toBe(false);
    expect(hasMetricSamples([{ unit: 'cores', values: [] }])).toBe(false);
    expect(
      hasMetricSamples([
        {
          unit: 'cores',
          values: [{ timestamp: '2026-10-11T00:00:00Z', value: 0 }],
        },
      ]),
    ).toBe(true);
  });
  it('keeps Valkey timeout failures and records the unchanged outcome', async () => {
    const error = new Error('Redis command timed out.');
    const instance = {
      ensureConnected: async () => true,
      runCommand: async () => {
        throw error;
      },
    };
    const metrics = new Metrics();
    instrumentValkey(instance, metrics);
    expect(await instance.ensureConnected()).toBe(true);
    await expect(instance.runCommand()).rejects.toBe(error);
    expect(metrics.counters['prepare:failure:VALKEY_TIMEOUT']).toBe(1);
  });
  it('canonicalizes JSONB key order without ignoring financial value changes', () => {
    expect(hash({ b: '2', a: '1' })).toBe(hash({ a: '1', b: '2' }));
    expect(hash({ a: '1.00000001', b: '2' })).not.toBe(
      hash({ b: '2', a: '1.00000000' }),
    );
  });
  it('retains pg Promise/callback results and errors', async () => {
    const saved = pg.Client.prototype.query;
    const result = { rowCount: 1 };
    const failure = Object.assign(new Error('test'), { code: '40P01' });
    (pg.Client.prototype as any).query = function (...args: any[]) {
      const cb = args.at(-1);
      if (args[0] === 'THROW') throw failure;
      if (typeof cb === 'function') {
        cb(null, result);
        return undefined;
      }
      return args[0] === 'FAIL'
        ? Promise.reject(failure)
        : Promise.resolve(result);
    };
    const metrics = new Metrics(),
      hooks = instrumentPg(metrics);
    const client = new pg.Client();
    try {
      expect((await client.query('SELECT 1')).rowCount).toBe(1);
      await new Promise<void>((resolve, reject) =>
        client.query('SELECT 1', (error, res) => {
          if (error) reject(error);
          else {
            expect(res.rowCount).toBe(1);
            resolve();
          }
        }),
      );
      await expect(client.query('FAIL')).rejects.toBe(failure);
      expect(() => client.query('THROW')).toThrow('test');
      expect(metrics.counters['prepare:failure:PG_40P01']).toBe(2);
    } finally {
      hooks.close();
      pg.Client.prototype.query = saved;
    }
  });
  it('records ordinary not-reached worker states and forwards rejection', async () => {
    const deferred = new HttpException(
      { error: { code: 'FUTURES_ENTRY_LIMIT_NOT_REACHED' } },
      409,
    );
    const instance = {
      evaluate: async () => {
        throw deferred;
      },
    };
    const metrics = new Metrics();
    instrumentMethod(instance, 'evaluate', metrics, 'entry', true);
    await expect(instance.evaluate()).rejects.toBe(deferred);
    expect(metrics.failures.length).toBe(0);
    expect(
      metrics.counters[
        'prepare:worker.state.entry.FUTURES_ENTRY_LIMIT_NOT_REACHED'
      ],
    ).toBe(1);
  });
  it('uses normal refresh once for concurrent expired HTTP and deduplicates cached reads', async () => {
    const saved = globalThis.fetch;
    let refresh = 0,
      reads = 0;
    const client = new AppClient(
      make(),
      creds,
      'test@example.invalid',
      new Metrics(),
    );
    client.accessToken = 'expired';
    client.refreshToken = 'normal-refresh';
    globalThis.fetch = async (_url: any, options: any) => {
      const url = String(_url);
      if (url.endsWith('/auth/refresh')) {
        refresh++;
        await new Promise((r) => setTimeout(r, 10));
        return new Response(
          JSON.stringify({
            success: true,
            data: { tokens: { accessToken: 'fresh', refreshToken: 'rotated' } },
          }),
          { status: 200 },
        );
      }
      reads++;
      return new Response(
        JSON.stringify(
          options.headers.authorization === 'Bearer fresh'
            ? { success: true, data: { value: '1.00000000' } }
            : { success: false, error: { code: 'TOKEN_EXPIRED' } },
        ),
        {
          status: options.headers.authorization === 'Bearer fresh' ? 200 : 401,
        },
      );
    };
    try {
      await Promise.all([client.get('/me'), client.get('/trading-accounts')]);
      expect(refresh).toBe(1);
      expect(client.refreshCount).toBe(1);
      expect(client.accessToken).toBe('fresh');
      const before = reads;
      await Promise.all([client.get('/me'), client.get('/me')]);
      expect(reads).toBe(before);
    } finally {
      globalThis.fetch = saved;
    }
  });
});
