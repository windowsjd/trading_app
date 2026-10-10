/** Disposable HTTP benchmark of the real Futures controller/services/PG queries.
 * Fixture authentication sets req.user; JWT verification is outside this measurement.
 * NODE_ENV=test FUTURES_DB_INTEGRATION=1 DATABASE_URL=.../<name>_test REDIS_URL=loopback
 * BENCH_REPORT=/path.json pnpm tsx scripts/futures-read-api-benchmark.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { Request, Response, NextFunction } from 'express';
import {
  db,
  app,
  fixture,
  newInstrument,
  now,
  fxEvidence,
  openBody,
} from './futures-integration';
import { FuturesController } from '../src/futures/futures.controller';
import { FuturesService } from '../src/futures/futures.service';

for (const key of ['DATABASE_URL', 'REDIS_URL']) {
  const url = new URL(process.env[key]!);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  if (key === 'DATABASE_URL') assert.ok(url.pathname.endsWith('_test'));
}
assert.equal(process.env.NODE_ENV, 'test');
assert.ok(process.env.BENCH_REPORT);
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.FUTURES_RISK_ENGINE_ENABLED = 'true';
const summary = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) =>
    +(s[Math.max(0, Math.ceil(s.length * p) - 1)] ?? 0).toFixed(2);
  return {
    samples: s.length,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: q(1),
  };
};
type Stats = {
  queryid: bigint;
  query: string;
  calls: bigint;
  total_exec_time: number;
  rows: bigint;
};
const stats = () =>
  db.$queryRaw<
    Stats[]
  >`SELECT queryid, query, calls, total_exec_time, rows FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`;
const dbSettings = () =>
  db.$queryRaw`SELECT current_database(), version(), current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit, current_setting('shared_buffers') AS shared_buffers`;
function cpuTicks() {
  let ticks = 0,
    rssKiB = 0;
  // PostgreSQL PIDs are discovered via PG, never by mutating shared processes.
  for (const pid of trackedPids) {
    try {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8')
        .split(') ')[1]
        .split(' ');
      ticks += Number(fields[11]) + Number(fields[12]);
      const rss = readFileSync(`/proc/${pid}/status`, 'utf8').match(
        /VmRSS:\s+(\d+)/,
      )?.[1];
      rssKiB += Number(rss ?? 0);
    } catch {
      /* process finished */
    }
  }
  return { ticks, rssMiB: rssKiB / 1024 };
}
let trackedPids: number[] = [];
let closeHttp: (() => Promise<void>) | undefined;
async function main() {
  const s = await fixture('general');
  const instruments = [...s.instruments];
  while (instruments.length < 23) instruments.push(await newInstrument());
  let feedErrors = 0,
    feedBusy = false,
    feedWrites = 0;
  const feed = async () => {
    if (feedBusy) return;
    feedBusy = true;
    try {
      const at = await now();
      // Consistent genuine test observations; policy and clocks are not altered.
      const data = instruments.map(({ asset, instrument }) => ({
        instrumentId: instrument.id,
        symbol: asset.symbol,
        price: '100',
        effectiveAt: new Date(+at - 100),
        capturedAt: at,
      }));
      feedWrites += (
        await db.futuresLastPriceSnapshot.createMany({
          data: data.map((r) => ({
            ...r,
            source: 'binance_usdm_agg_trade_ws',
          })),
          skipDuplicates: true,
        })
      ).count;
      feedWrites += (
        await db.futuresMarkSnapshot.createMany({
          data: data.map((r) => ({ ...r, source: 'binance_usdm_mark_ws' })),
          skipDuplicates: true,
        })
      ).count;
      await fxEvidence();
    } catch {
      feedErrors++;
    } finally {
      feedBusy = false;
    }
  };
  await feed();
  for (let i = 0; i < 2; i++)
    await app.futures.execute(
      s.userId,
      s.accountId,
      openBody(s, {
        instrumentId: instruments[i].instrument.id,
        marginMode: 'cross',
        quantity: '1',
        leverage: 10,
      }),
    );
  const actors = [{ userId: s.userId, accountId: s.accountId }];
  const accountCount = Number(process.env.BENCH_ACCOUNTS ?? 1);
  assert.ok(
    Number.isSafeInteger(accountCount) &&
      accountCount >= 1 &&
      accountCount <= 100,
  );
  const positionFixtures = await db.futuresPosition.findMany({
    where: { tradingAccountId: s.accountId, status: 'open' },
  });
  while (actors.length < accountCount) {
    const user = await db.user.create({
      data: {
        email: `bench-${randomUUID()}@example.invalid`,
        nickname: randomUUID().slice(0, 16),
        passwordHash: 'disposable-read-fixture',
      },
    });
    const accountId = (await app.general.openGeneralAccount(user.id)).data
      .account.id;
    await db.cashWallet.updateMany({
      where: { tradingAccountId: accountId, walletScope: 'crypto_futures' },
      data: { balanceAmount: '10000' },
    });
    // Additional owners are read fixtures; no execution/ledger traffic is claimed.
    await db.futuresPosition.createMany({
      data: positionFixtures.map((p) => ({
        ...p,
        id: randomUUID(),
        tradingAccountId: accountId,
      })),
    });
    actors.push({ userId: user.id, accountId });
  }
  await feed();
  // tsx does not emit TypeScript decorator parameter metadata.
  Reflect.defineMetadata(
    'design:paramtypes',
    [FuturesService],
    FuturesController,
  );
  const server = await Test.createTestingModule({
    controllers: [FuturesController],
    providers: [{ provide: FuturesService, useValue: app.futures }],
  }).compile();
  const http = server.createNestApplication();
  closeHttp = () => http.close();
  http.use(
    (
      req: Request & { user?: { userId: string } },
      _res: Response,
      next: NextFunction,
    ) => {
      const user = req.header('x-fixture-user');
      if (user) req.user = { userId: user };
      next();
    },
  );
  await http.listen(0, '127.0.0.1');
  const base = await http.getUrl();
  const request = async (
    route: string,
    user = s.userId,
    accountId = s.accountId,
  ) => {
    const response = await fetch(
      base + `/api/v1/trading-accounts/${accountId}/futures/` + route,
      {
        headers: { 'x-fixture-user': user },
      },
    );
    return { status: response.status, body: (await response.json()) as any };
  };
  assert.equal((await request('instruments', randomUUID())).status, 404);
  assert.equal((await request('positions', randomUUID())).status, 404);
  trackedPids = (
    await db.$queryRaw<
      Array<{ pid: number }>
    >`SELECT pid FROM pg_stat_activity WHERE datname = current_database()`
  ).map((r) => r.pid);
  const settings = await dbSettings();
  const catalog = await request('instruments');
  assert.equal(catalog.body.data.instruments.length, 23);
  const single: Record<string, unknown> = {};
  for (const route of ['instruments', 'positions']) {
    const before = await stats();
    await request(route);
    const after = await stats();
    const deltas = after
      .map((r) => ({
        query: r.query,
        calls: Number(
          r.calls - (before.find((b) => b.queryid === r.queryid)?.calls ?? 0n),
        ),
      }))
      .filter((r) => r.calls > 0 && !r.query.includes('pg_stat_statements'));
    single[route] = {
      sqlQueries: deltas.reduce((n, r) => n + r.calls, 0),
      queries: deltas,
    };
  }
  const interval = setInterval(() => {
    void feed();
  }, 1000);
  const stages: unknown[] = [];
  try {
    const stageSeconds = Number(process.env.BENCH_STAGE_SECONDS ?? 12);
    for (const concurrency of [1, 10, 50]) {
      const before = await stats();
      const cpuBefore = process.cpuUsage(),
        pgBefore = cpuTicks(),
        start = performance.now();
      const latencies: Record<string, number[]> = {
        instruments: [],
        positions: [],
      };
      const errors: Record<string, number> = {};
      let requests = 0,
        missingPrices = 0,
        peakNodeRss = 0,
        peakConnections = 0;
      const monitor = setInterval(() => {
        peakNodeRss = Math.max(peakNodeRss, process.memoryUsage().rss);
      }, 100);
      const dbMonitor = setInterval(() => {
        void db.$queryRaw<
          Array<{ n: bigint }>
        >`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database()`.then(
          (r) => {
            peakConnections = Math.max(peakConnections, Number(r[0].n));
          },
        );
      }, 1000);
      await Promise.all(
        Array.from({ length: concurrency }, async (_, worker) => {
          const actor = actors[worker % actors.length];
          let i = worker;
          while (performance.now() - start < stageSeconds * 1000) {
            const route = i++ % 2 === 0 ? 'instruments' : 'positions';
            const at = performance.now();
            try {
              const result = await request(
                route,
                actor.userId,
                actor.accountId,
              );
              requests++;
              if (result.status !== 200)
                errors[String(result.status)] =
                  (errors[String(result.status)] ?? 0) + 1;
              else {
                latencies[route].push(performance.now() - at);
                const rows = result.body.data[route];
                missingPrices += rows.filter(
                  (r: any) =>
                    r.referencePrice === null || r.markState !== 'fresh',
                ).length;
              }
            } catch {
              errors.transport = (errors.transport ?? 0) + 1;
            }
          }
        }),
      );
      clearInterval(monitor);
      clearInterval(dbMonitor);
      const elapsedSeconds = (performance.now() - start) / 1000;
      const cpu = process.cpuUsage(cpuBefore),
        pg = cpuTicks(),
        after = await stats();
      const queryDeltas = after
        .map((r) => ({
          query: r.query,
          calls: Number(
            r.calls -
              (before.find((b) => b.queryid === r.queryid)?.calls ?? 0n),
          ),
          executionMs:
            r.total_exec_time -
            (before.find((b) => b.queryid === r.queryid)?.total_exec_time ?? 0),
        }))
        .filter((r) => r.calls > 0 && !r.query.includes('pg_stat_statements'));
      stages.push({
        concurrency,
        elapsedSeconds,
        requests,
        requestsPerSecond: requests / elapsedSeconds,
        latencyMs: Object.fromEntries(
          Object.entries(latencies).map(([k, v]) => [k, summary(v)]),
        ),
        errors,
        missingPrices,
        sqlQueries: queryDeltas.reduce((n, r) => n + r.calls, 0),
        queryDeltas,
        nodeCpuCorePercent: (cpu.user + cpu.system) / (elapsedSeconds * 10000),
        postgresBackendCpuCorePercent:
          (pg.ticks - pgBefore.ticks) / elapsedSeconds, // Linux USER_HZ=100
        postgresBackendRssMiB: pg.rssMiB,
        peakNodeRssMiB: peakNodeRss / 1048576,
        peakConnections,
      });
    }
    writeFileSync(
      process.env.BENCH_REPORT!,
      JSON.stringify(
        {
          measurement:
            'actual loopback HTTP, real services/PG, fixture auth, independent owners with two cross positions; maximum-throughput closed-loop, not user arrival rate',
          accounts: actors.length,
          settings,
          instruments: 23,
          single,
          stages,
          feedErrors,
          feedWrites,
        },
        null,
        2,
      ),
    );
    assert.equal(feedErrors, 0);
    assert.ok(stages.every((s: any) => Object.keys(s.errors).length === 0));
  } finally {
    clearInterval(interval);
    while (feedBusy) await delay(20);
    await http.close();
  }
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeHttp?.();
    await db.$disconnect();
  });
