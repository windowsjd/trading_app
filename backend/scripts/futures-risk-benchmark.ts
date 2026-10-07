/** Opt-in, empty disposable loopback DB only. Measure real worker/locks/transactions;
 * fixture creation, deterministic Mark refresh and monitoring are outside timings. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { FuturesLiquidationService } from '../src/futures/futures-liquidation.service';
import { FuturesRiskWorker } from '../src/futures/futures-risk-worker.service';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { futuresRiskConfig } from '../src/futures/futures.config';

let url: URL;
try {
  url = new URL(process.env.DATABASE_URL ?? 'file:///missing');
} catch {
  // URL parse errors may echo their input, including credentials.
  throw new Error('Requires a valid disposable PostgreSQL URL.');
}
assert.ok(
  process.env.NODE_ENV === 'test' &&
    process.env.FUTURES_RISK_BENCHMARK === '1' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.pathname === '/futures_f21_benchmark',
  'Requires explicit test opt-in and an empty loopback futures_f21_benchmark DB.',
);
const sizes = (process.env.FUTURES_BENCHMARK_SIZES ?? '100,1000,10000')
  .split(',')
  .map(Number);
assert.ok(sizes.every((n) => Number.isInteger(n) && n >= 1 && n <= 10000));
process.env.FUTURES_RISK_ENGINE_ENABLED = 'true';
process.env.FUTURES_TRADING_MODE = 'DISABLED';
process.env.GENERAL_TRADE_FEE_RATE = '0.001000';
const db = new PrismaService();
const monitor = new Client({ connectionString: process.env.DATABASE_URL });
const fixtureDb = new Client({ connectionString: process.env.DATABASE_URL });
const reports: unknown[] = [];

async function seed(count: number, candidates: boolean) {
  // All accounts have the canonical four wallets and genuine initial-grant shape.
  await fixtureDb.query(
    `INSERT INTO users (id,email,nickname,password_hash,updated_at)
    SELECT 'bench-u-'||n, 'bench-'||n||'@example.invalid', 'bench-'||n, 'test-only', now()
    FROM generate_series(1,$1) n`,
    [count],
  );
  await fixtureDb.query(
    `INSERT INTO trading_accounts (id,user_id,mode,initial_capital_krw,opened_at,updated_at)
    SELECT 'bench-a-'||lpad(n::text,5,'0'), 'bench-u-'||n, 'general', 10000000, now(), now()
    FROM generate_series(1,$1) n`,
    [count],
  );
  await fixtureDb.query(
    `INSERT INTO cash_wallets (id,trading_account_id,wallet_scope,currency_code,balance_amount,updated_at)
    SELECT a.id||'-'||s.scope||'-'||s.currency,a.id,s.scope::"WalletScope",s.currency::"CurrencyCode",
      CASE WHEN s.currency='KRW' THEN 10000000 WHEN s.scope='crypto_futures'
        THEN CASE WHEN $1 AND substring(a.user_id from '[0-9]+$')::int % 10=0 THEN 2 ELSE 10000 END ELSE 0 END, now()
    FROM trading_accounts a CROSS JOIN (VALUES ('securities','KRW'),('securities','USD'),('crypto_spot','USD'),('crypto_futures','USD')) s(scope,currency)`,
    [candidates],
  );
  await fixtureDb.query(`INSERT INTO wallet_transactions (id,trading_account_id,wallet_id,currency_code,direction,tx_type,reference_type,reference_id,amount,balance_after,occurred_at)
    SELECT a.id||'-grant',a.id,a.id||'-securities-KRW','KRW','credit','initial_grant','general_account_open',a.id,10000000,10000000,now() FROM trading_accounts a`);
  for (const n of [0, 1, 2, 3]) {
    await db.asset.create({
      data: {
        id: `bench-asset-${n}`,
        symbol: `F21BENCH${n}USDT`,
        name: 'Benchmark',
        assetType: 'crypto',
        market: 'BINANCE',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
      },
    });
    await db.futuresInstrument.create({
      data: {
        id: `bench-instrument-${n}`,
        underlyingAssetId: `bench-asset-${n}`,
      },
    });
  }
  // 1/3 single Isolated, 1/3 single Cross, 1/3 mixed (two positions).
  await fixtureDb.query(
    `INSERT INTO futures_positions (id,trading_account_id,instrument_id,direction,margin_mode,quantity,average_entry_price,entry_notional,leverage,isolated_margin,updated_at)
    SELECT a.id||'-p1',a.id,'bench-instrument-'||CASE WHEN $1 AND n%10=0 THEN '2' ELSE '0' END,'long',
      CASE WHEN n%3=1 THEN 'cross' ELSE 'isolated' END::"FuturesMarginMode",1,100,100,100,CASE WHEN n%3=1 THEN 0 ELSE 1 END,now()
    FROM (SELECT *,substring(user_id from '[0-9]+$')::int n FROM trading_accounts) a`,
    [candidates],
  );
  await fixtureDb.query(
    `INSERT INTO futures_positions (id,trading_account_id,instrument_id,direction,margin_mode,quantity,average_entry_price,entry_notional,leverage,isolated_margin,updated_at)
    SELECT a.id||'-p2',a.id,'bench-instrument-'||CASE WHEN $1 AND n%10=0 THEN '3' ELSE '1' END,'long','cross',1,100,100,100,0,now()
    FROM (SELECT *,substring(user_id from '[0-9]+$')::int n FROM trading_accounts) a WHERE n%3=2`,
    [candidates],
  );
  await fixtureDb.query('ANALYZE');
}
async function refreshMarks() {
  await fixtureDb.query(`INSERT INTO futures_mark_snapshots (id,instrument_id,symbol,source,price,effective_at,captured_at)
    SELECT gen_random_uuid()::text,i.id,a.symbol,'binance_usdm_mark_ws',CASE WHEN i.id IN ('bench-instrument-2','bench-instrument-3') THEN 98 ELSE 100 END,t.at,t.at
    FROM futures_instruments i JOIN assets a ON a.id=i.underlying_asset_id
    CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp()) at) t
    ON CONFLICT (instrument_id,source,effective_at) DO NOTHING`);
}
async function clear() {
  await fixtureDb.query(
    'TRUNCATE users,assets,ops_job_locks,ops_job_runs CASCADE',
  );
}
async function measure(count: number, candidates: boolean) {
  await seed(count, candidates);
  await refreshMarks();
  const liquidation = new FuturesLiquidationService(db);
  const worker = new FuturesRiskWorker(
    db,
    new OpsJobLockService(db),
    new OpsJobRunService(db),
    liquidation,
  );
  const visits = new Map<string, number[]>();
  let tickNumber = 0,
    tickRunning = false,
    maxActiveConnections = 0,
    maxLockWaiters = 0,
    failures = 0,
    scopes = 0;
  let maxConcurrentTransactions = 0,
    activeTransactions = 0;
  const outcomes: Record<string, number> = {};
  const lastTick = new Map<string, number>();
  const tick = worker.tick.bind(worker);
  worker.tick = async () => {
    if (tickRunning) return;
    tickRunning = true;
    tickNumber++;
    try {
      await tick();
    } finally {
      tickRunning = false;
    }
  };
  const liquidate = liquidation.liquidate.bind(liquidation);
  const candidateScopes = liquidation.candidateScopes.bind(liquidation);
  liquidation.candidateScopes = async (accountId) => {
    if (lastTick.get(accountId) !== tickNumber) {
      visits.set(accountId, [
        ...(visits.get(accountId) ?? []),
        performance.now(),
      ]);
      lastTick.set(accountId, tickNumber);
    }
    const result = await candidateScopes(accountId);
    scopes += result.length;
    outcomes.healthy_preview =
      (outcomes.healthy_preview ?? 0) +
      result.filter((row) => !row.candidate).length;
    return result;
  };
  liquidation.liquidate = async (accountId, scope) => {
    activeTransactions++;
    maxConcurrentTransactions = Math.max(
      maxConcurrentTransactions,
      activeTransactions,
    );
    try {
      const result = await liquidate(accountId, scope);
      outcomes[result.state] = (outcomes[result.state] ?? 0) + 1;
      return result;
    } catch (error) {
      failures++;
      throw error;
    } finally {
      activeTransactions--;
    }
  };
  let stop = false;
  const upkeep = (async () => {
    while (!stop) {
      await refreshMarks();
      const stats =
        await monitor.query(`SELECT count(*) FILTER (WHERE state='active')::int active,
        count(*) FILTER (WHERE wait_event_type='Lock')::int waiting FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()`);
      maxActiveConnections = Math.max(
        maxActiveConnections,
        stats.rows[0].active,
      );
      maxLockWaiters = Math.max(maxLockWaiters, stats.rows[0].waiting);
      await delay(100);
    }
  })();
  const started = performance.now();
  let firstSweepMs = 0;
  worker.onModuleInit();
  const first = worker.tick();
  try {
    while (true) {
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 600000, 'Benchmark exceeded ten minutes.');
      if (!firstSweepMs && visits.size === count && !tickRunning)
        firstSweepMs = elapsed;
      const open = await monitor.query(
        `SELECT count(DISTINCT trading_account_id)::int n FROM futures_positions WHERE status='open'`,
      );
      const revisited = [...visits.values()].filter(
        (v) => v.length >= 2,
      ).length;
      if (firstSweepMs && revisited >= open.rows[0].n && !tickRunning) break;
      await delay(25);
    }
    await first;
  } finally {
    worker.onModuleDestroy();
    while (tickRunning) await delay(25);
    stop = true;
    await upkeep;
  }
  const revisit = [...visits.values()].flatMap((v) =>
    v.slice(1).map((at, i) => at - v[i]),
  );
  const report = {
    count,
    workload: candidates ? '10% liquidation candidates' : 'healthy mixed',
    config: futuresRiskConfig(),
    averagePositions: (count + Math.floor((count + 1) / 3)) / count,
    firstSweepMs: +firstSweepMs.toFixed(2),
    accountsPerSecond: +((count * 1000) / firstSweepMs).toFixed(2),
    maxObservedRevisitMs: +Math.max(0, ...revisit).toFixed(2),
    ticks: tickNumber,
    scopes,
    outcomes,
    failures,
    maxConcurrentTransactions,
    maxActiveConnections,
    maxLockWaiters,
  };
  assert.equal(
    failures,
    0,
    'Unexpected transaction failures invalidate benchmark.',
  );
  console.log(JSON.stringify(report));
  reports.push(report);
  await clear();
}
async function main() {
  await db.$connect();
  await monitor.connect();
  await fixtureDb.connect();
  assert.equal(await db.user.count(), 0, 'Benchmark DB must be empty.');
  assert.equal(await db.asset.count(), 0, 'Benchmark DB assets must be empty.');
  assert.equal(
    await db.opsJobLock.count(),
    0,
    'Benchmark DB leases must be empty.',
  );
  assert.equal(
    await db.opsJobRun.count(),
    0,
    'Benchmark DB runs must be empty.',
  );
  console.log(
    JSON.stringify({
      postgres: (await monitor.query('SHOW server_version')).rows[0]
        .server_version,
      node: process.version,
      cpus: (await import('node:os')).availableParallelism(),
    }),
  );
  for (const count of sizes)
    for (const candidates of [false, true]) await measure(count, candidates);
  if (process.env.FUTURES_BENCHMARK_REPORT)
    writeFileSync(
      process.env.FUTURES_BENCHMARK_REPORT,
      JSON.stringify(reports, null, 2) + '\n',
    );
}
main()
  .catch((error: unknown) => {
    console.error(
      'Futures benchmark failed',
      error instanceof Error ? error.name : 'unrecognized',
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
    await monitor.end();
    await fixtureDb.end();
  });
