/** Season final-ranking eligibility at participant scale, opt-in, against an
 * EMPTY dedicated loopback database (TRUNCATEs its own tables per size).
 * docs/season-final-ranking-eligibility.md §10.
 *
 * Measures, per participant count, the reads this feature adds — season-wide
 * eligibility (settlement), one user's progress API, the Futures FX evidence
 * lookups, and the final ranking read with its result verification — and the
 * settlement end to end. Fill counts follow a skewed distribution (60% of
 * participants with 10 fills, 30% with 100, 9% with 500, 1% with 3,000); 30% of
 * fills are Futures executions, 20% USD Spot. Wall time, driver statements,
 * rows returned and peak memory are observed; EXPLAIN plans are captured for
 * the statements the reads actually sent. Numbers are local (loopback, warm
 * cache) and are an upper bound on what they can say about production.
 */
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { HttpException, Logger } from '@nestjs/common';
import { Client } from 'pg';
import { BatchService } from '../src/batch/batch.service';
import { SeasonSettlementJobService } from '../src/batch/season-settlement-job.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { findUsdKrwRatesAtOrBefore } from '../src/providers/fx-rate-snapshot-query';
import { formatKstRankingDate } from '../src/ranking/ranking-date.policy';
import { RankingService } from '../src/ranking/ranking.service';
import { readSeasonTradingActivity } from '../src/ranking/season-final-qualification';
import { verifyEligibilityFinalResult } from '../src/ranking/season-final-result-integrity';

const url = new URL(process.env.DATABASE_URL ?? 'file:///missing');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.SEASON_FINAL_QUALIFICATION_BENCHMARK !== '1' ||
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/season_final_qualification_benchmark'
) {
  throw new Error(
    'Requires NODE_ENV=test, SEASON_FINAL_QUALIFICATION_BENCHMARK=1 and the dedicated loopback database season_final_qualification_benchmark.',
  );
}
Logger.overrideLogger(false);

const sizes = (process.env.SEASON_QUALIFICATION_BENCHMARK_SIZES ?? '100,1000')
  .split(',')
  .map(Number);
const settleUpTo = Number(
  process.env.SEASON_QUALIFICATION_BENCHMARK_SETTLE_UP_TO ?? '1000',
);
const START = new Date('2026-09-01T00:00:00.000Z');
const END = new Date('2026-09-22T00:00:00.000Z');
const SEASON = 'bench-season';
const DAY = 86_400_000;

// ------------------------------------------------------------ observation
type Metric = {
  statements: number;
  rows: number;
  maxRowsPerStatement: number;
  sqlMs: number;
  /** Longest season-row FOR UPDATE → COMMIT/ROLLBACK on one connection. */
  maxSeasonLockMs: number;
  byTable: Record<string, number>;
  captured: Array<{ text: string; values: unknown[] }>;
};
let active: Metric | null = null;
let capture: RegExp | null = null;
const seasonLockSince = new WeakMap<object, number>();
// eslint-disable-next-line @typescript-eslint/unbound-method
const driverQuery = Client.prototype.query;
Client.prototype.query = function (this: Client, ...args: unknown[]) {
  const metric = active;
  const first = args[0] as string | { text?: string; values?: unknown[] };
  const text = typeof first === 'string' ? first : (first?.text ?? '');
  const values =
    typeof first === 'string'
      ? ((Array.isArray(args[1]) ? args[1] : []) as unknown[])
      : (first?.values ?? []);
  const started = performance.now();
  const done = (result?: { rowCount?: number | null }) => {
    if (!metric) return;
    metric.statements++;
    metric.sqlMs += performance.now() - started;
    const rows = result?.rowCount ?? 0;
    metric.rows += rows;
    metric.maxRowsPerStatement = Math.max(metric.maxRowsPerStatement, rows);
    const now = performance.now();
    if (/FOR UPDATE/i.test(text) && text.includes('"seasons"'))
      seasonLockSince.set(this, now);
    if (/^\s*(?:COMMIT|ROLLBACK)\b/i.test(text)) {
      const since = seasonLockSince.get(this);
      if (since !== undefined)
        metric.maxSeasonLockMs = Math.max(metric.maxSeasonLockMs, now - since);
      seasonLockSince.delete(this);
    }
    for (const table of [
      'orders',
      'futures_executions',
      'fx_rate_snapshots',
      'season_participants',
      'season_rankings',
      'trading_accounts',
    ])
      if (text.includes(`"${table}"`))
        metric.byTable[table] = (metric.byTable[table] ?? 0) + 1;
    if (capture?.test(text) && metric.captured.length < 6)
      metric.captured.push({ text, values });
  };
  const last = args.at(-1);
  if (typeof last === 'function') {
    args[args.length - 1] = (
      error: unknown,
      result?: { rowCount?: number },
    ) => {
      done(result);
      Reflect.apply(last as (...a: unknown[]) => unknown, undefined, [
        error,
        result,
      ]);
    };
    return Reflect.apply(driverQuery, this, args) as unknown;
  }
  const result = Reflect.apply(driverQuery, this, args) as unknown;
  if (result instanceof Promise)
    return result.then(
      (value: { rowCount?: number }) => {
        done(value);
        return value;
      },
      (error: unknown) => {
        done();
        throw error;
      },
    );
  return result;
} as typeof driverQuery;

