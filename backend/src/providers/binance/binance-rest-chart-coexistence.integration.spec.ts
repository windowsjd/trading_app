jest.mock('../../generated/prisma/client', () => {
  const runtime = jest.requireActual<{ Decimal: unknown }>(
    '@prisma/client/runtime/client',
  );
  return {
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal: runtime.Decimal },
  };
});

import {
  FuturesCandleProviderService,
  readFuturesCandleProviderConfig,
  type FuturesProviderInterval,
} from '../../assets/market-candle-futures-provider.service';
import { FUTURES_LAST_REST_URL } from '../../futures/futures-last-price-ingestion.service';
import { FUTURES_MARK_REST_URL } from '../../futures/futures-mark-ingestion.service';
import { RedisService } from '../../redis/redis.service';
import { ProviderHttpClient } from '../provider-http.client';
import { ProviderHttpError } from '../provider.types';
import { BinanceCandleIngestionService } from './binance-candle.ingestion.service';
import { BinanceUsdmKlineClient } from './binance-kline-usdm.client';
import { BinanceRestCoordinator } from './binance-rest-coordinator';

/**
 * Futures chart reads next to Futures Last/Mark REST recovery on the REAL
 * shared coordinator (2026-10-20): the production budget 1200 and the
 * production chart cap 120, against a local Redis. Binance itself is a stand-in
 * (`fetch` is mocked); everything between a caller and `fetch` — the chart's
 * queue and cap, the kline page parser, ProviderHttpClient and the Redis Lua
 * admission — is the production code.
 *
 * Opt-in like the coordinator fixture (it shares its Redis convention and
 * runs in real time, about three minutes):
 *   BINANCE_REST_REDIS_FIXTURE=1 BINANCE_REST_FIXTURE_REDIS_URL=redis://127.0.0.1:<port>
 *   pnpm exec jest --runInBand src/providers/binance/binance-rest-chart-coexistence.integration.spec.ts
 */
const fixture =
  process.env.BINANCE_REST_REDIS_FIXTURE === '1' ? describe : describe.skip;
const STATE = 'provider:{binance-rest}:state';
const LEASES = 'provider:{binance-rest}:leases';
const LATENCY_MS = 80;
const INTERVAL_MS: Record<string, number> = {
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
};

type Kind = 'chart' | 'last' | 'mark' | 'spot';
type Sent = { kind: Kind; weight: number; at: number };
type Attempt = { ok: boolean; code?: string; at: number };

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The coordinator's own weights for the four routes used here. */
function weightOf(url: URL): number {
  if (url.pathname === '/fapi/v1/klines') {
    const limit = Number(url.searchParams.get('limit'));
    return limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10;
  }
  if (url.pathname === '/api/v3/klines') return 2;
  if (url.pathname === '/fapi/v2/ticker/price') return 2;
  if (url.pathname === '/fapi/v1/premiumIndex') return 10;
  return 80;
}

function klines(url: URL) {
  const intervalMs = INTERVAL_MS[url.searchParams.get('interval') ?? '5m'];
  const limit = Number(url.searchParams.get('limit'));
  const end = Number(url.searchParams.get('endTime'));
  const rows: unknown[] = [];
  for (
    let open = Number(url.searchParams.get('startTime'));
    open <= end && open <= Date.now() && rows.length < limit;
    open += intervalMs
  ) {
    rows.push([
      open,
      '100.0',
      '101.0',
      '99.0',
      '100.5',
      '10',
      open + intervalMs - 1,
      '1005',
      1,
      '5',
      '502',
      '0',
    ]);
  }
  return rows;
}

