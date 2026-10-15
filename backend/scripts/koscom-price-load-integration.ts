/**
 * L1 — KOSCOM price collection under 100 stocks in 6 batches (design v2.1
 * §10.7 L1, with the L4/L5 conditions it depends on), against local mock
 * KOSCOM servers on a disposable *_test PostgreSQL and a local Redis.
 *
 * Two KoscomIngestionService instances (own client, Redis connection and
 * clock skew of ±250 ms) drive the real slot path exactly as the Ops
 * scheduler does (`collectSlot` at every T boundary), with the 100-stock
 * flags: price slot, retry caps, priority lane and budget enforcement on,
 * order book off. The real KoscomClient (cluster-wide concurrency 2, 200 ms
 * spacing, 5 s timeout), market map, normalizer and price writes run
 * unchanged; the process clock (Date only) runs in real time from a KRX
 * session instant.
 *
 * Injected: provider latency (uniform plus a slow tail), 5xx errors, a burst
 * of 100 P3 minute requests competing for the same client admission (the
 * central minute collection's load), an optional 429, and a crash of the
 * instance that owns the cycle (its HTTP stalls and its Redis connection
 * drops, so its lease is left to expire).
 *
 * Measured: price calls per cycle against the model (6), in-cycle retries,
 * cycle duration D (p50/p99/max), missed and duplicate slots, slot
 * contention, crash recovery in slots, queue timeouts, the age of every
 * stock's newest price (10 s execution freshness) and counters by category.
 * A mock cannot prove KOSCOM's real latency, limits or quota behaviour; it
 * proves what this code does under the injected conditions.
 *
 *   KOSCOM_PRICE_LOAD_DB_INTEGRATION=1 DATABASE_URL=<local *_test db> \
 *   REDIS_URL=redis://127.0.0.1:<port> pnpm tsx scripts/koscom-price-load-integration.ts
 *
 * Profile (env): KOSCOM_L1_PERIOD_MS (6000), KOSCOM_L1_DURATION_S (90),
 * KOSCOM_L1_LATENCY_MS ("50,400"), KOSCOM_L1_SLOW_RATE (0; 1.5–2.5 s),
 * KOSCOM_L1_ERROR_RATE (0), KOSCOM_L1_BURST_AT_S (20; "tick" = every
 * central 5m tick), KOSCOM_L1_CRASH_AT_S (45; 0 = none), KOSCOM_L1_429_AT_S
 * (0 = none), KOSCOM_L1_ASSERT (1: fail on the smoke criteria; 0: report),
 * KOSCOM_L1_REPORT (JSON path), KOSCOM_L1_POLL_LOG (1: the service's per-batch
 * `koscom_poll` lines), KOSCOM_L1_DUMP (JSON path: raw attempts, provider log
 * and the shared admission keys sampled every 50 ms, for diagnosing stalls).
 * The defaults are the CI smoke: deterministic
 * apart from latency; the perf profiles add errors, slow tails and a 429 and
 * report instead of asserting.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mock } from 'node:test';
import { AssetType, CurrencyCode } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { RedisLockService } from '../src/redis/redis-lock.service';
import { KoscomClient } from '../src/providers/koscom/koscom.client';
import { KoscomCallBudgetService } from '../src/providers/koscom/koscom-call-budget.service';
import { runWithKoscomCallCategory } from '../src/providers/koscom/koscom-call-context';
import { KoscomMarketMapService } from '../src/providers/koscom/koscom-market-map.service';
import { KoscomIngestionService } from '../src/providers/koscom/koscom-ingestion.service';
import {
  KOSCOM_PRICE_SOURCE,
  KoscomConfigService,
  readKoscomConfig,
} from '../src/providers/koscom/koscom.config';
import { krxIntradayTickTimes } from '../src/assets/krx-candle-collection.policy';
import { resolveMarketSession } from '../src/orders/market-calendar.policy';

const dbUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname) &&
    dbUrl.pathname.endsWith('_test'),
  'Use a disposable local *_test PostgreSQL database.',
);
assert.ok(
  ['localhost', '127.0.0.1'].includes(
    new URL(process.env.REDIS_URL ?? 'redis://invalid').hostname,
  ),
  'Use a local Redis.',
);

const env = process.env;
const num = (name: string, fallback: number) => {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  assert.ok(Number.isFinite(value) && value >= 0, `${name} must be >= 0`);
  return value;
};
const T = num('KOSCOM_L1_PERIOD_MS', 6000);
const DURATION_MS = num('KOSCOM_L1_DURATION_S', 90) * 1000;
const [LATENCY_MIN, LATENCY_MAX] = (env.KOSCOM_L1_LATENCY_MS ?? '50,400')
  .split(',')
  .map(Number);
const SLOW_RATE = num('KOSCOM_L1_SLOW_RATE', 0);
const ERROR_RATE = num('KOSCOM_L1_ERROR_RATE', 0);
const BURST_EVERY_TICK = env.KOSCOM_L1_BURST_AT_S?.trim() === 'tick';
const BURST_AT_MS = BURST_EVERY_TICK
  ? 0
  : num('KOSCOM_L1_BURST_AT_S', 20) * 1000;
const CRASH_AT_MS = num('KOSCOM_L1_CRASH_AT_S', 45) * 1000;
const RATE_LIMIT_AT_MS = num('KOSCOM_L1_429_AT_S', 0) * 1000;
const ASSERT = env.KOSCOM_L1_ASSERT?.trim() !== '0';
const REPORT = env.KOSCOM_L1_REPORT?.trim();
const FRESHNESS_MS = 10_000;

// Wednesday 2026-10-14 10:00 KST: a regular session with hours to spare.
const ANCHOR = Date.parse('2026-10-14T01:00:00.000Z');
const SESSION = resolveMarketSession('KRX', '20261014')!;

const base = randomInt(900000, 940000);
const STOCKS = Array.from({ length: 100 }, (_, i) => ({
  symbol: String(base + i),
  market: i < 50 ? 'kospi' : 'kosdaq',
}));
const BATCHES = Math.ceil(50 / 20) * 2; // 50 KOSPI + 50 KOSDAQ = 6 batches

// ---- mock KOSCOM (one server per instance, shared state) ---------------------
type Logged = { instance: 'A' | 'B'; kind: string; atMs: number };
const log: Logged[] = [];
const fault = { crashed: false, rateLimitSent: false, startedAtMs: 0 };
const prices = new Map(STOCKS.map((s, i) => [s.symbol, 50_000 + i * 100]));

function kindOf(path: string) {
  if (path.endsWith('/lists')) return 'lists';
  if (path.includes('/multiquote/'))
    return path.endsWith('/price') ? 'price' : 'orderbook';
  if (path.endsWith('/intraday')) return 'minute';
  return 'other';
}

function hhmmss(ms: number): string {
  return `${new Date(ms + 9 * 3_600_000).toISOString().slice(11, 19).replaceAll(':', '')}00`;
}

function latency(): number {
  if (Math.random() < SLOW_RATE) return 1500 + Math.random() * 1000;
  return LATENCY_MIN + Math.random() * (LATENCY_MAX - LATENCY_MIN);
}

function mockServer(instance: 'A' | 'B'): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const kind = kindOf(url.pathname);
    log.push({ instance, kind, atMs: Date.now() });
    // A crashed owner's provider calls never come back (client timeout).
    if (instance === 'A' && fault.crashed) return;
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.setHeader('x-ratelimit-limit-day', '50000');
      res.setHeader('x-ratelimit-remaining-day', String(50000 - log.length));
      if (
        RATE_LIMIT_AT_MS > 0 &&
        !fault.rateLimitSent &&
        kind === 'price' &&
        Date.now() - fault.startedAtMs >= RATE_LIMIT_AT_MS
      ) {
        fault.rateLimitSent = true;
        res.statusCode = 429;
        res.end('{}');
        return;
      }
      if (kind !== 'lists' && Math.random() < ERROR_RATE) {
        res.statusCode = 503;
        res.end('{}');
        return;
      }
      if (kind === 'lists') {
        const market = url.pathname.includes('/kospi/')
          ? 'kospi'
          : url.pathname.includes('/kosdaq/')
            ? 'kosdaq'
            : 'konex';
        res.end(
          JSON.stringify({
            isuLists: STOCKS.filter((s) => s.market === market).map((s) => ({
              isuSrtCd: s.symbol,
            })),
          }),
        );
        return;
      }
      if (kind === 'price') {
        const now = Date.now();
        const isulist = (url.searchParams.get('isuCd') ?? '')
          .split(',')
          .map((symbol) => {
            const price = prices.get(symbol)! + randomInt(-2, 3) * 10;
            prices.set(symbol, price);
            return {
              isuSrtCd: symbol,
              trdDd: new Date(now + 9 * 3_600_000)
                .toISOString()
                .slice(0, 10)
                .replaceAll('-', ''),
              // The latest trade is up to a second before the response.
              trdTm: hhmmss(
                Math.floor((now - randomInt(0, 1000)) / 1000) * 1000,
              ),
              trdPrc: String(price),
              cmpprevddPrc: '100',
              cmpprevddTpCd: '2',
              accTrdvol: '1000',
              accTrdval: String(price * 1000),
            };
          });
        res.end(JSON.stringify({ jsonrpc: '2.0', result: { isulist } }));
        return;
      }
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          result: { isuSrtCd: url.pathname.split('/').at(-2), hisLists: [] },
        }),
      );
    }, latency());
  });
}

// ---- wiring -------------------------------------------------------------------
const namespace = `koscom-l1-${randomUUID().slice(0, 8)}`;
const prisma = new PrismaService();

type Attempt = {
  instance: 'A' | 'B';
  slot: number;
  durationMs: number;
  /** Finished after its process "crashed": a dead process reports nothing. */
  crashed: boolean;
  code: string | null;
  failed: number;
  created: number;
  reasons: string[];
};
const attempts: Attempt[] = [];