async function observe<T>(
  work: () => Promise<T>,
  options: { capture?: RegExp } = {},
) {
  const metric: Metric = {
    statements: 0,
    rows: 0,
    maxRowsPerStatement: 0,
    sqlMs: 0,
    maxSeasonLockMs: 0,
    byTable: {},
    captured: [],
  };
  (globalThis as { gc?: () => void }).gc?.();
  const baseHeap = process.memoryUsage().heapUsed;
  let peakHeap = baseHeap;
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    const usage = process.memoryUsage();
    peakHeap = Math.max(peakHeap, usage.heapUsed);
    peakRss = Math.max(peakRss, usage.rss);
  }, 10);
  active = metric;
  capture = options.capture ?? null;
  const started = performance.now();
  try {
    const value = await work();
    const ms = performance.now() - started;
    return {
      value,
      ms: round(ms),
      statements: metric.statements,
      rows: metric.rows,
      maxRowsPerStatement: metric.maxRowsPerStatement,
      sqlMs: round(metric.sqlMs),
      maxSeasonLockMs: round(metric.maxSeasonLockMs),
      byTable: metric.byTable,
      heapGrowthMb: round((peakHeap - baseHeap) / 2 ** 20),
      peakRssMb: round(peakRss / 2 ** 20),
      captured: metric.captured,
    };
  } finally {
    active = null;
    capture = null;
    clearInterval(sampler);
  }
}

const round = (value: number) => Math.round(value * 10) / 10;
function percentiles(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
  return { p50: at(0.5), p95: at(0.95), max: round(sorted.at(-1) ?? 0) };
}

// ------------------------------------------------------------------ fixture
const fixtureDb = new Client({ connectionString: process.env.DATABASE_URL });
/**
 * Fills of participant g. `skewed` (default): 1% 3,000, 9% 500, 30% 100,
 * 60% 10. `worst-batch`: the first 50 participants — one whole read batch —
 * 3,000 each, everyone else 10: the most rows one batch of the season-wide
 * read can hold under the 3,000-fill ceiling.
 */
const WORST_BATCH =
  process.env.SEASON_QUALIFICATION_BENCHMARK_PROFILE === 'worst-batch';
const TIER_SQL = WORST_BATCH
  ? `(CASE WHEN g <= 50 THEN 3000 ELSE 10 END)`
  : `(CASE WHEN g % 100 = 0 THEN 3000 WHEN g % 100 < 10 THEN 500 WHEN g % 100 < 40 THEN 100 ELSE 10 END)`;
const tierOf = (g: number) =>
  WORST_BATCH
    ? g <= 50
      ? 3000
      : 10
    : g % 100 === 0
      ? 3000
      : g % 100 < 10
        ? 500
        : g % 100 < 40
          ? 100
          : 10;

async function resetDatabase() {
  await fixtureDb.query(
    'TRUNCATE users, assets, seasons, fx_rate_snapshots, futures_instruments, batch_job_runs CASCADE',
  );
}

