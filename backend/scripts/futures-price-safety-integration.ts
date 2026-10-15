/** Actual PostgreSQL release-readiness and retention fences. Disposable DB only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { HttpException } from '@nestjs/common';
import { Prisma } from '../src/generated/prisma/client';
import {
  db,
  app,
  fixture,
  now,
  price,
  openBody,
  fxEvidence,
} from './futures-integration';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import {
  FuturesLastPriceRetentionService,
  futuresLastPriceRetentionBatchSql,
} from '../src/futures/futures-last-price-retention.service';
import {
  FuturesMarkRetentionService,
  futuresMarkRetentionBatchSql,
} from '../src/futures/futures-mark-retention.service';
import { databaseFailureKind } from '../src/common/database-failure';
import { ConditionalService } from '../src/conditional/conditional.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { OrdersService } from '../src/orders/orders.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { readFuturesReferencePrices } from '../src/futures/futures-reference-prices';
import { readFuturesLastPrice } from '../src/futures/futures-last-price';
import { readFuturesMark } from '../src/futures/futures-mark';

const url = new URL(process.env.DATABASE_URL!);
assert.ok(
  ['localhost', '127.0.0.1'].includes(url.hostname) &&
    url.pathname.endsWith('_test'),
);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.FUTURES_PRICE_SAFETY_DB_INTEGRATION, '1');
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.FUTURES_RISK_ENGINE_ENABLED = 'true';
process.env.FUTURES_MARK_INGESTION_ENABLED = 'true';
process.env.FUTURES_LAST_PRICE_INGESTION_ENABLED = 'true';
process.env.FUTURES_LAST_PRICE_RETENTION_ENABLED = 'true';
process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
const locks = new OpsJobLockService(db),
  runs = new OpsJobRunService(db);
const retention = () => new FuturesLastPriceRetentionService(db, locks, runs);
const checks: string[] = [];
const pass = (label: string) => {
  checks.push(label);
  console.log('PASS ' + label);
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
};
/** The production batch statement must be ONE ordered range scan of
 * (captured_at, id) that stops at its LIMIT, and the DELETE must reach its
 * rows by primary key: no Sort, no Hash join and no sequential or bitmap scan
 * of the snapshot table, however large the backlog. */
type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
};
function assertOrderedRetentionPlan(explain: unknown, table: string) {
  const nodes: PlanNode[] = [];
  const walk = (node: PlanNode) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) walk(child);
  };
  const root = (
    explain as Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>
  )[0]['QUERY PLAN'][0].Plan;
  walk(root);
  const shape = nodes
    .map((n) => `${n['Node Type']}:${n['Relation Name'] ?? ''}`)
    .join(' > ');
  const indexes = (node: PlanNode): string[] => [
    ...(node['Index Name'] ? [node['Index Name']] : []),
    ...(node.Plans ?? []).flatMap(indexes),
  ];
  // A bitmap over the primary key (id = ANY of a bounded array) is a keyed
  // read; a bitmap over any other index reads candidates out of order.
  const byPrimaryKey = (n: PlanNode) =>
    n['Relation Name'] === table &&
    ((n['Node Type'] === 'Index Scan' && n['Index Name'] === `${table}_pkey`) ||
      (n['Node Type'] === 'Bitmap Heap Scan' &&
        indexes(n).every((name) => name === `${table}_pkey`)));
  assert.equal(
    nodes.some(
      (n) =>
        n['Relation Name'] === table &&
        (n['Node Type'] === 'Seq Scan' ||
          (n['Node Type'] === 'Bitmap Heap Scan' && !byPrimaryKey(n))),
    ),
    false,
    shape,
  );
  assert.equal(
    nodes.some(
      (n) => n['Node Type'] === 'Sort' || n['Node Type'] === 'Hash Join',
    ),
    false,
    shape,
  );
  assert.equal(
    nodes.some((n) => n['Index Name'] === `${table}_captured_at_id_idx`),
    true,
    shape,
  );
  // The DELETE target itself is reached only through the primary key.
  assert.equal(root['Node Type'], 'ModifyTable', shape);
  assert.equal(
    (root.Plans ?? []).some((n) => byPrimaryKey(n)),
    true,
    shape,
  );
  // The newest-row-per-pair probe must use the (instrument, source, time)
  // unique index; any other index can walk a whole instrument's history.
  const probes = nodes.filter((n) => {
    const index = n['Index Name'];
    return (
      n['Relation Name'] === table &&
      index !== undefined &&
      ![`${table}_captured_at_id_idx`, `${table}_pkey`].includes(index)
    );
  });
  assert.equal(probes.length > 0, true, shape);
  assert.equal(
    probes.every((n) => n['Index Name']?.endsWith('_key') === true),
    true,
    shape,
  );
  return shape;
}
/** Plan choice must not depend on cost settings: PostgreSQL defaults (the CI
 * container) and the production pg_settings (2026-10-16 audit evidence), at
 * the default and at the largest configurable batch. */