function instance(name: 'A' | 'B', skewMs: number) {
  const redis = new RedisService();
  const locks = new RedisLockService(redis);
  let baseUrl = '';
  class Config extends KoscomConfigService {
    override getConfig() {
      return {
        ...readKoscomConfig({
          PROVIDER_INGESTION_ENABLED: 'true',
          KOSCOM_API_KEY: 'fixture-key',
          KOSCOM_POLL_INTERVAL_MS: String(T),
          KOSCOM_PRICE_SLOT_ENABLED: 'true',
          KOSCOM_PRICE_RETRY_CAPS_ENABLED: 'true',
          KOSCOM_PRICE_PRIORITY_LANE_ENABLED: 'true',
          KOSCOM_BUDGET_ENFORCEMENT_ENABLED: 'true',
          KOSCOM_ORDERBOOK_COLLECTION_ENABLED: 'false',
          KOSCOM_CYCLE_METRICS_ENABLED: 'true',
          KOSCOM_POLL_LOG_ENABLED:
            env.KOSCOM_L1_POLL_LOG?.trim() === '1' ? 'true' : 'false',
        }),
        baseUrl,
        namespace,
      };
    }
  }
  const config = new Config();
  const budget = new KoscomCallBudgetService(redis);
  const client = new KoscomClient(config, redis, locks, budget);
  const markets = new KoscomMarketMapService(client, redis, config);
  const service = new KoscomIngestionService(
    prisma,
    config,
    client,
    markets,
    locks,
    redis,
    { publish: () => undefined } as never,
    { checkActiveAssetCoverage: () => undefined } as never,
  );
  const state = {
    name,
    skewMs,
    redis,
    client,
    markets,
    service,
    budget,
    server: mockServer(name),
    stopped: false,
    timer: undefined as NodeJS.Timeout | undefined,
    pending: new Set<Promise<unknown>>(),
    setBaseUrl: (url: string) => {
      baseUrl = url;
    },
  };
  return state;
}
type Instance = ReturnType<typeof instance>;