fixture(
  'Futures chart beside Last/Mark recovery on the shared coordinator',
  () => {
    let redis: RedisService;
    const originalBudget = process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE;
    let sent: Sent[] = [];
    let active = { all: 0, chart: 0 };
    let peak = { all: 0, chart: 0 };

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
      await redis.connect();
    });
    beforeEach(async () => {
      process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE = '1200';
      await redis.delete(STATE);
      await redis.delete(LEASES);
      sent = [];
      active = { all: 0, chart: 0 };
      peak = { all: 0, chart: 0 };
      jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = new URL(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        const kind: Kind =
          url.pathname === '/fapi/v1/klines'
            ? 'chart'
            : url.pathname === '/fapi/v2/ticker/price'
              ? 'last'
              : url.pathname === '/fapi/v1/premiumIndex'
                ? 'mark'
                : 'spot';
        sent.push({ kind, weight: weightOf(url), at: Date.now() });
        active.all += 1;
        peak.all = Math.max(peak.all, active.all);
        if (kind === 'chart') {
          active.chart += 1;
          peak.chart = Math.max(peak.chart, active.chart);
        }
        try {
          await sleep(LATENCY_MS);
        } finally {
          active.all -= 1;
          if (kind === 'chart') active.chart -= 1;
        }
        const body =
          kind === 'chart' || kind === 'spot'
            ? klines(url)
            : [
                {
                  symbol: 'BTCUSDT',
                  price: '100.0',
                  markPrice: '100.0',
                  time: Date.now(),
                },
              ];
        return new Response(JSON.stringify(body), { status: 200 });
      });
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
      }
    });

    const redisNow = async () => {
      const [seconds, micros] = (await redis.eval(
        `return redis.call('TIME')`,
        [],
      )) as [string, string];
      return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
    };

    /** Samples the coordinator's own state: minute weight and live leases. */
    function sampler() {
      const samples: Array<{ weight: number; leases: number }> = [];
      let stop = false;
      const done = (async () => {
        while (!stop) {
          const [weight, leases] = (await redis.eval(
            `return {tonumber(redis.call('HGET',KEYS[1],'weight') or '0'), redis.call('ZCARD',KEYS[2])}`,
            [STATE, LEASES],
          )) as [number, number];
          samples.push({ weight: Number(weight), leases: Number(leases) });
          await sleep(100);
        }
      })();
      return {
        samples,
        stop: async () => {
          stop = true;
          await done;
        },
      };
    }

    /** Futures Last re-confirmation / Mark recovery: one call in flight, every 3 s. */
    async function recoveryLoop(
      http: ProviderHttpClient,
      url: string,
      until: number,
      attempts: Attempt[],
    ) {
      while (Date.now() < until) {
        const started = Date.now();
        try {
          await http.getJson(url, { provider: 'binance', timeoutMs: 2500 });
          attempts.push({ ok: true, at: Date.now() });
        } catch (caught) {
          attempts.push({
            ok: false,
            code: caught instanceof ProviderHttpError ? caught.code : 'other',
            at: Date.now(),
          });
        }
        await sleep(Math.max(0, 3000 - (Date.now() - started)));
      }
    }

    /** The Spot 5m/1d/1w sync: two assets at a time, weight 2 per request. */
    async function spotSync(
      http: ProviderHttpClient,
      requests: number,
      until: number,
    ) {
      let next = 0;
      const refused: string[] = [];
      const worker = async () => {
        while (next < requests && Date.now() < until) {
          next += 1;
          try {
            await http.getJson(
              `https://api.binance.com/api/v3/klines?symbol=ETHUSDT&interval=5m&limit=1000&startTime=${Date.now() - 3_600_000}&endTime=${Date.now()}`,
              { provider: 'binance', timeoutMs: 10_000 },
            );
          } catch (caught) {
            refused.push(
              caught instanceof ProviderHttpError ? caught.code : 'other',
            );
            // A refused sync request defers to the next run; pace the retry.
            await sleep(250);
          }
        }
      };
      await Promise.all([worker(), worker()]);
      return refused;
    }

    function chartReader(http: ProviderHttpClient) {
      return new FuturesCandleProviderService(
        new BinanceCandleIngestionService(new BinanceUsdmKlineClient(http)),
        readFuturesCandleProviderConfig({
          FUTURES_CANDLE_PROVIDER_MAX_CALLS_PER_MINUTE: '120',
        }),
      );
    }

    /** `count` distinct contract × interval series, read the way viewers do. */
    async function chartDemand(
      chart: FuturesCandleProviderService,
      count: number,
      until: number,
      everyMs: number,
    ) {
      const outcomes: string[] = [];
      const pending: Array<Promise<unknown>> = [];
      // No new reads in the last 10 s: the minute cap would admit a second
      // batch at 60 s that outlives the scenario (one reader per process in
      // production; here each scenario has its own).
      while (Date.now() < until - 10_000) {
        for (let index = 0; index < count; index += 1) {
          const interval: FuturesProviderInterval = '5m';
          const symbol = `C${String(index).padStart(3, '0')}USDT`;
          pending.push(
            chart
              .read({ instrumentId: symbol, symbol, interval, now: new Date() })
              .then((read) => outcomes.push(read.stale ? 'stale' : 'fresh'))
              .catch(() => outcomes.push('503')),
          );
        }
        await sleep(everyMs);
      }
      await Promise.all(pending);
      return outcomes;
    }

    function longestGap(attempts: Attempt[], from: number, to: number) {
      const successes = [
        from,
        ...attempts.filter((a) => a.ok).map((a) => a.at),
        to,
      ];
      let gap = 0;
      for (let index = 1; index < successes.length; index += 1) {
        gap = Math.max(gap, successes[index] - successes[index - 1]);
      }
      return gap;
    }

    function perMinute(kind?: Kind) {
      const totals = new Map<number, number>();
      for (const entry of sent) {
        if (kind && entry.kind !== kind) continue;
        const minute = Math.floor(entry.at / 60_000);
        totals.set(minute, (totals.get(minute) ?? 0) + entry.weight);
      }
      return [...totals.values()];
    }

    async function scenario(input: {
      durationMs: number;
      chartSeries: number;
      spotRequests: number;
      mark: boolean;
      /** Start just after a Redis minute boundary: every burst in one minute. */
      alignToMinute?: boolean;
    }) {
      const http = new ProviderHttpClient(redis);
      if (input.alignToMinute) {
        await sleep(60_000 - ((await redisNow()) % 60_000) + 300);
      }
      const start = Date.now();
      const until = start + input.durationMs;
      const last: Attempt[] = [];
      const mark: Attempt[] = [];
      const sampling = sampler();
      const [, , spotRefused, chartOutcomes] = await Promise.all([
        recoveryLoop(http, FUTURES_LAST_REST_URL, until, last),
        input.mark
          ? recoveryLoop(http, FUTURES_MARK_REST_URL, until, mark)
          : Promise.resolve(),
        input.spotRequests > 0
          ? spotSync(http, input.spotRequests, until)
          : Promise.resolve([] as string[]),
        input.chartSeries > 0
          ? chartDemand(chartReader(http), input.chartSeries, until, 5_000)
          : Promise.resolve([] as string[]),
      ]);
      await sampling.stop();
      // The chart's queued calls finish before the next scenario starts.
      for (let quiet = 0; quiet < 60; quiet += 1) {
        const lastChart = sent.filter((entry) => entry.kind === 'chart').at(-1);
        if (!lastChart || Date.now() - lastChart.at > 2_000) break;
        await sleep(1_000);
      }
      const tally = (items: Array<string | undefined>) =>
        items.reduce<Record<string, number>>((counts, item) => {
          const key = item ?? 'ok';
          counts[key] = (counts[key] ?? 0) + 1;
          return counts;
        }, {});
      const summary = {
        seconds: Math.round(input.durationMs / 1000),
        sent: tally(sent.map((entry) => entry.kind)),
        weightPerMinute: perMinute(),
        chartWeightPerMinute: perMinute('chart'),
        maxSampledWeight: Math.max(0, ...sampling.samples.map((s) => s.weight)),
        maxSampledLeases: Math.max(0, ...sampling.samples.map((s) => s.leases)),
        peak,
        last: tally(last.map((a) => a.code)),
        lastLongestGapMs: longestGap(last, start, until),
        mark: tally(mark.map((a) => a.code)),
        markLongestGapMs: input.mark ? longestGap(mark, start, until) : null,
        spotRefused: tally(spotRefused),
        chart: tally(chartOutcomes),
      };
      process.stdout.write(`CHART_COEXISTENCE ${JSON.stringify(summary)}\n`);
      return summary;
    }

    it('normal: a few viewed charts never delay Last/Mark recovery', async () => {
      const result = await scenario({
        durationMs: 15_000,
        chartSeries: 3,
        spotRequests: 0,
        mark: true,
      });
      expect(result.maxSampledLeases <= 2).toBe(true);
      expect(result.peak.chart <= 1).toBe(true);
      expect(Object.keys(result.last)).toEqual(['ok']);
      expect(Object.keys(result.mark)).toEqual(['ok']);
      expect(result.lastLongestGapMs <= 3_500).toBe(true);
    }, 60_000);

    it.each([
      ['Spot sync, no chart demand', 0, 300],
      ['chart demand at its cap, no Spot sync', 150, 0],
      ['Spot sync and chart demand at its cap', 150, 300],
    ])(
      'busy minute with Last + Mark WS outage — %s: budget and slots hold',
      async (_label, chartSeries, spotRequests) => {
        const result = await scenario({
          durationMs: 65_000,
          chartSeries,
          spotRequests,
          mark: true,
        });
        // The coordinator's own minute counter (Redis TIME). Sums per local
        // clock minute are printed only: this host's clock steps back ~2 s
        // every ~30 s, which can reopen a minute for the coordinator too.
        expect(result.maxSampledWeight <= 1200).toBe(true);
        expect(result.maxSampledLeases <= 2).toBe(true);
        expect(result.peak.all <= 2).toBe(true);
        expect(result.peak.chart <= 1).toBe(true);
        // Chart traffic alone never refuses Last/Mark recovery for budget.
        expect(result.last.PROVIDER_RATE_LIMITED === undefined).toBe(true);
        expect(result.mark.PROVIDER_RATE_LIMITED === undefined).toBe(true);
      },
      120_000,
    );

    it('worst case — Spot sync and a cold chart burst at the cap in ONE minute, Mark WS outage: budget and slots hold', async () => {
      const result = await scenario({
        durationMs: 65_000,
        chartSeries: 150,
        spotRequests: 300,
        mark: true,
        alignToMinute: true,
      });
      expect(result.maxSampledWeight <= 1200).toBe(true);
      expect(result.maxSampledLeases <= 2).toBe(true);
      expect(result.peak.chart <= 1).toBe(true);
      // The chart stops short of the recovery reserve, so the Spot sync and a
      // cold chart burst together never spend what Last/Mark recovery needs.
      expect(result.last.PROVIDER_RATE_LIMITED === undefined).toBe(true);
      expect(result.mark.PROVIDER_RATE_LIMITED === undefined).toBe(true);
    }, 200_000);

    it('the chart stops at budget − reserve while Last/Mark recovery is still admitted', async () => {
      const http = new ProviderHttpClient(redis);
      const chart = chartReader(http);
      // Well inside one Redis minute: ≥ 3 s after its start (a backward clock
      // step must not reopen the previous one) and ≥ 20 s before its end.
      let now = await redisNow();
      if (60_000 - (now % 60_000) < 20_000 || now % 60_000 < 3_000) {
        await sleep(((63_000 - (now % 60_000)) % 60_000) + 200);
        now = await redisNow();
      }
      // 958 spent: a cold 5m window (weight 5) would pass 960 = 1200 − 240.
      await redis.eval(
        `redis.call('HSET',KEYS[1],'minute',ARGV[1],'weight',ARGV[2]); return 1`,
        [STATE],
        [String(Math.floor(now / 60_000)), '958'],
      );
      const outcome = await chart
        .read({
          instrumentId: 'r1',
          symbol: 'R1USDT',
          interval: '5m',
          now: new Date(),
        })
        .then(() => 'ok')
        .catch(() => '503');
      expect(outcome).toBe('503');
      expect(sent.some((entry) => entry.kind === 'chart')).toBe(false);
      const call = (url: string) =>
        http
          .getJson(url, { provider: 'binance', timeoutMs: 2500 })
          .then(() => 'ok')
          .catch((caught: unknown) =>
            caught instanceof ProviderHttpError ? caught.code : 'other',
          );
      // Recovery still has the whole reserve: 958 → 960 → 970 → … → 1200.
      expect(await call(FUTURES_LAST_REST_URL)).toBe('ok');
      for (let index = 0; index < 23; index += 1) {
        expect(await call(FUTURES_MARK_REST_URL)).toBe('ok');
      }
      expect(
        Number(
          await redis.eval(
            `return tonumber(redis.call('HGET',KEYS[1],'weight'))`,
            [STATE],
          ),
        ),
      ).toBe(1190);
    }, 120_000);

    it('budget nearly spent: refusals fail closed, the chart pauses, recovery returns with the next minute', async () => {
      const http = new ProviderHttpClient(redis);
      const chart = chartReader(http);
      // Well inside one Redis minute: ≥ 3 s after its start (a backward clock
      // step must not reopen the previous one) and ≥ 20 s before its end.
      let now = await redisNow();
      if (60_000 - (now % 60_000) < 20_000 || now % 60_000 < 3_000) {
        await sleep(((63_000 - (now % 60_000)) % 60_000) + 200);
        now = await redisNow();
      }
      const minute = Math.floor(now / 60_000);
      await redis.eval(
        `redis.call('HSET',KEYS[1],'minute',ARGV[1],'weight',ARGV[2]); return 1`,
        [STATE],
        [String(minute), '1196'],
      );
      const call = (url: string) =>
        http
          .getJson(url, { provider: 'binance', timeoutMs: 2500 })
          .then(() => 'ok')
          .catch((caught: unknown) =>
            caught instanceof ProviderHttpError ? caught.code : 'other',
          );
      // 1196 + 2 + 2 = 1200 is admitted; nothing beyond it.
      expect(await call(FUTURES_LAST_REST_URL)).toBe('ok');
      expect(await call(FUTURES_LAST_REST_URL)).toBe('ok');
      expect(await call(FUTURES_LAST_REST_URL)).toBe('PROVIDER_RATE_LIMITED');
      expect(await call(FUTURES_MARK_REST_URL)).toBe('PROVIDER_RATE_LIMITED');
      // The chart's call is refused too: a cold series is the retryable 503,
      // and every chart read pauses instead of asking again.
      const read = (index: number) =>
        chart
          .read({
            instrumentId: `p${index}`,
            symbol: `P${index}USDT`,
            interval: '5m',
            now: new Date(),
          })
          .then(() => 'ok')
          .catch(() => '503');
      const admissions = jest.spyOn(
        BinanceRestCoordinator.prototype,
        'acquire',
      );
      const chartAdmissions = () =>
        admissions.mock.calls.filter(([url]) => url.includes('/fapi/v1/klines'))
          .length;
      expect(await read(1)).toBe('503');
      expect(chartAdmissions()).toBe(1);
      for (let index = 2; index < 40; index += 1) {
        expect(await read(index)).toBe('503');
      }
      // 38 more chart reads while paused: not one more admission request.
      expect(chartAdmissions()).toBe(1);
      expect(sent.some((entry) => entry.kind === 'chart')).toBe(false);
      expect(
        Number(
          await redis.eval(
            `return tonumber(redis.call('HGET',KEYS[1],'weight'))`,
            [STATE],
          ),
        ),
      ).toBe(1200);
      // With the next minute, Last and Mark recovery are admitted again
      // straight away; the chart resumes once its pause has run out.
      // Until Redis TIME is past the spent minute (a sleep alone can wake
      // inside it again when the host clock steps back meanwhile).
      while (Math.floor((await redisNow()) / 60_000) <= minute)
        await sleep(250);
      await sleep(300);
      expect(await call(FUTURES_LAST_REST_URL)).toBe('ok');
      expect(await call(FUTURES_MARK_REST_URL)).toBe('ok');
      await sleep(1_100);
      expect(await read(99)).toBe('ok');
      expect(peak.chart <= 1).toBe(true);
    }, 120_000);
  },
);