const COST_PROFILES: Record<string, string[]> = {
  postgresDefaults: [
    'random_page_cost = 4',
    "effective_cache_size = '4GB'",
    "work_mem = '4MB'",
  ],
  production: [
    'random_page_cost = 1.1',
    "effective_cache_size = '768MB'",
    "work_mem = '6617kB'",
  ],
};
async function assertStableRetentionPlans(
  build: (cutoff: Date, limit: number) => Prisma.Sql,
  cutoff: Date,
  table: string,
) {
  for (const [profile, settings] of Object.entries(COST_PROFILES))
    for (const limit of [1000, 10000]) {
      const explain = await db.$transaction(async (tx) => {
        for (const setting of settings)
          await tx.$executeRawUnsafe(`SET LOCAL ${setting}`);
        return tx.$queryRaw(
          Prisma.sql`EXPLAIN (FORMAT JSON) ${build(cutoff, limit)}`,
        );
      });
      try {
        assertOrderedRetentionPlan(explain, table);
      } catch (error) {
        throw new Error(
          `${table} plan (${profile}, batch ${limit}): ${(error as Error).message}`,
        );
      }
    }
}
async function main() {
  // Actual CLI: fresh fixture evidence + inactive empty companion instrument.
  const s = await fixture('general');
  const i = s.instruments[0];
  await db.futuresInstrument.update({
    where: { id: s.instruments[1].instrument.id },
    data: { isActive: false },
  });
  const fresh = async () => {
    await price(s, '100', 0, 10);
    const at = await now();
    await db.futuresMarkSnapshot.createMany({
      data: [
        {
          instrumentId: i.instrument.id,
          symbol: i.asset.symbol,
          price: '100',
          source: 'binance_usdm_mark_ws',
          effectiveAt: new Date(+at - 10),
          capturedAt: at,
        },
      ],
      skipDuplicates: true,
    });
  };
  const readiness = (flags: Record<string, string> = {}) => {
    const result = spawnSync(
      'pnpm',
      ['exec', 'tsx', 'scripts/futures-price-readiness.ts', '--require-ready'],
      {
        cwd: process.cwd(),
        env: { ...process.env, FUTURES_TRADING_MODE: 'DISABLED', ...flags },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    assert.equal(result.error === undefined, true);
    assert.ok(result.stdout.startsWith('{'), result.stderr.slice(0, 500));
    return { status: result.status, report: JSON.parse(result.stdout) };
  };
  await fresh();
  assert.equal(readiness().status, 0);
  pass(
    'read-only CLI passes fresh complete DISABLED launch targets without idle Ops runs',
  );
  await db.futuresInstrument.update({
    where: { id: i.instrument.id },
    data: { markVerifiedAt: new Date(+(await now()) - 86400001) },
  });
  assert.equal(readiness().status, 1);
  await db.futuresInstrument.update({
    where: { id: i.instrument.id },
    data: { markVerifiedAt: await now() },
  });
  await fresh();
  assert.equal(
    readiness({ FUTURES_LAST_PRICE_INGESTION_ENABLED: 'false' }).status,
    1,
  );
  assert.equal(
    readiness({ FUTURES_MARK_INGESTION_ENABLED: 'false' }).status,
    1,
  );
  assert.equal(readiness({ FUTURES_RISK_ENGINE_ENABLED: 'false' }).status, 1);
  pass('CLI rejects expired coverage and disabled required collectors/risk');
  await db.futuresLastPriceSnapshot.deleteMany({
    where: { instrumentId: i.instrument.id },
  });
  await db.futuresMarkSnapshot.deleteMany({
    where: { instrumentId: i.instrument.id },
  });
  assert.equal(readiness().status, 1);
  pass('CLI rejects registered instrument missing prices');

  const withAsset = { ...i.instrument, underlyingAsset: i.asset };
  const parity = async () => {
    const at = await now();
    const batched = (await readFuturesReferencePrices(db, [withAsset], at)).get(
      i.instrument.id,
    )!;
    assert.equal(
      batched.last?.id ?? null,
      (await readFuturesLastPrice(db, withAsset, at, false))?.id ?? null,
    );
    assert.equal(
      batched.mark?.id ?? null,
      (await readFuturesMark(db, withAsset, at, false))?.id ?? null,
    );
  };
  await parity();
  await fresh();
  await parity();
  await db.futuresLastPriceSnapshot.deleteMany({
    where: { instrumentId: i.instrument.id },
  });
  const selectionAt = await now();
  await db.futuresLastPriceSnapshot.createMany({
    data: [
      {
        instrumentId: i.instrument.id,
        symbol: i.asset.symbol,
        price: '99',
        source: 'binance_usdm_agg_trade_ws',
        effectiveAt: new Date(+selectionAt - 11000),
        capturedAt: new Date(+selectionAt - 11000),
      },
      {
        instrumentId: i.instrument.id,
        symbol: i.asset.symbol,
        price: '98',
        source: 'binance_usdm_ticker_price_rest',
        effectiveAt: new Date(+selectionAt - 20000),
        capturedAt: selectionAt,
      },
      {
        instrumentId: i.instrument.id,
        symbol: i.asset.symbol,
        price: '999',
        source: 'binance_usdm_agg_trade_ws',
        effectiveAt: new Date(+selectionAt + 60000),
        capturedAt: new Date(+selectionAt + 60000),
      },
    ],
  });
  await parity();
  assert.equal(
    (await readFuturesReferencePrices(db, [withAsset], await now())).get(
      i.instrument.id,
    )?.last === null,
    true,
  );
  await db.futuresLastPriceSnapshot.deleteMany({
    where: { instrumentId: i.instrument.id },
  });
  pass(
    'actual batched SQL matches individual Last/Mark readers for missing, fresh, future and stale newest trades; no older-trade resurrection',
  );

  // Real fills and real conditional trigger produce durable evidence references.
  await fresh();
  await fxEvidence();
  const opened = await app.futures.execute(s.userId, s.accountId, openBody(s));
  const execution = await db.futuresExecution.findUniqueOrThrow({
    where: { id: opened.data.execution.id },
  });
  const conditional = new ConditionalService(
    db,
    new TradingAccountAccessService(db),
    {} as OrdersService,
    new LimitOrderCancelService(db, new OrderReservationService()),
    app.futures,
  );
  const group = (
    (await conditional.create(s.userId, s.accountId, {
      domain: 'futures',
      assetId: i.asset.id,
      positionId: opened.data.position.id,
      idempotencyKey: randomUUID(),
      legs: [
        {
          kind: 'take_profit',
          triggerPrice: '101',
          childOrderType: 'limit',
          childLimitPrice: '105',
        },
      ],
    })) as { data: { groupId: string } }
  ).data;
  await price(s, '102', 0, 5);
  await assert.rejects(
    conditional.evaluate(group.groupId),
    (error: unknown) =>
      error instanceof HttpException &&
      (error.getResponse() as { error: { code: string } }).error.code ===
        'CONDITIONAL_LIMIT_NOT_REACHED',
  );
  const child = await db.protectionChild.findFirstOrThrow({
    where: { groupId: group.groupId },
  });
  const protectionCheck = readiness({ CONDITIONAL_ORDERS_ENABLED: 'false' });
  assert.equal(protectionCheck.status, 1);
  assert.equal(
    protectionCheck.report.blockers.some(
      (b: { component: string }) => b.component === 'conditional_orders_config',
    ),
    true,
  );
  const preview = await runs.createRunning({
    jobName: 'futures_liquidation',
    trigger: 'manual_script',
    dryRun: true,
    startedAt: await now(),
  });
  await runs.recordSucceeded(preview, { finishedAt: await now() });
  const previewWorker = readiness().report.workers.find(
    (w: { jobName: string }) => w.jobName === 'futures_liquidation',
  );
  assert.equal(previewWorker.ready, false);
  assert.equal(previewWorker.reason, 'WORKER_DRY_RUN_OR_EXECUTION_UNCONFIRMED');
  pass(
    'actual CLI rejects disabled live protection config and successful preview-only worker observations',
  );
  assert.equal(child.futuresLastPriceSnapshotId !== null, true);
  const cutoff = new Date(+(await now()) + 86400000);
  const old = new Date(+(await now()) - 3 * 86400000);
  const snapshot = (
    at: Date,
    source:
      | 'binance_usdm_agg_trade_ws'
      | 'binance_usdm_ticker_price_rest' = 'binance_usdm_agg_trade_ws',
  ) =>
    db.futuresLastPriceSnapshot.create({
      data: {
        instrumentId: i.instrument.id,
        symbol: i.asset.symbol,
        price: '100',
        source,
        effectiveAt: at,
        capturedAt: at,
      },
    });
  const endedAt = new Date(+old + 60000);
  const season = await db.season.create({
    data: {
      name: 'Retention ' + randomUUID(),
      status: 'ended',
      startAt: new Date(+old - 86400000),
      endAt: endedAt,
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  const before = await snapshot(new Date(+endedAt - 10001));
  const candidateStart = await snapshot(new Date(+endedAt - 10000));
  const candidate = await snapshot(new Date(+endedAt - 1));
  const atEnd = await snapshot(endedAt);
  const after = await snapshot(new Date(+endedAt + 1));
  const pin = await db.futuresSeasonPrice.create({
    data: {
      seasonId: season.id,
      instrumentId: i.instrument.id,
      lastPriceSnapshotId: candidate.id,
      endAt: endedAt,
      feeRate: '0.001',
    },
  });
  // A second ended season remains unpinned; its full inclusive window survives.
  const unpinnedEnd = new Date(+endedAt + 60000);
  await db.season.create({
    data: {
      name: 'Unpinned ' + randomUUID(),
      status: 'ended',
      startAt: old,
      endAt: unpinnedEnd,
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  const unpinned = await snapshot(new Date(+unpinnedEnd - 10000));
  const latestStoredWs = await db.futuresLastPriceSnapshot.findFirstOrThrow({
    where: {
      instrumentId: i.instrument.id,
      source: 'binance_usdm_agg_trade_ws',
    },
    orderBy: { capturedAt: 'desc' },
    select: { capturedAt: true },
  });
  // Establish an actually newest observation. A wall-clock regression between
  // fixture inserts must not turn the "newest" fixture into an older row.
  const newestWs = await snapshot(new Date(+latestStoredWs.capturedAt + 1));
  const oldestRest = await snapshot(old, 'binance_usdm_ticker_price_rest');
  const newestRest = await snapshot(
    new Date(+old + 1),
    'binance_usdm_ticker_price_rest',
  );
  const evidenceBefore = JSON.stringify({ execution, child, pin });
  const worker = retention();
  assert.ok((await worker.deleteBatch(cutoff, 1000)) > 0);
  const exists = async (id: string) =>
    (await db.futuresLastPriceSnapshot.count({ where: { id } })) === 1;
  for (const id of [
    execution.lastPriceSnapshotId!,
    child.futuresLastPriceSnapshotId!,
    pin.lastPriceSnapshotId!,
    candidateStart.id,
    atEnd.id,
    unpinned.id,
    newestWs.id,
    newestRest.id,
  ])
    assert.equal(await exists(id), true);
  for (const id of [before.id, after.id, oldestRest.id])
    assert.equal(await exists(id), false);
  assert.equal(await worker.deleteBatch(cutoff, 1000), 0);
  assert.equal(
    JSON.stringify({
      execution: await db.futuresExecution.findUnique({
        where: { id: execution.id },
      }),
      child: await db.protectionChild.findUnique({ where: { id: child.id } }),
      pin: await db.futuresSeasonPrice.findUnique({ where: { id: pin.id } }),
    }),
    evidenceBefore,
  );
  pass(
    'real execution, TP/SL, season pin, inclusive unpinned windows, latest per source preserved; repeat no-op; records immutable',
  );

  // Insert wins: FK KEY SHARE plus a pending reference prevents deletion.
  const referenced = await snapshot(new Date(+old - 1000));
  const { id: _id, ...base } = execution;
  const arrived = deferred(),
    release = deferred();
  const pending = db.$transaction(
    async (tx) => {
      await tx.futuresExecution.create({
        data: {
          ...base,
          id: randomUUID(),
          lastPriceSnapshotId: referenced.id,
          priceEffectiveAt: referenced.effectiveAt,
          priceCapturedAt: referenced.capturedAt,
        },
      });
      arrived.resolve();
      await release.promise;
    },
    { timeout: 10000 },
  );
  await arrived.promise;
  try {
    assert.equal(await worker.deleteBatch(cutoff, 100), 0);
  } finally {
    release.resolve();
    await pending;
  }
  assert.equal(await exists(referenced.id), true);
  // Delete wins: a later reference is rejected, never committed dangling.
  const deleted = await snapshot(new Date(+old - 2000));
  assert.equal(await worker.deleteBatch(cutoff, 100), 1);
  await assert.rejects(
    db.futuresExecution.create({
      data: {
        ...base,
        id: randomUUID(),
        lastPriceSnapshotId: deleted.id,
        priceEffectiveAt: deleted.effectiveAt,
        priceCapturedAt: deleted.capturedAt,
      },
    }),
  );
  pass('both financial reference/delete race orderings preserve FK integrity');

  // Large fixture uses actual DB identity/immutability guards; no disabled triggers.
  const prefix = randomUUID();
  const bulk = Number(process.env.RETENTION_TEST_ROWS ?? 100000);
  await db.$executeRaw`INSERT INTO futures_last_price_snapshots(id,instrument_id,symbol,source,price,effective_at,captured_at)
    SELECT ${prefix} || n::text, ${i.instrument.id}, ${i.asset.symbol}, 'binance_usdm_agg_trade_ws'::"FuturesLastPriceSource", 100,
      ${new Date(+old - 86400000)}::timestamp + n * interval '1 millisecond', ${new Date(+old - 86400000)}::timestamp + n * interval '1 millisecond'
    FROM generate_series(1, ${bulk}::integer) n`;
  await db.$executeRaw`ANALYZE futures_last_price_snapshots`;
  await assertStableRetentionPlans(
    futuresLastPriceRetentionBatchSql,
    cutoff,
    'futures_last_price_snapshots',
  );
  const explain = await db.$transaction(async (tx) =>
    // EXPLAIN ANALYZE really deletes its batch; it is part of the measured total.
    tx.$queryRaw(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${futuresLastPriceRetentionBatchSql(cutoff, 1000)}`,
    ),
  );
  const lastPlan = assertOrderedRetentionPlan(
    explain,
    'futures_last_price_snapshots',
  );
  const start = performance.now();
  const concurrent = await Promise.all([
    worker.deleteBatch(cutoff, 1000),
    retention().deleteBatch(cutoff, 1000),
  ]);
  assert.deepEqual(concurrent, [1000, 1000]);
  let removed = 3000;
  while (true) {
    const n = await worker.deleteBatch(cutoff, 1000);
    removed += n;
    if (n < 1000) break;
  }
  assert.equal(removed, bulk);
  const elapsedMs = performance.now() - start;
  pass(
    'Last retention at a 100k backlog: one ordered (captured_at, id) range plan and a primary-key DELETE under default and production cost settings; concurrent SKIP LOCKED batches delete each old observation exactly once',
  );

  // Futures Mark retention: the same plan guarantee at scale, newest row per
  // source kept even when older than the cutoff, failure evidence and resume.
  const markRetention = () => new FuturesMarkRetentionService(db, locks, runs);
  const markOld = new Date(+(await now()) - 3 * 86400000);
  const markCutoff = new Date(+(await now()) - 86400000);
  const markRow = (
    at: Date,
    source: 'binance_usdm_mark_ws' | 'binance_usdm_mark_rest',
  ) =>
    db.futuresMarkSnapshot.create({
      data: {
        instrumentId: i.instrument.id,
        symbol: i.asset.symbol,
        price: '100',
        source,
        effectiveAt: at,
        capturedAt: at,
      },
    });
  const olderMarkRest = await markRow(
    new Date(+markOld - 1000),
    'binance_usdm_mark_rest',
  );
  const newestMarkRest = await markRow(markOld, 'binance_usdm_mark_rest');
  const newestMarkWs = await markRow(await now(), 'binance_usdm_mark_ws');
  const markPrefix = randomUUID();
  await db.$executeRaw`INSERT INTO futures_mark_snapshots(id,instrument_id,symbol,source,price,effective_at,captured_at)
    SELECT ${markPrefix} || n::text, ${i.instrument.id}, ${i.asset.symbol}, 'binance_usdm_mark_ws'::"FuturesMarkSource", 100,
      ${new Date(+markOld - 86400000)}::timestamp + n * interval '1 millisecond', ${new Date(+markOld - 86400000)}::timestamp + n * interval '1 millisecond'
    FROM generate_series(1, ${bulk}::integer) n`;
  await db.$executeRaw`ANALYZE futures_mark_snapshots`;
  await assertStableRetentionPlans(
    futuresMarkRetentionBatchSql,
    markCutoff,
    'futures_mark_snapshots',
  );
  const markExplain = await db.$transaction(async (tx) =>
    tx.$queryRaw(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${futuresMarkRetentionBatchSql(markCutoff, 1000)}`,
    ),
  );
  const markPlan = assertOrderedRetentionPlan(
    markExplain,
    'futures_mark_snapshots',
  );
  const markStart = performance.now();
  // Ingestion keeps inserting while two workers delete: fresh rows are never
  // candidates, and each old row is still deleted exactly once.
  const freshAt = await now();
  const freshIds = Array.from({ length: 200 }, () => randomUUID());
  const [firstBatch, secondBatch, freshInsert] = await Promise.all([
    markRetention().deleteBatch(markCutoff, 1000),
    markRetention().deleteBatch(markCutoff, 1000),
    db.futuresMarkSnapshot.createMany({
      data: freshIds.map((id, k) => ({
        id,
        instrumentId: i.instrument.id,
        symbol: i.asset.symbol,
        price: '100',
        source: 'binance_usdm_mark_ws' as const,
        effectiveAt: new Date(+freshAt - 1 - k),
        capturedAt: freshAt,
      })),
      skipDuplicates: true,
    }),
  ]);
  assert.deepEqual([firstBatch, secondBatch], [1000, 1000]);
  assert.equal(freshInsert.count > 0, true);
  let markRemoved = 3000;
  while (true) {
    const n = await markRetention().deleteBatch(markCutoff, 1000);
    markRemoved += n;
    if (n < 1000) break;
  }
  const markElapsedMs = performance.now() - markStart;
  assert.equal(markRemoved, bulk + 1);
  const markExists = async (id: string) =>
    (await db.futuresMarkSnapshot.count({ where: { id } })) === 1;
  assert.equal(await markExists(olderMarkRest.id), false);
  assert.equal(await markExists(newestMarkRest.id), true);
  assert.equal(await markExists(newestMarkWs.id), true);
  assert.equal(
    await db.futuresMarkSnapshot.count({ where: { id: { in: freshIds } } }),
    freshInsert.count,
  );
  assert.equal(await markRetention().deleteBatch(markCutoff, 1000), 0);
  pass(
    'Mark retention at a 100k backlog: one ordered (captured_at, id) range plan and a primary-key DELETE under default and production cost settings; concurrent SKIP LOCKED batches delete each row exactly once while ingestion inserts; the newest row per source survives even when older than the cutoff',
  );

  // A real statement timeout is classified from the actual driver error, and a
  // failed run records committed progress plus that category, then resumes.
  const realTimeout = await db
    .$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL statement_timeout = '20ms'`;
      await tx.$queryRaw`SELECT pg_sleep(1)`;
    })
    .then(
      () => null,
      (reason: unknown) => reason,
    );
  assert.equal(databaseFailureKind(realTimeout), 'statement_timeout');
  process.env.FUTURES_MARK_RETENTION_ENABLED = 'true';
  // One row per batch, so the run continues into the failing second batch.
  process.env.FUTURES_MARK_RETENTION_BATCH_SIZE = '1';
  for (let k = 1; k <= 3; k++)
    await markRow(new Date(+markOld - 10000 - k), 'binance_usdm_mark_ws');
  const failing = markRetention();
  const realMark = markRetention();
  let markCalls = 0;
  failing.deleteBatch = async (c, n) => {
    if (++markCalls === 2) throw realTimeout;
    return await realMark.deleteBatch(c, n);
  };
  await assert.rejects(failing.run());
  const failedMark = await db.opsJobRun.findFirstOrThrow({
    where: { jobName: 'futures_mark_retention', status: 'failed' },
    orderBy: { startedAt: 'desc' },
  });
  assert.equal(failedMark.errorCode, 'FUTURES_MARK_RETENTION_FAILED');
  const failedResult = failedMark.resultJson as Record<string, unknown>;
  assert.equal(failedResult.failureKind, 'statement_timeout');
  assert.equal(failedResult.deletedCount, 1);
  assert.equal(failedResult.batchCount, 1);
  assert.equal(failing.getStatus().lastFailureKind, 'statement_timeout');
  assert.equal((await markRetention().run())?.deletedCount, 2);
  delete process.env.FUTURES_MARK_RETENTION_BATCH_SIZE;
  assert.equal(await markExists(newestMarkRest.id), true);
  pass(
    'a real statement timeout is classified; a failed Mark run records committed progress and category, then the next run resumes',
  );

  // Real multi-instance Ops lock, interruption after a committed batch, then resume.
  await snapshot(new Date(+old - 3000));
  const first = retention(),
    second = retention(),
    entered = deferred(),
    resume = deferred();
  const original = first.deleteBatch.bind(first);
  first.deleteBatch = async (c, n) => {
    entered.resolve();
    await resume.promise;
    return original(c, n);
  };
  const run = first.run();
  await entered.promise;
  try {
    assert.equal((await second.run()) === undefined, true);
  } finally {
    resume.resolve();
    await run;
  }
  pass('multi-instance scheduler holds one actual Ops lease');
  await snapshot(new Date(+old - 4000));
  const interrupted = retention();
  interrupted.deleteBatch = async (c, n) => {
    await original(c, n);
    throw new Error('Injected interruption after committed batch');
  };
  await assert.rejects(interrupted.run(), /Injected interruption/);
  const failed = await db.opsJobRun.findFirstOrThrow({
    where: { jobName: 'futures_last_price_retention', status: 'failed' },
    orderBy: { startedAt: 'desc' },
  });
  assert.equal(failed.errorCode, 'FUTURES_LAST_PRICE_RETENTION_FAILED');
  assert.equal((await retention().run())?.deletedCount, 0);
  const lease = await locks.acquireLock({
    jobName: 'futures_last_price_retention',
    lockKey: 'futures_last_price_retention:current',
    ttlSeconds: 30,
  });
  assert.equal(lease.acquired, true);
  if (lease.acquired) {
    await db.opsJobLock.update({
      where: { lockKey: lease.lockKey },
      data: { expiresAt: new Date(+(await now()) - 1) },
    });
    const takeover = await locks.acquireLock({
      jobName: 'futures_last_price_retention',
      lockKey: lease.lockKey,
      ttlSeconds: 30,
    });
    assert.equal(takeover.acquired, true);
    assert.equal(
      await locks.extendLock({
        lockKey: lease.lockKey,
        ownerId: lease.ownerId,
        ttlSeconds: 30,
      }),
      false,
    );
    if (takeover.acquired)
      await locks.releaseLock({
        lockKey: takeover.lockKey,
        ownerId: takeover.ownerId,
      });
  }
  for (const id of [
    execution.lastPriceSnapshotId!,
    child.futuresLastPriceSnapshotId!,
    candidate.id,
    unpinned.id,
    newestWs.id,
    newestRest.id,
    referenced.id,
  ])
    assert.equal(await exists(id), true);
  pass(
    'failed job recorded, committed progress resumes safely, expired lease takeover fences old owner',
  );
  // A current live feed cannot substitute for an ended season's boundary.
  const final = await fixture('season');
  const finalNow = await now();
  await db.futuresMarkSnapshot.create({
    data: {
      instrumentId: final.instruments[0].instrument.id,
      symbol: final.instruments[0].asset.symbol,
      price: '100',
      source: 'binance_usdm_mark_ws',
      effectiveAt: finalNow,
      capturedAt: finalNow,
    },
  });
  await fxEvidence();
  await app.futures.execute(final.userId, final.accountId, openBody(final));
  const finalEnd = new Date(+(await now()) - 60000);
  await db.season.update({
    where: { id: final.season!.id },
    data: { endAt: finalEnd },
  });
  const finalState = () =>
    readiness().report.settlements.find(
      (item: { seasonId: string }) => item.seasonId === final.season!.id,
    ) as { ready: boolean; evidence: string };
  assert.equal(finalState().ready, false);
  assert.equal(
    (await db.season.findUniqueOrThrow({ where: { id: final.season!.id } }))
      .status,
    'active',
  );
  pass(
    'actual CLI detects missing boundary evidence before the ended status update',
  );
  await db.season.update({
    where: { id: final.season!.id },
    data: { status: 'ended' },
  });
  assert.equal(finalState().ready, false);
  const finalSnapshot = await db.futuresLastPriceSnapshot.create({
    data: {
      instrumentId: final.instruments[0].instrument.id,
      symbol: final.instruments[0].asset.symbol,
      price: '100',
      source: 'binance_usdm_agg_trade_ws',
      effectiveAt: finalEnd,
      capturedAt: finalEnd,
    },
  });
  assert.equal(finalState().evidence, 'unfixed_last_candidate');
  await db.futuresSeasonPrice.create({
    data: {
      seasonId: final.season!.id,
      instrumentId: final.instruments[0].instrument.id,
      lastPriceSnapshotId: finalSnapshot.id,
      endAt: finalEnd,
      feeRate: final.season!.tradeFeeRate,
    },
  });
  assert.equal(finalState().evidence, 'pinned_last');
  pass(
    'actual CLI distinguishes missing historical settlement evidence, an unfixed boundary candidate and immutable Last pin',
  );
  if (process.env.SAFETY_REPORT)
    writeFileSync(
      process.env.SAFETY_REPORT,
      JSON.stringify(
        {
          checks,
          count: checks.length,
          retention: {
            rows: bulk,
            deleted: removed,
            measuredDeleteMs: elapsedMs,
            rowsPerSecond: (bulk - 1000) / (elapsedMs / 1000),
            plan: lastPlan,
            explain,
          },
          markRetention: {
            rows: bulk + 1,
            deleted: markRemoved,
            measuredDeleteMs: markElapsedMs,
            rowsPerSecond: (bulk + 1 - 1000) / (markElapsedMs / 1000),
            plan: markPlan,
            explain: markExplain,
          },
        },
        null,
        2,
      ),
    );
  console.log(`Futures price safety PostgreSQL PASS (${checks.length} groups)`);
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