/** The Ops scheduler's slot loop, with this instance's clock skew. */
function slotLoop(inst: Instance) {
  let last = -1;
  const tick = () => {
    if (inst.stopped) return;
    const nowMs = Date.now() + inst.skewMs;
    const slot = Math.floor(nowMs / T);
    if (slot > last) {
      last = slot;
      const started = performance.now();
      const run = inst.service
        .collectSlot({ slot, periodMs: T, now: new Date(nowMs) })
        .then((result) => {
          const snapshots = result.snapshots;
          attempts.push({
            instance: inst.name,
            slot,
            durationMs: performance.now() - started,
            crashed: inst.name === 'A' && fault.crashed,
            code: result.errorCode ?? null,
            failed: result.failed,
            created: result.created,
            reasons: [
              ...new Set(
                snapshots
                  .filter((s) => s.state === 'failed')
                  .map((s) => s.reason ?? 'unknown'),
              ),
            ],
          });
        })
        .catch(() => undefined);
      inst.pending.add(run);
      void run.finally(() => inst.pending.delete(run));
    }
    inst.timer = setTimeout(
      tick,
      Math.max(1, (slot + 1) * T - (Date.now() + inst.skewMs)),
    );
  };
  tick();
}

/** The central minute collection's load: 100 P3 requests, two workers. */
async function minuteBurst(inst: Instance) {
  const queue = [...STOCKS];
  const started = performance.now();
  let failed = 0;
  await Promise.all(
    [0, 1].map(async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const stock = next;
        await runWithKoscomCallCategory('minute', () =>
          inst.client.get(
            `/v3/market/realtime/${stock.market}/stocks/${stock.symbol}/intraday`,
            { inddCycleTpCd: '60', strtTm: '0900', endTm: '1530' },
          ),
        ).catch(() => {
          failed += 1;
        });
      }
    }),
  );
  return { durationMs: performance.now() - started, failed };
}

