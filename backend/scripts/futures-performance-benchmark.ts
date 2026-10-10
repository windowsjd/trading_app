/** Disposable loopback PostgreSQL only. No providers, production flags or caches.
 * Reuses canonical account/entry creation, Worker, ownership and price selectors.
 * Timings exclude fixture creation. Evaluation completion follows financial commit.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { db, app, fixture, newInstrument, now } from './futures-integration';
import { FuturesLimitService } from '../src/futures/futures-limit.service';
import { FuturesLimitWorker } from '../src/futures/futures-limit-worker.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';

const url = new URL(process.env.DATABASE_URL!);
assert.ok(
  process.env.NODE_ENV === 'test' &&
    process.env.FUTURES_PERFORMANCE_BENCHMARK === '1' &&
    url.hostname === '127.0.0.1' &&
    url.pathname === '/futures_performance',
  'Disposable loopback DB opt-in required',
);
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
const feed = new Client({ connectionString: url.toString() });
const monitor = new Client({ connectionString: url.toString() });
const contender = new Client({ connectionString: url.toString() });
const contentionMs = Number(process.env.BENCHMARK_CONTENTION_MS ?? 50);
assert.ok(
  Number.isInteger(contentionMs) && contentionMs >= 0 && contentionMs <= 1000,
);
const entries = new FuturesLimitService(
  db,
  new TradingAccountAccessService(db),
  app.futures,
);
const report: Record<string, unknown> = {
  head: process.env.BENCHMARK_HEAD,
  level: 'service-level; no HTTP/auth transport overhead',
  matching: [],
  market: [],
};
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    +(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0).toFixed(2);
  return { samples: sorted.length, p50: at(0.5), p95: at(0.95), max: at(1) };
}
async function refresh(last: string) {
  // Futures Last observations for every instrument (over-approximates the 1/s
  // ingestion write rate; each insert also runs the identity guard trigger).
  await feed.query(
    `INSERT INTO futures_last_price_snapshots (id,instrument_id,symbol,price,source,effective_at,captured_at)
    SELECT gen_random_uuid()::text,i.id,a.symbol,$1::numeric,'binance_usdm_agg_trade_ws',t.at,t.at FROM futures_instruments i JOIN assets a ON a.id=i.underlying_asset_id CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp()) at) t ON CONFLICT DO NOTHING`,
    [last],
  );
  const lastCommittedAt = performance.now();
  await feed.query(`INSERT INTO futures_mark_snapshots (id,instrument_id,symbol,price,source,effective_at,captured_at)
    SELECT gen_random_uuid()::text,i.id,a.symbol,100,'binance_usdm_mark_ws',t.at,t.at FROM futures_instruments i JOIN assets a ON a.id=i.underlying_asset_id CROSS JOIN (SELECT date_trunc('milliseconds',clock_timestamp()) at) t ON CONFLICT DO NOTHING`);
  await feed.query(`INSERT INTO fx_rate_snapshots (id,base_currency,quote_currency,rate,source_type,source_name,effective_at,captured_at)
    VALUES (gen_random_uuid()::text,'USD','KRW',1400,'provider_api','korea_exim_exchange_rate',clock_timestamp(),clock_timestamp())`);
  return lastCommittedAt;
}
async function upkeep(spot: string) {
  let stop = false,
    rss = process.memoryUsage().rss,
    connections = 0,
    active = 0,
    lockWaiters = 0,
    dbRss = 0;
  const start = performance.now(),
    cpu = process.cpuUsage();
  const procCpu = new Map<number, number>();
  let pgCpuTicks = 0,
    nodeCpuPeak = 0,
    pgCpuPeak = 0;
  let previousSampleAt = start,
    previousNodeCpu = cpu;
  const loop = (async () => {
    while (!stop) {
      await refresh(spot);
      const stats = await monitor.query(
        `SELECT pid,state,wait_event_type FROM pg_stat_activity WHERE datname=current_database()`,
      );
      connections = Math.max(connections, stats.rows.length);
      active = Math.max(
        active,
        stats.rows.filter((r) => r.state === 'active').length,
      );
      lockWaiters = Math.max(
        lockWaiters,
        stats.rows.filter((r) => r.wait_event_type === 'Lock').length,
      );
      let sampledRss = 0,
        sampledTicks = 0;
      for (const row of stats.rows) {
        try {
          const stat = readFileSync(`/proc/${row.pid}/stat`, 'utf8')
            .split(') ')[1]
            .split(' ');
          const ticks = +stat[11] + +stat[12];
          if (procCpu.has(row.pid)) {
            const delta = Math.max(0, ticks - procCpu.get(row.pid)!);
            pgCpuTicks += delta;
            sampledTicks += delta;
          }
          procCpu.set(row.pid, ticks);
          sampledRss += +stat[21] * 4096;
        } catch {
          /* a backend may have exited */
        }
      }
      const sampleAt = performance.now(),
        sampleCpu = process.cpuUsage();
      const sampleMs = sampleAt - previousSampleAt;
      if (sampleMs >= 100) {
        nodeCpuPeak = Math.max(
          nodeCpuPeak,
          (sampleCpu.user -
            previousNodeCpu.user +
            sampleCpu.system -
            previousNodeCpu.system) /
            sampleMs /
            10,
        );
        pgCpuPeak = Math.max(pgCpuPeak, (sampledTicks * 1000) / sampleMs);
      }
      previousSampleAt = sampleAt;
      previousNodeCpu = sampleCpu;
      dbRss = Math.max(dbRss, sampledRss);
      rss = Math.max(rss, process.memoryUsage().rss);
      await delay(200);
    }
  })();
  return async () => {
    stop = true;
    await loop;
    const elapsed = performance.now() - start,
      used = process.cpuUsage(cpu);
    const statements = await monitor.query(
      `SELECT calls,total_exec_time,mean_exec_time,max_exec_time,query FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY total_exec_time DESC`,
    );
    const application = statements.rows.filter(
      (row) =>
        !/benchmark contention|pg_stat_|^INSERT INTO (?:futures_last_price_snapshots|futures_mark_snapshots|fx_rate_snapshots)|^SELECT pid,state/iu.test(
          row.query,
        ),
    );
    const database = await monitor.query(
      'SELECT deadlocks FROM pg_stat_database WHERE datname=current_database()',
    );

    return {
      nodeRssPeakBytes: rss,
      nodeCpuPeakPercentOneCore: +nodeCpuPeak.toFixed(2),
      pgBackendCpuPeakPercentOneCore: +pgCpuPeak.toFixed(2),
      nodeCpuPercentOneCore: +(
        (used.user + used.system) /
        elapsed /
        10
      ).toFixed(2),
      pgBackendRssSumPeakBytes: dbRss,
      pgBackendCpuPercentOneCore: +((pgCpuTicks * 1000) / elapsed).toFixed(2),
      maxConnections: connections,
      maxActiveConnections: active,
      maxSampledLockWaiters: lockWaiters,
      applicationQueries: application.reduce(
        (sum, row) => sum + Number(row.calls),
        0,
      ),
      totalDatabaseQueriesIncludingFeedAndMonitor: statements.rows.reduce(
        (sum, row) => sum + Number(row.calls),
        0,
      ),
      dbDeadlocks: Number(database.rows[0].deadlocks),
      pgTopStatements: application
        .slice(0, 8)
        .map((row) => ({ ...row, query: row.query.slice(0, 180) })),
    };
  };
}
async function begin(spot: string) {
  await monitor.query('SELECT pg_stat_statements_reset()');
  return upkeep(spot);
}
async function clear() {
  await feed.query(
    'TRUNCATE users,assets,seasons,fx_rate_snapshots,ops_job_locks,ops_job_runs CASCADE',
  );
}
async function matching(count: number, fraction: number, label: string) {
  const base = await fixture('general');
  const instruments = [...base.instruments];
  while (instruments.length < 10) instruments.push(await newInstrument());
  const accounts = [{ userId: base.userId, accountId: base.accountId }];
  for (let i = 1; i < Math.ceil(count / 2); i++) {
    const user = await db.user.create({
      data: {
        email: `perf-${randomUUID()}@example.invalid`,
        nickname: randomUUID().slice(0, 16),
        passwordHash: 'test-only',
      },
    });
    const accountId = (await app.general.openGeneralAccount(user.id)).data
      .account.id;
    await db.cashWallet.updateMany({
      where: { tradingAccountId: accountId, walletScope: 'crypto_futures' },
      data: { balanceAmount: '10000' },
    });
    accounts.push({ userId: user.id, accountId });
  }
  let stopSeed = false;
  const seedFeed = (async () => {
    while (!stopSeed) {
      await refresh('120');
      await delay(500);
    }
  })();
  const ids = new Set<string>();
  let expected = 0;
  try {
    for (let i = 0; i < count; i++) {
      const account = accounts[Math.floor(i / 2)],
        eligible = fraction === 1 || (fraction > 0 && i % 10 === 0);
      expected += +eligible;
      const result = await entries.create(account.userId, account.accountId, {
        instrumentId: instruments[i % 10].instrument.id,
        direction: 'long',
        marginMode: i % 2 ? 'cross' : 'isolated',
        quantity: '1',
        leverage: 10,
        limitPrice: eligible ? '110' : '90',
        idempotencyKey: randomUUID(),
      });
      const orderId = `perf-entry-${String(i).padStart(5, '0')}`;
      await db.futuresLimitOrder.update({
        where: { id: result.data.order.id },
        data: { id: orderId },
      });
      ids.add(orderId);
    }
  } finally {
    stopSeed = true;
    await seedFeed;
  }
  await feed.query('ANALYZE');
  const origin = await refresh('100'); // first eligible Futures Last commit; no UI polling
  const stop = await begin('100');
  let contentionRelease = Promise.resolve();
  let contentionInjections = 0;
  const worker = new FuturesLimitWorker(
    db,
    new OpsJobLockService(db),
    new OpsJobRunService(db),
    entries,
  );
  const visits = new Map<string, number[]>(),
    latencies: number[] = [],
    evaluationTimes: number[] = [];
  const evaluate = entries.evaluate.bind(entries);
  entries.evaluate = async (id) => {
    const start = performance.now();
    const times = visits.get(id) ?? [];
    times.push(start);
    visits.set(id, times);
    if (contentionMs && Number(id.split('-').at(-1)) % 20 === 0) {
      await contentionRelease;
      const index = Number(id.split('-').at(-1));
      await contender.query('/* benchmark contention */ BEGIN');
      await contender.query(
        "/* benchmark contention */ SELECT id FROM cash_wallets WHERE trading_account_id=$1 AND wallet_scope='crypto_futures' FOR UPDATE",
        [accounts[Math.floor(index / 2)].accountId],
      );
      contentionInjections++;
      contentionRelease = delay(contentionMs).then(async () => {
        await contender.query('/* benchmark contention */ COMMIT');
      });
    }
    try {
      const result = await evaluate(id);
      if (result.state === 'executed')
        latencies.push(performance.now() - origin);
      return result;
    } finally {
      evaluationTimes.push(performance.now() - start);
    }
  };
  const cycles: number[] = [],
    states: Record<string, number> = {};
  let sweepMs = 0;
  try {
    while (performance.now() - origin < 180000) {
      const start = performance.now();
      const result = await worker.tick();
      cycles.push(performance.now() - start);
      for (const [state, value] of Object.entries(result ?? {}))
        states[state] = (states[state] ?? 0) + value;
      if (!sweepMs && visits.size === count)
        sweepMs = performance.now() - origin;
      if (
        sweepMs &&
        latencies.length === expected &&
        (expected === count ||
          [...visits.values()].filter((v) => v.length >= 2).length >=
            count - expected)
      )
        break;
      // Same one-second timer cadence; no overlapping worker cycles.
      await delay(
        Math.max(
          0,
          Math.ceil((performance.now() - origin) / 1000) * 1000 -
            (performance.now() - origin),
        ),
      );
    }
  } finally {
    entries.evaluate = evaluate;
    await contentionRelease;
  }
  const elapsed = performance.now() - origin,
    resources = await stop();
  assert.equal(visits.size, count);
  assert.equal(latencies.length, expected);
  assert.equal(await db.futuresExecution.count(), expected);
  assert.equal(
    await db.equitySnapshot.count({
      where: { snapshotReason: 'order_executed' },
    }),
    expected,
  );
  const revisits = [...visits.values()].flatMap((v) =>
    v.slice(1).map((t, i) => t - v[i]),
  );
  const errors = Object.keys(states).filter(
    (s) =>
      ![
        'executed',
        'FUTURES_ENTRY_LIMIT_NOT_REACHED',
        'FUTURES_ENTRY_LIMIT_UNAVAILABLE',
      ].includes(s),
  );
  const rows = {
    label,
    contentionMs,
    contentionInjections,
    oldestObservedUninspectedWaitMs: +Math.max(
      ...[...visits.values()].map((v) => v[0] - origin),
      ...revisits,
    ).toFixed(2),
    orders: count,
    eligible: expected,
    elapsedMs: +elapsed.toFixed(2),
    cycles: summary(cycles),
    evaluationMs: summary(evaluationTimes),
    fillCommitLatencyMs: summary(latencies),
    firstSweepMs: +sweepMs.toFixed(2),
    revisitMs: summary(revisits),
    evaluationsPerSecond: +((evaluationTimes.length * 1000) / elapsed).toFixed(
      2,
    ),
    commitsPerSecond: +((expected * 1000) / sweepMs).toFixed(2),
    states,
    unexpectedStates: errors,
    resources,
  };
  (report.matching as unknown[]).push(rows);
  console.log(JSON.stringify(rows));
  await clear();
}
async function market() {
  const s = await fixture('general');
  const instruments = [...s.instruments];
  while (instruments.length < 10) instruments.push(await newInstrument());
  const users = [{ userId: s.userId, accountId: s.accountId }];
  for (let i = 1; i < 300; i++) {
    const user = await db.user.create({
      data: {
        email: `market-${randomUUID()}@example.invalid`,
        nickname: randomUUID().slice(0, 16),
        passwordHash: 'test-only',
      },
    });
    const accountId = (await app.general.openGeneralAccount(user.id)).data
      .account.id;
    users.push({ userId: user.id, accountId });
  }
  for (const size of [1, 5, 10]) {
    await db.futuresInstrument.updateMany({ data: { isActive: false } });
    await db.futuresInstrument.updateMany({
      where: {
        id: { in: instruments.slice(0, size).map((i) => i.instrument.id) },
      },
      data: { isActive: true },
    });
    await refresh('100');
    for (const concurrency of size === 10 ? [20, 100, 300] : [20]) {
      for (const pattern of ['burst', 'polling-5s']) {
        await app.futures.instruments(s.userId, s.accountId); // warm the pool
        const stop = await begin('100');
        const durations: number[] = [];
        let failures = 0;
        const origin = performance.now();
        const request = async (i: number) => {
          const start = performance.now();
          try {
            const body = await app.futures.instruments(
              users[i].userId,
              users[i].accountId,
            );
            assert.equal(body.data.tradingAccountId, users[i].accountId);
            assert.equal(body.data.instruments.length, size);
          } catch {
            failures++;
          }
          durations.push(performance.now() - start);
        };
        if (pattern === 'burst')
          for (let round = 0; round < 3; round++)
            await Promise.all(
              users.slice(0, concurrency).map((_, i) => request(i)),
            );
        else
          await Promise.all(
            users.slice(0, concurrency).map(async (_, i) => {
              await delay((i * 5000) / concurrency);
              for (let round = 0; round < 2; round++) {
                const start = performance.now();
                await request(i);
                if (!round)
                  await delay(Math.max(0, 5000 - (performance.now() - start)));
              }
            }),
          );
        const elapsed = performance.now() - origin;
        const resources = await stop();
        const rows = {
          instruments: size,
          concurrency,
          pattern,
          requests: durations.length,
          failures,
          elapsedMs: +elapsed.toFixed(2),
          serviceLatencyMs: summary(durations),
          queriesPerRequest: +(
            resources.applicationQueries / durations.length
          ).toFixed(2),
          resources,
        };
        (report.market as unknown[]).push(rows);
        console.log(JSON.stringify(rows));
        assert.equal(failures, 0);
      }
    }
  }
  await clear();
}
async function main() {
  await db.$connect();
  await feed.connect();
  await monitor.connect();
  await contender.connect();
  assert.equal(await db.user.count(), 0);
  assert.equal(await db.asset.count(), 0);
  await monitor.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  report.environment = {
    node: process.version,
    postgres: (await monitor.query('SHOW server_version')).rows[0]
      .server_version,
    pool: 'PrismaPg default max 10',
    databaseClock: (await now()).toISOString(),
  };
  if (process.env.BENCHMARK_PHASE !== 'market')
    for (const [count, fraction, label] of [
      [100, 0, 'A'],
      [100, 0.1, 'B'],
      [500, 0.1, 'C'],
      [1000, 0.1, 'D'],
      [1000, 1, 'E'],
    ] as const)
      await matching(count, fraction, label);
  if (process.env.BENCHMARK_PHASE !== 'matching') await market();
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (process.env.BENCHMARK_REPORT)
      writeFileSync(
        process.env.BENCHMARK_REPORT,
        JSON.stringify(report, null, 2) + '\n',
      );
    await db.$disconnect();
    await feed.end();
    await monitor.end();
    await contender.end();
  });
