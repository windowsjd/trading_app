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
import { FuturesLastPriceRetentionService } from '../src/futures/futures-last-price-retention.service';
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
  const explain = await db.$transaction(async (tx) => {
    const plan = await tx.$queryRaw`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      WITH candidates AS (SELECT m.id FROM futures_last_price_snapshots m
        WHERE m.captured_at < ${cutoff} AND m.effective_at < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM futures_executions e WHERE e.last_price_snapshot_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM futures_season_prices p WHERE p.last_price_snapshot_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM protection_children c WHERE c.futures_last_price_snapshot_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM seasons s WHERE m.captured_at BETWEEN s.end_at - interval '10 seconds' AND s.end_at)
        AND EXISTS (SELECT 1 FROM futures_last_price_snapshots newer WHERE newer.instrument_id = m.instrument_id AND newer.source = m.source AND newer.captured_at > m.captured_at)
        ORDER BY m.captured_at, m.id LIMIT 1000 FOR UPDATE OF m SKIP LOCKED)
      DELETE FROM futures_last_price_snapshots m USING candidates c WHERE m.id = c.id`;
    // EXPLAIN ANALYZE really deletes its batch; it is part of the measured total.
    return plan;
  });
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
    'concurrent SKIP LOCKED batches delete each old observation exactly once at scale',
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
            explain,
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