function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

async function main() {
  const assetIds: string[] = [];
  const instances = [instance('A', 250), instance('B', -250)];
  const freshness: { atMs: number; maxAgeMs: number; stale: number }[] = [];
  const bursts: { atMs: number; durationMs: number; failed: number }[] = [];
  const realStart = performance.now();
  mock.timers.enable({ apis: ['Date'], now: ANCHOR });
  // Date runs in real time from the session instant (timers stay real).
  const clock = setInterval(
    () =>
      mock.timers.setTime(ANCHOR + Math.round(performance.now() - realStart)),
    2,
  );
  const timers: NodeJS.Timeout[] = [clock];
  const probes: RedisService[] = [];
  try {
    for (const inst of instances) {
      inst.server.listen(0, '127.0.0.1');
      await once(inst.server, 'listening');
      const address = inst.server.address();
      assert.ok(address && typeof address === 'object');
      inst.setBaseUrl(`http://127.0.0.1:${address.port}`);
    }
    await prisma.$connect();
    const others = await prisma.asset.count({
      where: { assetType: AssetType.domestic_stock, isActive: true },
    });
    assert.equal(
      others,
      0,
      'The test database must hold no other active domestic asset.',
    );
    for (const stock of STOCKS) {
      const asset = await prisma.asset.create({
        data: {
          symbol: stock.symbol,
          name: `KOSCOM L1 ${stock.symbol}`,
          market: stock.market === 'kospi' ? 'KOSPI' : 'KOSDAQ',
          assetType: AssetType.domestic_stock,
          currencyCode: CurrencyCode.KRW,
          priceCurrency: CurrencyCode.KRW,
          settlementCurrency: CurrencyCode.KRW,
          isActive: true,
        },
      });
      assetIds.push(asset.id);
    }
    // Warm the shared market map (P1 lists) before the clock starts counting.
    await instances[0].markets.resolve(STOCKS[0].symbol, 'KOSPI');

    fault.startedAtMs = Date.now();
    const firstSlot = Math.floor(Date.now() / T) + 1;
    for (const inst of instances) slotLoop(inst);

    // Redis expires keys on ITS wall clock: a backward step (seen on WSL)
    // stretches every TTL, the 200 ms request spacing included, and stalls
    // admission for the step. Steps are measured against the monotonic clock
    // so affected cycles are reported apart instead of read as code latency.
    const clockSteps: { atMs: number; stepMs: number }[] = [];
    const clockProbe = new RedisService();
    probes.push(clockProbe);
    let lastWall: number | null = null;
    let lastMono = 0;
    timers.push(
      setInterval(() => {
        void clockProbe
          .eval("return redis.call('TIME')", [], [])
          .then((time) => {
            const [sec, usec] = time as [string, string];
            const wall = Number(sec) * 1000 + Number(usec) / 1000;
            const mono = performance.now();
            if (lastWall !== null) {
              const step = wall - lastWall - (mono - lastMono);
              if (Math.abs(step) > 200)
                clockSteps.push({ atMs: Date.now(), stepMs: Math.round(step) });
            }
            lastWall = wall;
            lastMono = mono;
          })
          .catch(() => undefined);
      }, 500),
    );
    // Debug (KOSCOM_L1_DUMP): the shared admission keys every 50 ms.
    const keySamples: unknown[] = [];
    if (env.KOSCOM_L1_DUMP?.trim()) {
      const probe = new RedisService();
      probes.push(probe);
      const keys = [
        'http:0',
        'http:1',
        'request-spacing',
        'price-lane',
        'cooldown',
      ];
      timers.push(
        setInterval(() => {
          const atMs = Date.now();
          void Promise.all(
            keys.map((key) =>
              probe
                .eval(
                  "return {redis.call('GET', KEYS[1]) or '', redis.call('PTTL', KEYS[1])}",
                  [`koscom:${namespace}:${key}`],
                  [],
                )
                .catch(() => null),
            ),
          ).then((values) => keySamples.push({ atMs, values }));
        }, 50),
      );
    }
    // Freshness sampler: the newest price of every stock, once a second.
    timers.push(
      setInterval(() => {
        const atMs = Date.now();
        void prisma.assetPriceSnapshot
          .groupBy({
            by: ['assetId'],
            where: {
              assetId: { in: assetIds },
              sourceName: KOSCOM_PRICE_SOURCE,
            },
            _max: { effectiveAt: true },
          })
          .then((rows) => {
            const ages = assetIds.map((id) => {
              const newest = rows.find((row) => row.assetId === id)?._max
                .effectiveAt;
              return newest ? atMs - newest.getTime() : Infinity;
            });
            freshness.push({
              atMs,
              maxAgeMs: Math.max(...ages),
              stale: ages.filter((age) => age > FRESHNESS_MS).length,
            });
          })
          .catch(() => undefined);
      }, 1000),
    );
    if (BURST_EVERY_TICK) {
      const ticks = krxIntradayTickTimes(SESSION, 70_000);
      timers.push(
        setInterval(() => {
          const now = Date.now();
          if (ticks.some((tick) => tick <= now && tick > now - 1000))
            void minuteBurst(instances[1]).then((burst) =>
              bursts.push({ atMs: now, ...burst }),
            );
        }, 1000),
      );
    } else if (BURST_AT_MS > 0)
      timers.push(
        setTimeout(() => {
          const atMs = Date.now();
          void minuteBurst(instances[1]).then((burst) =>
            bursts.push({ atMs, ...burst }),
          );
        }, BURST_AT_MS),
      );
    let crashAtMs: number | null = null;
    if (CRASH_AT_MS > 0)
      timers.push(
        setTimeout(() => {
          // A (its clock 250 ms ahead) owns every cycle: crash it 300 ms into
          // its next one, after it took the 3T cycle lock.
          const toBoundary = T - ((Date.now() + 250) % T);
          timers.push(
            setTimeout(() => {
              crashAtMs = Date.now();
              fault.crashed = true;
              instances[0].stopped = true;
              if (instances[0].timer) clearTimeout(instances[0].timer);
              void instances[0].redis.onModuleDestroy().catch(() => undefined);
            }, toBoundary + 300),
          );
        }, CRASH_AT_MS),
      );

    await new Promise((resolve) => setTimeout(resolve, DURATION_MS));
    for (const inst of instances) {
      inst.stopped = true;
      if (inst.timer) clearTimeout(inst.timer);
    }
    for (const timer of timers.slice(1)) clearInterval(timer);
    await Promise.all(instances.flatMap((inst) => [...inst.pending]));
    const lastSlot = Math.floor(Date.now() / T) - 1;

    // ---- metrics ----------------------------------------------------------------
    const slots = Array.from(
      { length: lastSlot - firstSlot + 1 },
      (_, i) => firstSlot + i,
    );
    const crashSlot =
      crashAtMs === null ? null : Math.floor((crashAtMs as number) / T);
    const inCrashWindow = (slot: number) =>
      crashSlot !== null && slot >= crashSlot && slot <= crashSlot + 4;
    const ran = attempts.filter((a) => a.code === null && !a.crashed);
    const ranBySlot = new Map<number, Attempt[]>();
    for (const attempt of ran)
      ranBySlot.set(attempt.slot, [
        ...(ranBySlot.get(attempt.slot) ?? []),
        attempt,
      ]);
    const missed = slots.filter((slot) => !ranBySlot.has(slot));
    const duplicates = slots.filter(
      (slot) => (ranBySlot.get(slot)?.length ?? 0) > 1,
    );
    const normalSlots = slots.filter((slot) => !inCrashWindow(slot));
    const missedNormal = missed.filter((slot) => !inCrashWindow(slot));
    const recoverySlots =
      crashSlot === null
        ? null
        : (slots.find(
            (slot) =>
              slot > crashSlot &&
              ranBySlot.get(slot)?.some((a) => a.instance === 'B'),
          ) ?? Infinity) - crashSlot;
    const measured = ran.filter((a) => slots.includes(a.slot));
    // A step is detected up to 500 ms late and stalls admission for its size.
    const stepAffected = (fromMs: number, toMs: number) =>
      clockSteps.some(
        (step) =>
          step.atMs - 500 <= toMs &&
          step.atMs + Math.abs(step.stepMs) >= fromMs,
      );
    const cycleStepAffected = (a: Attempt) =>
      stepAffected(a.slot * T - 500, a.slot * T + a.durationMs);
    const cycleMs = measured
      .filter((a) => !cycleStepAffected(a))
      .map((a) => a.durationMs);
    const windowStart = firstSlot * T;
    const windowEnd = (lastSlot + 1) * T;
    const inWindow = (entry: Logged) =>
      entry.atMs >= windowStart && entry.atMs < windowEnd;
    const priceCalls = log.filter(
      (e) => e.kind === 'price' && inWindow(e),
    ).length;
    const minuteCalls = log.filter((e) => e.kind === 'minute').length;
    const codes: Record<string, number> = {};
    for (const attempt of attempts) {
      const code = attempt.crashed ? 'CRASHED' : (attempt.code ?? 'RAN');
      codes[code] = (codes[code] ?? 0) + 1;
    }
    const reasons: Record<string, number> = {};
    for (const attempt of measured)
      for (const reason of attempt.reasons)
        reasons[reason] = (reasons[reason] ?? 0) + 1;
    const settled = freshness.filter(
      (sample) =>
        sample.atMs >= windowStart + 2 * T &&
        !(crashSlot !== null && inCrashWindow(Math.floor(sample.atMs / T))) &&
        !stepAffected(sample.atMs - FRESHNESS_MS, sample.atMs),
    );
    const duringCrash = freshness.filter(
      (sample) =>
        crashSlot !== null && inCrashWindow(Math.floor(sample.atMs / T)),
    );
    await new Promise((resolve) => setTimeout(resolve, 300)); // fire-and-forget counters
    const counters = await instances[1].budget.readQuotaDay(namespace);
    const report = {
      profile: {
        periodMs: T,
        durationS: DURATION_MS / 1000,
        stocks: STOCKS.length,
        batches: BATCHES,
        latencyMs: [LATENCY_MIN, LATENCY_MAX],
        slowRate: SLOW_RATE,
        errorRate: ERROR_RATE,
        burst: BURST_EVERY_TICK ? 'every central tick' : BURST_AT_MS / 1000,
        crashAtS: CRASH_AT_MS / 1000 || null,
        rateLimitAtS: RATE_LIMIT_AT_MS / 1000 || null,
      },
      slots: {
        total: slots.length,
        ran: measured.length,
        missed: missed.length,
        missedOutsideCrash: missedNormal.length,
        missRateOutsideCrash: normalSlots.length
          ? missedNormal.length / normalSlots.length
          : null,
        duplicates: duplicates.length,
        recoverySlotsAfterCrash: recoverySlots,
        attemptCodes: codes,
      },
      redisClockSteps: clockSteps.map((step) => ({
        atS: Math.round((step.atMs - windowStart) / 100) / 10,
        stepMs: step.stepMs,
      })),
      // Cycles and freshness samples within a measured Redis clock step are
      // reported here, apart from the figures below.
      stepAffected: {
        cyclesMs: measured
          .filter(cycleStepAffected)
          .map((a) => Math.round(a.durationMs)),
        freshnessMaxAgeMs: (() => {
          const hit = freshness.filter(
            (sample) =>
              sample.atMs >= windowStart + 2 * T &&
              stepAffected(sample.atMs - FRESHNESS_MS, sample.atMs),
          );
          return hit.length ? Math.max(...hit.map((x) => x.maxAgeMs)) : null;
        })(),
      },
      cycleMs: {
        p50: quantile(cycleMs, 0.5),
        p99: quantile(cycleMs, 0.99),
        max: quantile(cycleMs, 1),
        overrunAboveTMinus1s: cycleMs.filter((d) => d > T - 1000).length,
      },
      calls: {
        price: priceCalls,
        perRanCycle: measured.length ? priceCalls / measured.length : null,
        model: BATCHES,
        // Calls beyond one per batch and cycle (in-cycle retries; also calls
        // of a crashed cycle that never completed).
        beyondModel: priceCalls - BATCHES * measured.length,
        minute: minuteCalls,
      },
      // [slot index, instance, D ms, overlapping a minute burst, clock step]
      cycles: measured.map((a) => [
        a.slot - firstSlot,
        a.instance,
        Math.round(a.durationMs),
        bursts.some(
          (burst) =>
            a.slot * T < burst.atMs + burst.durationMs &&
            (a.slot + 1) * T > burst.atMs,
        ),
        cycleStepAffected(a),
      ]),
      failedBatchReasons: reasons,
      queueTimeouts: reasons.KOSCOM_QUEUE_TIMEOUT ?? 0,
      freshness: {
        samples: settled.length,
        maxAgeMs: settled.length
          ? Math.max(...settled.map((sample) => sample.maxAgeMs))
          : null,
        samplesWithStaleStock: settled.filter((sample) => sample.stale > 0)
          .length,
        // Prices age into the fail-closed freshness check while no one owns
        // the slots (the dead owner's 3T lease); reported, not asserted.
        crashWindowMaxAgeMs: duringCrash.length
          ? Math.max(...duringCrash.map((sample) => sample.maxAgeMs))
          : null,
      },
      bursts,
      counters: counters.counts,
      providerRequests: log.length,
    };
    console.log(JSON.stringify({ l1: report }));
    if (REPORT) writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
    if (env.KOSCOM_L1_DUMP?.trim())
      writeFileSync(
        env.KOSCOM_L1_DUMP.trim(),
        JSON.stringify({ T, firstSlot, attempts, log, keySamples }),
      );

    if (ASSERT) {
      assert.ok(slots.length >= 10, 'enough slots measured');
      assert.equal(duplicates.length, 0, 'never two cycles for one slot');
      assert.equal(missedNormal.length, 0, 'no slot missed outside the crash');
      assert.equal(
        report.calls.beyondModel <= (crashSlot === null ? 0 : BATCHES),
        true,
        `price calls = ${BATCHES} per cycle (no in-cycle retry)`,
      );
      assert.equal(report.queueTimeouts, 0, 'no queue timeout');
      assert.ok(
        (report.cycleMs.p99 ?? Infinity) <= T - 1000,
        `D p99 ${report.cycleMs.p99} ms <= T - 1 s`,
      );
      if (crashSlot !== null)
        assert.ok(
          recoverySlots !== null && recoverySlots <= 4,
          `survivor resumes within the 3T lease (+1 slot): ${recoverySlots}`,
        );
      assert.ok(
        (report.freshness.maxAgeMs ?? Infinity) <= FRESHNESS_MS,
        `every stock's newest price <= 10 s old: ${report.freshness.maxAgeMs}`,
      );
      assert.equal(
        bursts.every((burst) => burst.failed === 0),
        true,
        'the minute burst completes',
      );
      assert.equal(
        counters.counts.total,
        log.length,
        'counters = HTTP log (crashed calls included)',
      );
    }
  } finally {
    for (const timer of timers) clearInterval(timer);
    for (const inst of instances) {
      inst.stopped = true;
      if (inst.timer) clearTimeout(inst.timer);
      inst.server.closeAllConnections();
      inst.server.close();
      await inst.redis.onModuleDestroy().catch(() => undefined);
    }
    await Promise.all(
      probes.map((probe) => probe.onModuleDestroy().catch(() => undefined)),
    );
    mock.timers.reset();
    if (assetIds.length) {
      await prisma.assetPriceSnapshot.deleteMany({
        where: { assetId: { in: assetIds } },
      });
      await prisma.asset.deleteMany({ where: { id: { in: assetIds } } });
    }
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