async function buildFixture(n: number) {
  const started = performance.now();
  await resetDatabase();
  const q = (sql: string, values: unknown[] = []) =>
    fixtureDb.query(sql, values);
  await q(
    `INSERT INTO seasons (id, name, status, start_at, end_at, initial_capital_krw, trade_fee_rate, fx_fee_rate,
       final_ranking_min_traded_instruments, final_ranking_min_turnover_ratio, updated_at)
     VALUES ($1, 'bench', 'upcoming', $2, $3, 10000000, 0.001, 0.001, 5, 3, now())`,
    [SEASON, START, END],
  );
  await q(`UPDATE seasons SET status = 'ended' WHERE id = $1`, [SEASON]);
  // 40 KRX, 10 US, 10 crypto Spot, 10 Futures underlyings.
  for (const [prefix, symbol, market, type, currency, count] of [
    [
      'bench-krx-',
      "'B' || lpad(i::text, 5, '0')",
      'KOSPI',
      'domestic_stock',
      'KRW',
      40,
    ],
    ['bench-us-', "'BUS' || i", 'NAS', 'us_stock', 'USD', 10],
    ['bench-cs-', "'BCS' || i || 'USDT'", 'BINANCE', 'crypto', 'USD', 10],
    ['bench-fu-', "'BFU' || i || 'USDT'", 'BINANCE', 'crypto', 'USD', 10],
  ] as const) {
    await q(
      `INSERT INTO assets (id, symbol, name, market, asset_type, currency_code, price_currency, settlement_currency, is_active, updated_at)
       SELECT '${prefix}' || i, ${symbol}, 'bench', '${market}', '${type}', '${currency}', '${currency}', '${currency}', true, now()
       FROM generate_series(0, ${count - 1}) i`,
    );
  }
  await q(
    `INSERT INTO futures_instruments (id, underlying_asset_id, updated_at)
     SELECT 'bench-inst-' || i, 'bench-fu-' || i, now() FROM generate_series(0, 9) i`,
  );
  await q(
    `INSERT INTO futures_last_price_snapshots (id, instrument_id, symbol, source, price, effective_at, captured_at)
     SELECT 'bench-last-' || i, 'bench-inst-' || i, 'BFU' || i || 'USDT', 'binance_usdm_agg_trade_ws', 100, $1::timestamp, $1::timestamp
     FROM generate_series(0, 9) i`,
    [new Date(START.getTime() - 3_600_000)],
  );
  // FX: Korea EXIM daily, exchange_rate_api hourly, both captured on time.
  await q(
    `INSERT INTO fx_rate_snapshots (id, base_currency, quote_currency, rate, source_type, source_name, effective_at, captured_at)
     SELECT 'bench-ke-' || d, 'USD', 'KRW', 1300 + d, 'provider_api', 'korea_exim_exchange_rate',
            $1::timestamp + d * interval '1 day', $1::timestamp + d * interval '1 day'
     FROM generate_series(-1, 21) d`,
    [START],
  );
  await q(
    `INSERT INTO fx_rate_snapshots (id, base_currency, quote_currency, rate, source_type, source_name, effective_at, captured_at)
     SELECT 'bench-era-' || h, 'USD', 'KRW', 1300 + h * 0.01, 'provider_api', 'exchange_rate_api',
            $1::timestamp + h * interval '1 hour', $1::timestamp + h * interval '1 hour'
     FROM generate_series(-24, 21 * 24) h`,
    [START],
  );
  await q(
    `INSERT INTO users (id, email, password_hash, nickname, updated_at)
     SELECT 'bench-u-' || g, 'bench-' || g || '@example.invalid', 'x', 'bench' || g, now() FROM generate_series(1, $1::int) g`,
    [n],
  );
  await q(
    `INSERT INTO trading_accounts (id, user_id, mode, status, initial_capital_krw, opened_at, updated_at)
     SELECT 'bench-a-' || g, 'bench-u-' || g, 'season', 'active', 10000000, $2::timestamp, now() FROM generate_series(1, $1::int) g`,
    [n, START],
  );
  await q(
    `INSERT INTO season_participants (id, season_id, user_id, joined_at, participant_status, initial_capital_krw,
       total_asset_krw, total_return_rate, max_drawdown, updated_at, trading_account_id)
     SELECT 'bench-p-' || g, $2, 'bench-u-' || g, $3::timestamp, 'active', 10000000, 10000000, 0, 0, now(), 'bench-a-' || g
     FROM generate_series(1, $1::int) g`,
    [n, SEASON, START],
  );
  await q(
    `INSERT INTO cash_wallets (id, trading_account_id, wallet_scope, currency_code, balance_amount, updated_at)
     SELECT 'bench-w-' || g || '-' || w.scope || '-' || w.cur, 'bench-a-' || g, w.scope::"WalletScope", w.cur::"CurrencyCode",
            CASE WHEN w.cur = 'KRW' THEN 10000000 ELSE 0 END, now()
     FROM generate_series(1, $1::int) g
     CROSS JOIN (VALUES ('securities','KRW'), ('securities','USD'), ('crypto_spot','USD'), ('crypto_futures','USD')) AS w(scope, cur)`,
    [n],
  );
  // Fill k of participant g happens at a deterministic instant in the window.
  const instant = `($2::timestamp + ((k::float8 / (${TIER_SQL} + 1)) * interval '21 days') + ((g % 3600) * interval '1 second'))`;
  await q(
    `INSERT INTO orders (id, trading_account_id, asset_id, side, order_type, status, quantity, executed_price, currency_code,
       cash_wallet_scope, gross_amount, fee_amount, net_amount, fx_rate_snapshot_id, submitted_at, executed_at, updated_at)
     SELECT 'bench-o-' || g || '-' || k, 'bench-a-' || g,
            CASE WHEN k % 10 IN (3, 4) THEN (CASE WHEN (g + k) % 20 < 10 THEN 'bench-us-' || ((g + k) % 10) ELSE 'bench-cs-' || ((g + k) % 10) END)
                 ELSE 'bench-krx-' || ((g + k) % 40) END,
            (CASE WHEN k % 2 = 0 THEN 'buy' ELSE 'sell' END)::"OrderSide", 'market', 'executed', 1,
            CASE WHEN k % 10 IN (3, 4) THEN 100 + (k % 5) * 10 ELSE 100000 + (k % 7) * 10000 END,
            (CASE WHEN k % 10 IN (3, 4) THEN 'USD' ELSE 'KRW' END)::"CurrencyCode",
            (CASE WHEN k % 10 IN (3, 4) AND (g + k) % 20 >= 10 THEN 'crypto_spot' ELSE 'securities' END)::"WalletScope",
            CASE WHEN k % 10 IN (3, 4) THEN 100 + (k % 5) * 10 ELSE 100000 + (k % 7) * 10000 END, 0,
            CASE WHEN k % 10 IN (3, 4) THEN 100 + (k % 5) * 10 ELSE 100000 + (k % 7) * 10000 END,
            CASE WHEN k % 10 IN (3, 4) THEN 'bench-era-' || floor(extract(epoch FROM (${instant} - $2::timestamp)) / 3600)::int ELSE NULL END,
            ${instant}, ${instant}, now()
     FROM generate_series(1, $1::int) g
     CROSS JOIN LATERAL generate_series(1, ${TIER_SQL}) k
     WHERE k % 10 >= 3`,
    [n, START],
  );
  await q(
    `INSERT INTO futures_positions (id, trading_account_id, instrument_id, direction, margin_mode, status, quantity,
       average_entry_price, entry_notional, leverage, isolated_margin, closed_at, updated_at)
     SELECT 'bench-pos-' || g || '-' || s, 'bench-a-' || g, 'bench-inst-' || ((g + s) % 10), 'long', 'isolated', 'closed', 0,
            100, 0, 1 + ((g + s) % 20), 0, $2::timestamp, now()
     FROM generate_series(1, $1::int) g CROSS JOIN generate_series(0, 2) s`,
    [n, END],
  );
  await q(
    `INSERT INTO futures_executions (id, trading_account_id, instrument_id, position_id, operation, direction, margin_mode,
       quantity, leverage, execution_price, last_price_snapshot_id, price_source_type, price_source_name,
       price_effective_at, price_captured_at, notional, fee_rate, fee_amount, realized_pnl,
       position_quantity_after, average_entry_price_after, isolated_margin_after, executed_at, fx_rate_snapshot_id)
     SELECT 'bench-e-' || g || '-' || k, 'bench-a-' || g, 'bench-inst-' || ((g + k % 3) % 10), 'bench-pos-' || g || '-' || (k % 3),
            (CASE WHEN k % 3 = 0 THEN 'open' WHEN k % 3 = 1 THEN 'increase' ELSE 'reduce' END)::"FuturesOperation",
            'long', 'isolated', 1 + k % 4, 1 + ((g + k % 3) % 20), 100, 'bench-last-' || ((g + k % 3) % 10),
            'provider_api', 'binance_usdm_agg_trade_ws', $3::timestamp, $3::timestamp,
            100 * (1 + k % 4), 0.001, 0, 0, 1, 100, 1, ${instant},
            'bench-ke-' || floor(extract(epoch FROM (${instant} - $2::timestamp)) / 86400)::int
     FROM generate_series(1, $1::int) g
     CROSS JOIN LATERAL generate_series(1, ${TIER_SQL}) k
     WHERE k % 10 < 3`,
    [n, START, new Date(START.getTime() - 3_600_000)],
  );
  await q('ANALYZE');
  const counts = await q(
    `SELECT (SELECT count(*) FROM orders)::int AS orders, (SELECT count(*) FROM futures_executions)::int AS executions`,
  );
  return {
    fixtureSeconds: round((performance.now() - started) / 1000),
    orders: (counts.rows[0] as { orders: number }).orders,
    futuresExecutions: (counts.rows[0] as { executions: number }).executions,
  };
}

