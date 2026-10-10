/** Live measurement on a DISPOSABLE loopback DB only (never production):
 * runs the real Mark + Futures Last ingestion services against Binance public
 * market data, then measures market execution latency with and without them.
 *
 * cd backend && NODE_ENV=test FUTURES_DB_INTEGRATION=1 \
 *   DATABASE_URL=postgresql://...@127.0.0.1:<port>/<disposable> REDIS_URL=redis://127.0.0.1:<port> \
 *   MEASURE_SECONDS=150 MEASURE_REPORT=/tmp/out.json \
 *   pnpm tsx ../docs/investigations/2026-10-10-futures-last-price/reproduction/live-ingestion-measurement.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { db, app } from '../../../../backend/scripts/futures-integration';
import { RedisService } from '../../../../backend/src/redis/redis.service';
import { FuturesMarkIngestion } from '../../../../backend/src/futures/futures-mark-ingestion.service';
import { FuturesLastPriceIngestion } from '../../../../backend/src/futures/futures-last-price-ingestion.service';
import { validFuturesLastPrice } from '../../../../backend/src/futures/futures-last-price';
import { readFuturesMark } from '../../../../backend/src/futures/futures-mark';

const url = new URL(process.env.DATABASE_URL!);
assert.ok(
  url.hostname === '127.0.0.1' && process.env.NODE_ENV === 'test',
  'Disposable loopback DB only',
);
process.env.FUTURES_MARK_INGESTION_ENABLED = 'true';
process.env.FUTURES_LAST_PRICE_INGESTION_ENABLED = 'true';
process.env.FUTURES_TRADING_MODE = 'ENABLED';
process.env.FUTURES_RISK_ENGINE_ENABLED = 'true';
const seconds = Number(process.env.MEASURE_SECONDS ?? 150);
const summary = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    +(s[Math.max(0, Math.ceil(s.length * p) - 1)] ?? 0).toFixed(2);
  return { samples: s.length, p50: at(0.5), p95: at(0.95), max: at(1) };
};
const dbNow = async () =>
  (await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]
    .now;
async function countBySource(table: 'last' | 'mark', since: Date) {
  return table === 'last'
    ? db.$queryRaw<Array<{ source: string; n: bigint }>>`
        SELECT source::text, count(*) AS n FROM futures_last_price_snapshots
        WHERE captured_at >= ${since} GROUP BY source`
    : db.$queryRaw<Array<{ source: string; n: bigint }>>`
        SELECT source::text, count(*) AS n FROM futures_mark_snapshots
        WHERE captured_at >= ${since} GROUP BY source`;
}
async function readiness() {
  const now = await dbNow();
  const instruments = await db.futuresInstrument.findMany({
    include: { underlyingAsset: true },
  });
  let last = 0,
    mark = 0;
  const tradeAges: number[] = [];
  const receiptAges: number[] = [];
  for (const instrument of instruments) {
    const row = await db.futuresLastPriceSnapshot.findFirst({
      where: {
        instrumentId: instrument.id,
        capturedAt: { lte: now },
        effectiveAt: { lte: now },
      },
      orderBy: [{ effectiveAt: 'desc' }, { capturedAt: 'desc' }, { id: 'desc' }],
    });
    if (row && validFuturesLastPrice(row, instrument, now)) {
      last++;
      tradeAges.push(+now - +row.effectiveAt);
      receiptAges.push(+now - +row.capturedAt);
    }
    if (await readFuturesMark(db, instrument, now, false)) mark++;
  }
  return {
    instruments: instruments.length,
    lastValid: last,
    markValid: mark,
    tradeAgeMs: summary(tradeAges),
    receiptAgeMs: summary(receiptAges),
  };
}
async function executions(label: string, count: number, synthetic: boolean) {
  const user = await db.user.create({
    data: {
      email: `measure-${randomUUID()}@example.invalid`,
      nickname: randomUUID().slice(0, 16),
      passwordHash: 'test-only',
    },
  });
  const accountId = (await app.general.openGeneralAccount(user.id)).data
    .account.id;
  await db.cashWallet.updateMany({
    where: { tradingAccountId: accountId, walletScope: 'crypto_futures' },
    data: { balanceAmount: '1000000' },
  });
  const instrument = await db.futuresInstrument.findFirstOrThrow({
    where: { underlyingAsset: { symbol: 'BTCUSDT' } },
    include: { underlyingAsset: true },
  });
  const latencies: number[] = [];
  const failures: Record<string, number> = {};
  let positionId: string | undefined;
  for (let i = 0; i < count; i++) {
    if (synthetic) {
      // Ingestion stopped: one fresh row per source, as a feed would write.
      const at = await dbNow();
      const latest = await db.futuresLastPriceSnapshot.findFirstOrThrow({
        where: { instrumentId: instrument.id },
        orderBy: { capturedAt: 'desc' },
      });
      await db.futuresLastPriceSnapshot.create({
        data: {
          instrumentId: instrument.id,
          symbol: 'BTCUSDT',
          price: latest.price,
          source: 'binance_usdm_agg_trade_ws',
          effectiveAt: at,
          capturedAt: at,
        },
      });
      await db.futuresMarkSnapshot.createMany({
        data: [
          {
            instrumentId: instrument.id,
            symbol: 'BTCUSDT',
            source: 'binance_usdm_mark_ws',
            price: latest.price,
            effectiveAt: at,
            capturedAt: at,
          },
        ],
        skipDuplicates: true,
      });
    }
    const body = positionId
      ? {
          instrumentId: instrument.id,
          positionId,
          operation: 'close',
          direction: 'long',
          quantity: '0.01000000',
          leverage: 10,
          idempotencyKey: randomUUID(),
        }
      : {
          instrumentId: instrument.id,
          operation: 'open',
          direction: 'long',
          quantity: '0.01',
          leverage: 10,
          idempotencyKey: randomUUID(),
        };
    const start = performance.now();
    try {
      const result = await app.futures.execute(user.id, accountId, body);
      latencies.push(performance.now() - start);
      positionId =
        result.data.position.status === 'open'
          ? result.data.position.id
          : undefined;
    } catch (error) {
      const code =
        (error as { getResponse?: () => { error?: { code?: string } } })
          .getResponse?.()?.error?.code ?? 'UNEXPECTED';
      failures[code] = (failures[code] ?? 0) + 1;
    }
  }
  return { label, commands: count, latencyMs: summary(latencies), failures };
}

async function main() {
  await db.$connect();
  const redis = new RedisService();
  const mark = new FuturesMarkIngestion(db, redis);
  const last = new FuturesLastPriceIngestion(db, redis);
  let frames = 0,
    accepted = 0,
    restCalls = 0,
    restRows = 0;
  const accept = last.accept.bind(last);
  last.accept = (payload, capturedAt) => {
    frames++;
    const ok = accept(payload, capturedAt);
    if (ok) accepted++;
    return ok;
  };
  const recover = last.recover.bind(last);
  last.recover = async (symbols) => {
    restCalls++;
    const rows = await recover(symbols);
    restRows += rows;
    return rows;
  };
  const sizeBefore = (
    await db.$queryRaw<Array<{ bytes: bigint; rows: bigint }>>`
      SELECT pg_total_relation_size('futures_last_price_snapshots') AS bytes,
             (SELECT count(*) FROM futures_last_price_snapshots) AS rows`
  )[0];
  const started = await dbNow();
  const cpu = process.cpuUsage();
  const t0 = performance.now();
  mark.onModuleInit();
  last.onModuleInit();
  const samples: unknown[] = [];
  let rssPeak = 0;
  for (let elapsed = 0; elapsed < seconds; elapsed += 10) {
    const window = await dbNow();
    const before = { frames, accepted, restCalls };
    await delay(10000);
    rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    samples.push({
      second: elapsed + 10,
      wsFramesPerSec: (frames - before.frames) / 10,
      acceptedPerSec: (accepted - before.accepted) / 10,
      restCalls: restCalls - before.restCalls,
      lastRows: (await countBySource('last', window)).map((r) => [
        r.source,
        Number(r.n),
      ]),
      markRows: (await countBySource('mark', window)).map((r) => [
        r.source,
        Number(r.n),
      ]),
    });
  }
  const elapsedMs = performance.now() - t0;
  const used = process.cpuUsage(cpu);
  const liveReadiness = await readiness();
  const live = await executions('live ingestion running', 60, false);
  const lastRows = await countBySource('last', started);
  const markRows = await countBySource('mark', started);
  await mark.onModuleDestroy();
  await last.onModuleDestroy();
  await delay(1500);
  const quiet = await executions('ingestion stopped (synthetic feed)', 60, true);
  const sizeAfter = (
    await db.$queryRaw<Array<{ bytes: bigint; rows: bigint }>>`
      SELECT pg_total_relation_size('futures_last_price_snapshots') AS bytes,
             (SELECT count(*) FROM futures_last_price_snapshots) AS rows`
  )[0];
  const addedRows = Number(sizeAfter.rows) - Number(sizeBefore.rows);
  const addedBytes = Number(sizeAfter.bytes) - Number(sizeBefore.bytes);
  const lastTotal = lastRows.reduce((n, r) => n + Number(r.n), 0);
  const report = {
    measuredAt: started.toISOString(),
    durationSec: +(elapsedMs / 1000).toFixed(1),
    ingestion: {
      wsFramesPerSec: +(frames / (elapsedMs / 1000)).toFixed(1),
      acceptedPerSec: +(accepted / (elapsedMs / 1000)).toFixed(1),
      restCalls,
      restRows,
      restCallsPerMin: +((restCalls * 60000) / elapsedMs).toFixed(1),
      lastRowsBySource: lastRows.map((r) => [r.source, Number(r.n)]),
      lastRowsPerSec: +(lastTotal / (elapsedMs / 1000)).toFixed(2),
      markRowsBySource: markRows.map((r) => [r.source, Number(r.n)]),
      processCpuPercentOneCore: +(
        (used.user + used.system) /
        elapsedMs /
        10
      ).toFixed(2),
      processRssPeakBytes: rssPeak,
      samples,
    },
    storage: {
      addedRows,
      addedBytes,
      bytesPerRowIncludingIndexes: addedRows ? Math.round(addedBytes / addedRows) : null,
      projectedRowsPer24h: Math.round((lastTotal / (elapsedMs / 1000)) * 86400),
    },
    readiness: liveReadiness,
    execution: [live, quiet],
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.MEASURE_REPORT)
    writeFileSync(process.env.MEASURE_REPORT, JSON.stringify(report, null, 2) + '\n');
  await redis.onModuleDestroy();
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
