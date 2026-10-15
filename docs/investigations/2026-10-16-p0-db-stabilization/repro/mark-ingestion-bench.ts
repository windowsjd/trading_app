/* Futures Mark ingestion load benchmark on an ISOLATED local PostgreSQL.
 * Real FuturesMarkIngestion (loaded from BACKEND_DIR: the work tree or a HEAD
 * copy) and real PostgreSQL; fake Binance WS (one markPriceUpdate per contract
 * per second) and fake REST premiumIndex. No provider network calls.
 *
 *   BACKEND_DIR=<backend root> DATABASE_URL=<loopback *_test> \
 *   SCENARIO=steady|silent-one|ws-outage|slow-write|write-fail SECONDS=60 \
 *   LABEL=new|old pnpm exec tsx mark-ingestion-bench.ts
 *
 * Every futures instrument in the disposable DB is a target (the target query
 * is replaced; selection is not under test). Prints one JSON summary line. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';

type Row = { symbol: string; source: string };
const q = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const at = (p: number) =>
    +(s[Math.max(0, Math.ceil(s.length * p) - 1)] ?? 0).toFixed(1);
  return { n: s.length, p50: at(0.5), p95: at(0.95), max: at(1) };
};

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.ok(url.pathname.endsWith('_test'));
  const backend = process.env.BACKEND_DIR!;
  const seconds = Number(process.env.SECONDS ?? 60);
  const scenario = process.env.SCENARIO ?? 'steady';
  process.env.FUTURES_MARK_INGESTION_ENABLED = 'true';
  const { FuturesMarkIngestion } = await import(
    join(backend, 'src/futures/futures-mark-ingestion.service')
  );
  const { PrismaService } = await import(
    join(backend, 'src/prisma/prisma.service')
  );
  const admin = new Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const { rows: instruments } = await admin.query<{
    id: string;
    symbol: string;
  }>(
    `SELECT i.id, a.symbol FROM futures_instruments i
     JOIN assets a ON a.id = i.underlying_asset_id ORDER BY i.id`,
  );
  const symbols = instruments.map((i) => i.symbol);
  const silentOne = symbols[Math.floor(symbols.length / 2)];
  let t0 = 0;
  const elapsed = () => (performance.now() - t0) / 1000;
  const silenced = (symbol: string) => {
    const t = elapsed();
    if (scenario === 'silent-one') return symbol === silentOne && t >= 20 && t < 30;
    if (scenario === 'ws-outage') return t >= 20 && t < 40;
    return false;
  };

  // Fake Binance stream: one frame per subscribed contract per second.
  const sockets: FakeSocket[] = [];
  class FakeSocket extends EventEmitter {
    readyState = 0;
    subscribed: string[] = [];
    timer?: NodeJS.Timeout;
    constructor(readonly url: string) {
      super();
      sockets.push(this);
      setImmediate(() => {
        this.readyState = 1;
        this.emit('open');
      });
    }
    send(data: string) {
      const message = JSON.parse(data) as { method: string; params: string[] };
      if (message.method !== 'SUBSCRIBE') return;
      this.subscribed = message.params.map((p) => p.split('@')[0].toUpperCase());
      this.timer = setInterval(() => {
        if (this.readyState !== 1) return;
        const E = Date.now() - 30;
        for (const s of this.subscribed) {
          if (silenced(s)) continue;
          this.emit(
            'message',
            Buffer.from(
              JSON.stringify({
                stream: `${s.toLowerCase()}@markPrice@1s`,
                data: { e: 'markPriceUpdate', s, p: '100.5', E, st: 1 },
              }),
            ),
          );
        }
      }, 1000);
    }
    ping() {}
    close() {
      clearInterval(this.timer);
      this.readyState = 3;
      this.emit('close');
    }
    terminate() {
      this.close();
    }
  }

  // Fake REST premiumIndex for every contract.
  let restCalls = 0;
  global.fetch = (async () => {
    restCalls++;
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () =>
        JSON.stringify(
          symbols.map((symbol) => ({
            symbol,
            markPrice: '100.5',
            time: Date.now() - 200,
          })),
        ),
    };
  }) as unknown as typeof fetch;

  // Real PrismaService with the target query replaced and Mark calls timed.
  const prisma = new PrismaService();
  await prisma.$connect();
  const writes: number[] = [];
  const freshness: number[] = [];
  const rows = { ws: 0, rest: 0 };
  const mark = prisma.futuresMarkSnapshot;
  const markDelegate = {
    createMany: async (args: { data: Row[]; skipDuplicates?: boolean }) => {
      const t = elapsed();
      if (scenario === 'slow-write' && t >= 20 && t < 30) await sleep(4000);
      if (scenario === 'write-fail' && t >= 20 && t < 25)
        throw Object.assign(new Error('simulated'), {
          cause: { kind: 'ConnectionClosed' },
        });
      const started = performance.now();
      const result = await mark.createMany(args as never);
      writes.push(performance.now() - started);
      for (const row of args.data)
        if (row.source === 'binance_usdm_mark_ws') rows.ws++;
        else rows.rest++;
      return result;
    },
    groupBy: async (args: unknown) => {
      const started = performance.now();
      const result = await mark.groupBy(args as never);
      freshness.push(performance.now() - started);
      return result;
    },
  };
  const instrumentDelegate = {
    findMany: async () =>
      instruments.map((i) => ({ id: i.id, underlyingAsset: { symbol: i.symbol } })),
    update: async () => ({}),
  };
  const wrapped = new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === 'futuresMarkSnapshot') return markDelegate;
      if (prop === 'futuresInstrument') return instrumentDelegate;
      return Reflect.get(target, prop, receiver);
    },
  });
  const ingest = new FuturesMarkIngestion(
    wrapped,
    { eval: async () => [1, 0, 0] },
    (u: string) => new FakeSocket(u),
  );
  ingest.refreshCoverage = async () => undefined;
  const cycles: number[] = [];
  let skipped = 0;
  let failedCycles = 0;
  const runCycle = ingest.cycle.bind(ingest);
  ingest.cycle = async () => {
    if ((ingest as unknown as { busy: boolean }).busy) {
      skipped++;
      return runCycle();
    }
    const started = performance.now();
    try {
      return await runCycle();
    } catch (error) {
      failedCycles++;
      throw error;
    } finally {
      cycles.push(performance.now() - started);
    }
  };

  const stats = async () => {
    const { rows: [s] } = await admin.query(
      `SELECT
         (SELECT coalesce(sum(idx_blks_hit + idx_blks_read), 0) FROM pg_statio_user_indexes WHERE relname = 'futures_mark_snapshots')::bigint AS idx_blocks,
         (SELECT coalesce(sum(heap_blks_hit + heap_blks_read), 0) FROM pg_statio_user_tables WHERE relname = 'futures_mark_snapshots')::bigint AS heap_blocks,
         (SELECT coalesce(sum(idx_blks_read), 0) FROM pg_statio_user_indexes WHERE relname = 'futures_mark_snapshots')::bigint AS idx_reads,
         (SELECT xact_commit FROM pg_stat_database WHERE datname = current_database())::bigint AS xact`,
    );
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Number(v)]));
  };
  const runStart = await admin.query<{ at: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS at`,
  );
  const before = await stats();
  t0 = performance.now();
  ingest.onModuleInit();
  let staleSamples = 0;
  const statusTimer = setInterval(() => {
    const status = (ingest as { getStatus?: () => { staleTargets: number } })
      .getStatus?.();
    if (status && status.staleTargets > 0) staleSamples++;
  }, 1000);
  await sleep(seconds * 1000);
  clearInterval(statusTimer);
  const stopAt = await admin.query<{ at: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC' - interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS at`,
  );
  const finalStatus = (ingest as { getStatus?: () => unknown }).getStatus?.() ?? null;
  await ingest.onModuleDestroy();
  for (const s of sockets) s.close();
  await prisma.$disconnect();
  await sleep(1500);
  const after = await stats();
  const runEnd = await admin.query<{ at: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS at`,
  );
  // Stored freshness per contract over the measured run (after a 10 s warm-up):
  // the largest gap between consecutive stored provider times, any source.
  const from = new Date(Date.parse(runStart.rows[0].at + 'Z') + 10000)
    .toISOString()
    .replace('Z', '');
  void runEnd;
  const to = stopAt.rows[0].at;
  const { rows: gaps } = await admin.query<{
    symbol: string;
    max_gap_s: number;
    gaps_over_5s: number;
  }>(
    `SELECT a.symbol, g.max_gap_s, g.gaps_over_5s FROM futures_instruments i
     JOIN assets a ON a.id = i.underlying_asset_id
     CROSS JOIN LATERAL (
       SELECT max(gap)::float8 AS max_gap_s, count(*) FILTER (WHERE gap > 5)::int AS gaps_over_5s
       FROM (SELECT extract(epoch FROM t - lag(t) OVER (ORDER BY t)) AS gap
             FROM (SELECT m.effective_at AS t FROM futures_mark_snapshots m
                   WHERE m.instrument_id = i.id AND m.effective_at >= $1 AND m.effective_at <= $2
                   UNION ALL SELECT $1::timestamp UNION ALL SELECT $2::timestamp) b) x
     ) g`,
    [from, to],
  );
  await admin.end();
  const measured = seconds;
  const worst = gaps.reduce((m, g) => Math.max(m, g.max_gap_s), 0);
  console.log(
    JSON.stringify({
      label: process.env.LABEL ?? backend,
      scenario,
      contracts: symbols.length,
      seconds: measured,
      cycles: { ran: q(cycles), skippedWhileBusy: skipped, failed: failedCycles },
      inserts: q(writes),
      freshnessQueries: q(freshness),
      restCalls,
      rowsStored: rows,
      markBuffersPerSecond: Math.round(
        (after.idx_blocks + after.heap_blocks - before.idx_blocks - before.heap_blocks) /
          measured,
      ),
      markIndexReadsPerSecond: +((after.idx_reads - before.idx_reads) / measured).toFixed(1),
      transactionsPerSecond: +((after.xact - before.xact) / measured).toFixed(1),
      storedGap: {
        worstContractMaxGapS: +worst.toFixed(2),
        contractsWithGapOver5s: gaps.filter((g) => g.gaps_over_5s > 0).length,
        gapsOver5s: gaps.reduce((n, g) => n + g.gaps_over_5s, 0),
        silentContract:
          scenario === 'silent-one'
            ? gaps.find((g) => g.symbol === silentOne)
            : undefined,
      },
      staleSamples,
      finalStatus,
    }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