/** Executions as they looked before pinning (the as-of lookup path). */
async function unpinFuturesExecutions() {
  await fixtureDb.query('BEGIN');
  await fixtureDb.query(
    'ALTER TABLE futures_executions DISABLE TRIGGER futures_executions_fx_evidence_guard',
  );
  await fixtureDb.query(
    'UPDATE futures_executions SET fx_rate_snapshot_id = NULL',
  );
  await fixtureDb.query(
    'ALTER TABLE futures_executions ENABLE TRIGGER futures_executions_fx_evidence_guard',
  );
  await fixtureDb.query('COMMIT');
  await fixtureDb.query('ANALYZE futures_executions');
}

/** A settled result: 40% qualified (ranked 1..Q), every account closed. */
async function settleSynthetically() {
  const q = (sql: string, values: unknown[] = []) =>
    fixtureDb.query(sql, values);
  await q(
    `UPDATE season_participants SET participant_status = 'finished',
       final_qualified = (substr(id, 9)::int % 10 < 4),
       final_traded_instrument_count = 5, final_recognized_turnover_krw = 30000000,
       current_rank = NULL, final_rank = NULL, final_tier = NULL`,
  );
  await q(
    `WITH ranked AS (
       SELECT id, trading_account_id, row_number() OVER (ORDER BY id) AS r FROM season_participants WHERE final_qualified
     )
     UPDATE season_participants p SET final_rank = ranked.r, current_rank = ranked.r, final_tier = 'bronze'
     FROM ranked WHERE ranked.id = p.id`,
  );
  await q(
    `INSERT INTO season_rankings (id, season_id, season_participant_id, trading_account_id, rank_type, rank,
       total_asset_krw, return_rate, ranking_date, captured_at)
     SELECT 'bench-r-' || id, season_id, id, trading_account_id, 'final', final_rank, 10000000, 0, $1::date, $2::timestamp
     FROM season_participants WHERE final_qualified`,
    [formatKstRankingDate(END), END],
  );
  await q(`UPDATE trading_accounts SET status = 'closed', closed_at = $1`, [
    END,
  ]);
  await q(`UPDATE seasons SET status = 'settled' WHERE id = $1`, [SEASON]);
  await q('ANALYZE');
}

