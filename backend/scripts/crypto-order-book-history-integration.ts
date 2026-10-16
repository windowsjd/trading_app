/**
 * PostgreSQL integration of the crypto order-book history
 * (docs/crypto-order-book-history-contract.md) on a disposable local *_test
 * database at the current migration:
 *
 *  1. Two writers (two servers) and a restarted third one store exactly one
 *     row per product and minute for 100 Spot + 100 USDⓈ-M products; the
 *     same symbol on both markets is two rows keyed by asset vs instrument.
 *  2. Exact provider decimal strings and receipt/DB times round-trip; the
 *     CHECK constraints refuse a mis-bucketed, empty or oversized book.
 *  3. The 60 s rule on real rows; a locked table (statement timeout) is
 *     isolated from the offers, retried after backoff and then written.
 *  4. Retention deletes every row whose minute is older than 336 hours and
 *     nothing newer, in capped batches under one Ops lease; a held table lock
 *     fails a run (ops_job_runs) and the next run recovers; KOSCOM books and
 *     price snapshots are untouched.
 *  5. The batch reads the primary key in order and deletes by row address
 *     under PostgreSQL default and production cost settings.
 *
 *   CRYPTO_ORDER_BOOK_HISTORY_DB_INTEGRATION=1 DATABASE_URL=<local *_test> \
 *   pnpm tsx scripts/crypto-order-book-history-integration.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { OpsJobLockService } from '../src/ops/ops-job-lock.service';
import { OpsJobRunService } from '../src/ops/ops-job-run.service';
import { databaseFailureKind } from '../src/common/database-failure';
import { CryptoOrderBookHistoryService } from '../src/providers/crypto-order-book-history.service';
import {
  CRYPTO_ORDER_BOOK_HISTORY_TABLES,
  CryptoOrderBookRetentionWorker,
  cryptoOrderBookDeleteBefore,
  cryptoOrderBookRetentionBatchSql,
} from '../src/providers/crypto-order-book-retention.worker';

const dbUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid');
assert.ok(
  ['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname) &&
    dbUrl.pathname.endsWith('_test'),
  'Use a disposable local *_test PostgreSQL database.',
);
process.env.CRYPTO_ORDER_BOOK_HISTORY_ENABLED = 'true';
process.env.CRYPTO_ORDER_BOOK_RETENTION_ENABLED = 'true';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const prisma = new PrismaService();
const tag = randomUUID().slice(0, 8).toUpperCase();
const SPOT = CRYPTO_ORDER_BOOK_HISTORY_TABLES.spot;
const FUTURES = CRYPTO_ORDER_BOOK_HISTORY_TABLES.futures;
const floorMinute = (ms: number) => ms - (ms % MINUTE);

type Level = { price: string; quantity: string };
function book(sequence: number) {
  const bids: Level[] = Array.from({ length: 10 }, (_, i) => ({
    price: `0.0000${381 - i}0`,
    quantity: '123456789.00000000',
  }));
  const asks: Level[] = Array.from({ length: 10 }, (_, i) => ({
    price: `0.0000${382 + i}0`,
    quantity: '0.00000001',
  }));
  return { sequence: String(sequence), bids, asks };
}
const levelsText = (levels: Level[]) =>
  JSON.stringify(levels.map((level) => [level.price, level.quantity]));

async function count(table: string, where = 'TRUE') {
  const [row] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*)::bigint AS n FROM "${table}" WHERE ${where}`,
  );
  return Number(row.n);
}

async function lockTable(table: string) {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);
  return async () => {
    await client.query('ROLLBACK');
    await client.end();
  };
}

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  Plans?: PlanNode[];
};
function assertBatchPlan(explain: unknown, table: string, label: string) {
  const nodes: PlanNode[] = [];
  const walk = (node: PlanNode) => {
    nodes.push(node);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(
    (explain as Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>)[0][
      'QUERY PLAN'
    ][0].Plan,
  );
  const shape = `${label}: ${nodes
    .map(
      (n) => `${n['Node Type']}:${n['Index Name'] ?? n['Relation Name'] ?? ''}`,
    )
    .join(' > ')}`;
  const readsTable = (node: PlanNode): boolean =>
    node['Relation Name'] === table || (node.Plans ?? []).some(readsTable);
  assert.equal(
    nodes.some(
      (n) =>
        n['Relation Name'] === table &&
        ['Seq Scan', 'Bitmap Heap Scan'].includes(n['Node Type']),
    ),
    false,
    shape,
  );
  assert.equal(
    nodes.some(
      (n) => ['Sort', 'Hash'].includes(n['Node Type']) && readsTable(n),
    ),
    false,
    shape,
  );
  assert.equal(
    nodes.some(
      (n) =>
        ['Index Scan', 'Index Only Scan'].includes(n['Node Type']) &&
        n['Index Name'] === `${table}_pkey`,
    ),
    true,
    shape,
  );
  const modify = nodes.find((n) => n['Node Type'] === 'ModifyTable');
  assert.equal(
    (modify?.Plans ?? []).some(
      (n) => n['Relation Name'] === table && n['Node Type'] === 'Tid Scan',
    ),
    true,
    shape,
  );
  return shape;
}
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

async function main() {
  await prisma.$connect();
  const started = new Date();
  // ------------------------------------------------------------ fixtures
  const crypto = {
    market: 'BINANCE',
    assetType: 'crypto' as const,
    currencyCode: 'USD' as const,
    priceCurrency: 'USD' as const,
    settlementCurrency: 'USD' as const,
  };
  const spotAssets = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      prisma.asset.create({
        data: { ...crypto, symbol: `OBH${tag}S${i}USDT`, name: `S${i}` },
      }),
    ),
  );
  const futuresOnly = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      prisma.asset.create({
        data: { ...crypto, symbol: `OBH${tag}F${i}USDT`, name: `F${i}` },
      }),
    ),
  );
  // 80 contracts on shared Spot underlyings (same symbol on both markets).
  const instruments = await Promise.all(
    [...spotAssets.slice(0, 80), ...futuresOnly].map((asset) =>
      prisma.futuresInstrument.create({
        data: { underlyingAssetId: asset.id },
      }),
    ),
  );
  const koscom = await prisma.asset.create({
    data: {
      symbol: `OBH${tag}KRX`,
      name: 'KOSCOM fixture',
      market: 'KRX',
      assetType: 'domestic_stock',
      currencyCode: 'KRW',
      priceCurrency: 'KRW',
      settlementCurrency: 'KRW',
    },
  });
  const old = new Date(Date.now() - 20 * 24 * HOUR);
  await prisma.assetOrderbookSnapshot.create({
    data: {
      assetId: koscom.id,
      sourceType: 'provider_api',
      sourceName: 'koscom_krx_orderbook',
      bidPrice: '70000',
      askPrice: '70100',
      currencyCode: 'KRW',
      effectiveAt: old,
      capturedAt: old,
    },
  });
  await prisma.assetPriceSnapshot.create({
    data: {
      assetId: spotAssets[0].id,
      price: '1',
      currencyCode: 'USD',
      sourceType: 'provider_api',
      sourceName: 'binance_spot_ws_ticker',
      effectiveAt: old,
      capturedAt: old,
    },
  });

  // ------------------------------------- 1. two servers and a restart
  const minute = floorMinute(Date.now()) - 30 * MINUTE;
  const writers = [0, 1].map(() => new CryptoOrderBookHistoryService(prisma));
  writers.forEach((writer, n) => {
    for (const [i, asset] of spotAssets.entries())
      writer.offerSpot(
        asset.id,
        book(1000 * n + i),
        new Date(minute + 58_000 + n * 100),
      );
    for (const [i, instrument] of instruments.entries())
      writer.offerFutures(
        instrument.id,
        {
          ...book(5000 + 1000 * n + i),
          effectiveAt: new Date(minute + 57_900 + n * 100).toISOString(),
        },
        new Date(minute + 58_000 + n * 100),
      );
  });
  await Promise.all(
    writers.map((writer) => {
      writer.tick(minute + MINUTE);
      return writer.settled();
    }),
  );
  const inMinute = `bucket_start_at = '${new Date(minute).toISOString()}'::timestamptz AT TIME ZONE 'UTC'`;
  assert.equal(await count(SPOT, inMinute), 100);
  assert.equal(await count(FUTURES, inMinute), 100);
  const counts = writers.map((writer) => writer.getStatus().counts);
  assert.equal(counts[0].inserted + counts[1].inserted, 200);
  assert.equal(counts[0].duplicates + counts[1].duplicates, 200);
  const restarted = new CryptoOrderBookHistoryService(prisma);
  for (const asset of spotAssets)
    restarted.offerSpot(asset.id, book(9), new Date(minute + 59_000));
  restarted.tick(minute + MINUTE);
  await restarted.settled();
  assert.deepEqual(
    {
      inserted: restarted.getStatus().counts.inserted,
      duplicates: restarted.getStatus().counts.duplicates,
    },
    { inserted: 0, duplicates: 100 },
  );
  assert.equal(await count(SPOT, inMinute), 100);
  // The shared underlying has one Spot row (asset) and one USDⓈ-M row
  // (instrument): two histories, never merged.
  const shared = spotAssets[7];
  const sharedInstrument = instruments[7];
  assert.equal(sharedInstrument.underlyingAssetId, shared.id);
  assert.equal(await count(SPOT, `asset_id = '${shared.id}'`), 1);
  assert.equal(
    await count(FUTURES, `instrument_id = '${sharedInstrument.id}'`),
    1,
  );

  // --------------------------- 2. exact strings, times and CHECKs
  const [stored] = await prisma.$queryRawUnsafe<
    Array<{
      bids: string;
      asks: string;
      sequence: string;
      bucket: Date;
      captured: Date;
      created: Date;
    }>
  >(
    `SELECT bids::text AS bids, asks::text AS asks, sequence::text AS sequence,
            bucket_start_at AS bucket, captured_at AS captured, created_at AS created
     FROM "${SPOT}" WHERE asset_id = $1`,
    shared.id,
  );
  assert.equal(stored.bids, levelsText(book(0).bids));
  assert.equal(stored.asks, levelsText(book(0).asks));
  assert.ok(['7', '1007'].includes(stored.sequence));
  assert.equal(stored.bucket.toISOString(), new Date(minute).toISOString());
  assert.ok(
    [minute + 58_000, minute + 58_100].includes(stored.captured.getTime()),
  );
  // Database write time is separate from (and after) the receipt time.
  assert.ok(stored.created.getTime() >= stored.captured.getTime());
  const [futuresRow] = await prisma.$queryRawUnsafe<
    Array<{ effective: Date; captured: Date }>
  >(
    `SELECT effective_at AS effective, captured_at AS captured FROM "${FUTURES}" WHERE instrument_id = $1`,
    sharedInstrument.id,
  );
  assert.equal(
    futuresRow.captured.getTime() - futuresRow.effective.getTime(),
    100,
  );
  for (const [label, bucket, bids] of [
    ['bucket mismatch', minute - MINUTE, '[["1","1"]]'],
    ['empty side', minute - 2 * MINUTE, '[]'],
    [
      'eleven levels',
      minute - 3 * MINUTE,
      JSON.stringify(Array.from({ length: 11 }, () => ['1', '1'])),
    ],
  ] as const) {
    const captured =
      label === 'bucket mismatch' ? bucket + MINUTE + 1 : bucket + 1;
    try {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${SPOT}" (bucket_start_at, asset_id, captured_at, sequence, bids, asks)
         VALUES ($1, $2, $3, 1, $4::json, '[["2","1"]]'::json)`,
        new Date(bucket),
        spotAssets[1].id,
        new Date(captured),
        bids,
      );
      assert.fail(`${label} was accepted`);
    } catch (error) {
      assert.equal(databaseFailureKind(error), 'data_rejected', label);
    }
  }

  // ------------------------------ 3. 60 s rule and a locked table
  const sampler = new CryptoOrderBookHistoryService(prisma);
  const base = floorMinute(Date.now()) - 20 * MINUTE;
  const asset = spotAssets[2].id;
  for (let s = 0; s < 150; s++) {
    // Minute 1 goes quiet 10 s before its end: nothing may be stored for it.
    if (s >= 110 && s < 120) continue;
    sampler.offerSpot(asset, book(100 + s), new Date(base + s * 1000));
    sampler.tick(base + s * 1000 + 500);
    await sampler.settled();
  }
  sampler.tick(base + 150_000);
  await sampler.settled();
  const sampled = await prisma.$queryRawUnsafe<
    Array<{ bucket: Date; sequence: string }>
  >(
    `SELECT bucket_start_at AS bucket, sequence::text AS sequence FROM "${SPOT}"
     WHERE asset_id = $1 AND bucket_start_at >= $2 ORDER BY bucket_start_at`,
    asset,
    new Date(base),
  );
  assert.deepEqual(
    sampled.map((row) => [row.bucket.getTime() - base, row.sequence]),
    [[0, '159']],
  );
  assert.equal(sampler.getStatus().counts.staleMinutes, 1);

  const release = await lockTable(SPOT);
  const isolated = new CryptoOrderBookHistoryService(prisma);
  const lockedMinute = floorMinute(Date.now()) - 15 * MINUTE;
  isolated.offerSpot(asset, book(7777), new Date(lockedMinute + 59_000));
  const blockedAt = Date.now();
  isolated.tick(lockedMinute + MINUTE);
  // Offers keep flowing while the write waits on the lock.
  for (let s = 0; s < 50; s++)
    isolated.offerSpot(
      asset,
      book(8000 + s),
      new Date(lockedMinute + MINUTE + s * 100),
    );
  await isolated.settled();
  assert.ok(
    Date.now() - blockedAt >= 4_500,
    'statement timeout bounds a write',
  );
  assert.equal(isolated.getStatus().consecutiveWriteFailures, 1);
  assert.equal(
    isolated.getStatus().lastWriteFailure?.kind,
    'statement_timeout',
  );
  assert.equal(isolated.getStatus().pendingRows, 1);
  await release();
  isolated.tick(Date.now() + 10_000); // after the backoff
  await isolated.settled();
  assert.equal(isolated.getStatus().consecutiveWriteFailures, 0);
  assert.equal(
    await count(
      SPOT,
      `asset_id = '${asset}' AND sequence = 7777 AND bucket_start_at = '${new Date(lockedMinute).toISOString()}'::timestamptz AT TIME ZONE 'UTC'`,
    ),
    1,
  );

  // ------------------------------------------------- 4. retention
  // 50 products per table, one row every 20 minutes for 15 days, plus a
  // 25,000-row block from 20 days ago to exercise the per-run cap.
  const [{ now }] = await prisma.$queryRaw<
    Array<{ now: Date }>
  >`SELECT clock_timestamp() AS now`;
  const seed = async (
    table: string,
    key: string,
    ids: string[],
    effective: boolean,
  ) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "${table}" (bucket_start_at, ${key}, captured_at, ${effective ? 'effective_at, ' : ''}sequence, bids, asks)
       SELECT b, id, b + interval '59 seconds', ${effective ? "b + interval '58 seconds', " : ''}1,
              '[["100.1","1"]]'::json, '[["100.2","1"]]'::json
       FROM unnest($1::text[]) AS id,
            generate_series(date_trunc('minute', $2::timestamp) - interval '15 days',
                            date_trunc('minute', $2::timestamp) - interval '40 minutes',
                            interval '20 minutes') AS b
       ON CONFLICT DO NOTHING`,
      ids,
      now,
    );
  await seed(
    SPOT,
    'asset_id',
    spotAssets.slice(50).map((a) => a.id),
    false,
  );
  await seed(
    FUTURES,
    'instrument_id',
    instruments.slice(50).map((i) => i.id),
    true,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "${SPOT}" (bucket_start_at, asset_id, captured_at, sequence, bids, asks)
     SELECT b, id, b + interval '1 second', 1, '[["1","1"]]'::json, '[["2","1"]]'::json
     FROM unnest($1::text[]) AS id,
          generate_series(date_trunc('minute', $2::timestamp) - interval '20 days',
                          date_trunc('minute', $2::timestamp) - interval '20 days' + interval '249 minutes',
                          interval '1 minute') AS b`,
    spotAssets.map((a) => a.id),
    now,
  );
  await prisma.$executeRawUnsafe(`ANALYZE "${SPOT}"`);
  await prisma.$executeRawUnsafe(`ANALYZE "${FUTURES}"`);

  // 5. plan shape under both cost profiles, at this scale.
  const shapes: string[] = [];
  const deleteBefore = cryptoOrderBookDeleteBefore(new Date(+now - 336 * HOUR));
  for (const [profile, settings] of Object.entries(COST_PROFILES))
    for (const market of ['spot', 'futures'] as const)
      await prisma
        .$transaction(async (tx) => {
          for (const setting of settings)
            await tx.$executeRawUnsafe(`SET LOCAL ${setting}`);
          const sql = cryptoOrderBookRetentionBatchSql(
            market,
            deleteBefore,
            1000,
          );
          const explain = await tx.$queryRawUnsafe(
            `EXPLAIN (FORMAT JSON) ${sql.text}`,
            ...sql.values,
          );
          shapes.push(
            assertBatchPlan(
              explain,
              CRYPTO_ORDER_BOOK_HISTORY_TABLES[market],
              `${profile}/${market}`,
            ),
          );
          throw new Error('ROLLBACK_EXPLAIN');
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'ROLLBACK_EXPLAIN')
            throw error;
        });

  // Every row that might still be within 336 hours when the worker reads
  // its own clock: all of them must survive.
  const keys = async (table: string, key: string) =>
    prisma.$queryRawUnsafe<Array<{ bucket: Date; id: string }>>(
      `SELECT bucket_start_at AS bucket, ${key} AS id FROM "${table}" WHERE bucket_start_at >= $1`,
      new Date(+deleteBefore - 5 * MINUTE),
    );
  const youngSpot = await keys(SPOT, 'asset_id');
  const youngFutures = await keys(FUTURES, 'instrument_id');
  const worker = new CryptoOrderBookRetentionWorker(
    prisma,
    new OpsJobLockService(prisma),
    new OpsJobRunService(prisma),
  );
  const second = new CryptoOrderBookRetentionWorker(
    prisma,
    new OpsJobLockService(prisma),
    new OpsJobRunService(prisma),
  );
  // Two instances at once: the Ops lease admits one.
  const [first, other] = await Promise.all([worker.run(), second.run()]);
  const capped = (first ?? other) as Record<string, unknown>;
  assert.equal(first === undefined || other === undefined, true);
  assert.equal(capped.batchLimitReached, true);
  assert.equal(capped.deletedCount, 20_000);
  // A held table lock fails the next run; the following one recovers.
  const releaseFutures = await lockTable(FUTURES);
  await assert.rejects(worker.run());
  await releaseFutures();
  assert.equal(worker.getStatus().lastFailureKind, 'statement_timeout');
  assert.equal(worker.getStatus().consecutiveFailures, 1);
  const finished = (await worker.run()) as Record<string, unknown>;
  assert.equal(finished.batchLimitReached, false);
  assert.equal(worker.getStatus().consecutiveFailures, 0);
  const boundary = new Date(String(finished.deleteBefore));
  const before = `bucket_start_at < '${boundary.toISOString()}'::timestamptz AT TIME ZONE 'UTC'`;
  assert.equal(await count(SPOT, before), 0);
  assert.equal(await count(FUTURES, before), 0);
  // Nothing whose minute reaches into the last 336 hours was deleted.
  for (const [table, key, rows] of [
    [SPOT, 'asset_id', youngSpot],
    [FUTURES, 'instrument_id', youngFutures],
  ] as const) {
    const kept = rows.filter((row) => +row.bucket >= +boundary);
    assert.ok(kept.length > 0);
    const [{ n }] = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "${table}" t
       JOIN unnest($1::timestamp[], $2::text[]) AS k(bucket, id)
         ON t.bucket_start_at = k.bucket AND t.${key} = k.id`,
      kept.map((row) => row.bucket),
      kept.map((row) => row.id),
    );
    assert.equal(Number(n), kept.length, `${table} kept rows`);
  }
  // Other markets and financial evidence are outside its reach.
  assert.equal(
    await prisma.assetOrderbookSnapshot.count({
      where: { assetId: koscom.id },
    }),
    1,
  );
  assert.equal(
    await prisma.assetPriceSnapshot.count({
      where: { assetId: spotAssets[0].id },
    }),
    1,
  );
  const runs = await prisma.opsJobRun.findMany({
    where: {
      jobName: 'crypto_order_book_retention',
      startedAt: { gte: started },
    },
    orderBy: { startedAt: 'asc' },
  });
  assert.deepEqual(
    runs.map((run) => run.status),
    ['succeeded', 'failed', 'succeeded'],
  );
  assert.equal(
    (runs[1].resultJson as { failureKind?: string }).failureKind,
    'statement_timeout',
  );
  const repeat = (await worker.run()) as Record<string, unknown>;
  assert.equal(repeat.deletedCount, 0);

  console.log(
    `crypto order book history integration ok: ${JSON.stringify({
      writers: counts,
      restartDuplicates: restarted.getStatus().counts.duplicates,
      retention: {
        firstRun: capped.deletedCount,
        recoveredRun: finished.deletedCount,
        deleteBefore: finished.deleteBefore,
      },
      plans: shapes,
    })}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
