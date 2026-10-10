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
import { ledgerChain } from './audit';
import { providerFrames, Replay } from './replay';
import { parseBinanceAggTrade } from '../../src/futures/futures-last-price';
import { parseBinanceMark } from '../../src/futures/futures-mark';
import { parseBinanceFiveMinuteKline } from '../../src/providers/binance/binance-kline.parser';
import { parseBinanceWebSocketMessage } from '../../src/providers/binance/binance-websocket.parser';
import { parseBinanceDepth } from '../../src/providers/binance/binance-order-book.parser';
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