async function explain(statement: { text: string; values: unknown[] }) {
  const plan = await fixtureDb.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${statement.text}`,
    statement.values,
  );
  return (plan.rows as Array<{ 'QUERY PLAN': string }>).map(
    (row) => row['QUERY PLAN'],
  );
}

// ------------------------------------------------------------------ run
const PARTS = new Set(
  (
    process.env.SEASON_QUALIFICATION_BENCHMARK_PARTS ?? 'reads,settlement,final'
  ).split(','),
);

/** Primitive description of a failure: status, code and batch-run error. */
function describeFailure(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse() as {
      error?: { code?: string; message?: string };
      data?: { run?: { errorCode?: string; errorMessage?: string } };
    };
    return [
      error.getStatus(),
      body.error?.code,
      body.error?.message,
      body.data?.run?.errorCode,
      body.data?.run?.errorMessage,
    ]
      .filter((part) => part !== undefined && part !== null)
      .join(' | ')
      .slice(0, 600);
  }
  return (
    error instanceof Error
      ? `${error.constructor.name}: ${error.message}`
      : String(error)
  ).slice(0, 600);
}

const strip = <T extends { captured: unknown; value: unknown }>(run: T) => {
  const { captured: _captured, value: _value, ...rest } = run;
  void _captured;
  void _value;
  return rest;
};

async function measureReads(n: number, db: PrismaService) {
  const ranking = new RankingService(db);
  const fixture = await buildFixture(n);
  const season = { id: SEASON, startAt: START, endAt: END };
  const accounts = Array.from({ length: n }, (_, i) => `bench-a-${i + 1}`);

  // Warm-up (connection pool, plan cache) is not measured.
  await readSeasonTradingActivity(db, {
    season,
    tradingAccountIds: accounts.slice(0, 10),
  });

  const seasonWide = await observe(
    () =>
      readSeasonTradingActivity(db, { season, tradingAccountIds: accounts }),
    { capture: /"orders"|"futures_executions"/ },
  );
  const plans = {
    ordersBatch: await explain(
      seasonWide.captured.find(
        (s) => s.text.includes('"orders"') && !s.text.includes('COUNT'),
      )!,
    ),
    executionsBatch: await explain(
      seasonWide.captured.find((s) => s.text.includes('"futures_executions"'))!,
    ),
  };

  const sample = (tier: number) => {
    for (let g = 1; g <= n; g++) if (tierOf(g) === tier) return g;
    return null;
  };
  const progress: Record<string, unknown> = {};
  for (const tier of [10, 100, 500, 3000]) {
    const g = sample(tier);
    if (g === null) continue;
    const times: number[] = [];
    let statements = 0;
    for (let i = 0; i < 20; i++) {
      const run = await observe(() =>
        ranking.getFinalQualification(userOf(g), { seasonId: SEASON }),
      );
      times.push(run.ms);
      statements = run.statements;
    }
    progress[`fills_${tier}`] = { ...percentiles(times), statements };
  }
  const heavyUsers = Array.from({ length: n }, (_, i) => i + 1)
    .filter((g) => tierOf(g) >= 500)
    .slice(0, 20);
  const concurrent = await observe(() =>
    Promise.all(
      heavyUsers.map(async (g) => {
        const t = performance.now();
        await ranking.getFinalQualification(userOf(g), { seasonId: SEASON });
        return performance.now() - t;
      }),
    ),
  );

  const instants = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      new Date(
        START.getTime() + Math.floor((i * 21 * DAY) / count) + 7,
      ).toISOString(),
    );
  const fxLookup: Record<string, unknown> = {};
  for (const count of [1, 100, 1000]) {
    const run = await observe(
      () => findUsdKrwRatesAtOrBefore(db, instants(count)),
      { capture: /"fx_rate_snapshots"/ },
    );
    fxLookup[`instants_${count}`] = { ms: run.ms, statements: run.statements };
    if (count === 1000)
      fxLookup.plan = (await explain(run.captured[0])).slice(0, 14);
  }

  await unpinFuturesExecutions();
  const legacySeasonWide = await observe(() =>
    readSeasonTradingActivity(db, { season, tradingAccountIds: accounts }),
  );
  const legacyHeavy = sample(3000) ?? sample(500)!;
  const legacyProgressTimes: number[] = [];
  for (let i = 0; i < 10; i++)
    legacyProgressTimes.push(
      (
        await observe(() =>
          ranking.getFinalQualification(userOf(legacyHeavy), {
            seasonId: SEASON,
          }),
        )
      ).ms,
    );

  return {
    fixture,
    seasonWideEligibility: strip(seasonWide),
    plans,
    progressApi: progress,
    concurrentHeavyProgress: {
      callers: heavyUsers.length,
      wallMs: concurrent.ms,
      perCall: percentiles(concurrent.value),
      statements: concurrent.statements,
    },
    fxLookup,
    legacyUnpinned: {
      seasonWide: strip(legacySeasonWide),
      heaviestUserProgress: percentiles(legacyProgressTimes),
    },
  };
}

/** Settlement end to end on the eligibility season (cash-only valuations). */
async function measureSettlement(n: number, db: PrismaService) {
  await buildFixture(n);
  const valuation = new PortfolioValuationService(db);
  const job = new SeasonSettlementJobService(
    new BatchService(db),
    db,
    valuation,
  );
  const run = await observe(async () => {
    try {
      const response = await job.run({
        seasonId: SEASON,
        settlementDate: formatKstRankingDate(END),
        idempotencyKey: `bench:${n}:${Date.now()}`,
      });
      const result = response.data.run.resultPayloadJson as {
        finalQualification: { qualified: number; notQualified: number };
      };
      return `ok ${result.finalQualification.qualified} qualified / ${result.finalQualification.notQualified} not`;
    } catch (error) {
      return `FAILED ${describeFailure(error)}`;
    }
  });
  const after = await fixtureDb.query(
    `SELECT status FROM seasons WHERE id = $1`,
    [SEASON],
  );
  return {
    outcome: run.value,
    seasonStatus: (after.rows[0] as { status: string }).status,
    ms: run.ms,
    statements: run.statements,
    sqlMs: run.sqlMs,
    maxSeasonLockMs: run.maxSeasonLockMs,
    peakRssMb: run.peakRssMb,
  };
}

/** The final ranking read on a settled eligibility season. */
async function measureFinalRead(n: number, db: PrismaService) {
  const ranking = new RankingService(db);
  await buildFixture(n);
  await settleSynthetically();
  const integrity = await observe(() =>
    db.$transaction((tx) =>
      verifyEligibilityFinalResult(tx, { id: SEASON, status: 'settled' }),
    ),
  );
  const finalRead: Record<string, unknown> = {
    verification: { ms: integrity.ms, statements: integrity.statements },
  };
  for (const scope of ['all', 'top10', 'friends']) {
    const times: number[] = [];
    let statements = 0;
    for (let i = 0; i < 20; i++) {
      const run = await observe(() =>
        ranking.getRanking(userOf(1), {
          seasonId: SEASON,
          rankType: 'final',
          scope,
        }),
      );
      times.push(run.ms);
      statements = run.statements;
    }
    finalRead[scope] = { ...percentiles(times), statements };
  }
  return finalRead;
}

const userOf = (g: number) => `bench-u-${g}`;

async function measure(n: number) {
  const db = new PrismaService();
  try {
    return {
      participants: n,
      profile: WORST_BATCH ? 'worst-batch' : 'skewed',
      ...(PARTS.has('reads') ? await measureReads(n, db) : {}),
      settlement:
        PARTS.has('settlement') && n <= settleUpTo
          ? await measureSettlement(n, db)
          : 'skipped',
      finalRankingRead: PARTS.has('final')
        ? await measureFinalRead(n, db)
        : 'skipped',
    };
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  await fixtureDb.connect();
  const results: Array<Awaited<ReturnType<typeof measure>>> = [];
  try {
    for (const n of sizes) {
      const result = await measure(n);
      results.push(result);
      console.log(JSON.stringify(result));
    }
    await resetDatabase();
  } finally {
    await fixtureDb.end();
  }
  if (process.env.SEASON_QUALIFICATION_BENCHMARK_OUT)
    writeFileSync(
      process.env.SEASON_QUALIFICATION_BENCHMARK_OUT,
      JSON.stringify(results, null, 2),
    );
}

void main().catch((error: unknown) => {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.stack : String(error));
});
