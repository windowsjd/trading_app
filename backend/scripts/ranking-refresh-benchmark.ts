/** Opt-in benchmark against an EMPTY, isolated loopback PostgreSQL database.
 * No environment files, providers, Redis, or HTTP are used. Driver observations
 * apply only during refresh; fixture/reset/hash/cleanup SQL is not measured.
 * Run the same script against baseline and candidate code to compare JSON. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { PrismaService } from '../src/prisma/prisma.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { RankingRefreshService } from '../src/ranking/ranking-refresh.service';

const databaseUrl = new URL(process.env.DATABASE_URL ?? 'file:///missing');
if (
  process.env.RANKING_BENCHMARK !== '1' ||
  process.env.NODE_ENV !== 'test' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname) ||
  !['/ranking_r07', '/ranking_r07_benchmark'].includes(databaseUrl.pathname)
) {
  throw new Error(
    'Requires RANKING_BENCHMARK=1, NODE_ENV=test and an isolated loopback database named ranking_r07 or ranking_r07_benchmark.',
  );
}
Logger.overrideLogger(false);

type SqlResult = { rowCount: number | null };
type Metric = {
  sqlStatements: number;
  selectStatements: number;
  historyQueries: number;
  historyRowsRead: number;
  historyMaxRowsPerQuery: number;
  priceQueries: number;
  fxQueries: number;
  holdingsQueries: number;
  participantWrites: number;
  rankingWrites: number;
  equityWrites: number;
  lockHeldMs: number;
  sqlElapsedMs: number;
  byTable: Record<string, number>;
};
let activeMetric: Metric | null = null;
const lockedConnections = new WeakMap<object, number>();
// Invoked below with Reflect.apply and the original Client receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalQuery = Client.prototype.query;

// Prisma's adapter uses both Pool.query's callback and Client.query's promise
// interface. Count once, at the actual driver, rather than Prisma method calls.
Client.prototype.query = function (this: Client, ...args: unknown[]) {
  const metric = activeMetric;
  const first = args[0];
  const sql =
    typeof first === 'string'
      ? first
      : ((first as { text?: string } | undefined)?.text ?? '');
  const start = performance.now();
  const complete = (result?: SqlResult) => {
    if (!metric) return;
    const finish = performance.now();
    metric.sqlStatements++;
    metric.sqlElapsedMs += finish - start;
    const select = /^\s*SELECT\b/i.test(sql);
    if (select) metric.selectStatements++;
    for (const table of [
      'season_participants',
      'season_rankings',
      'trading_accounts',
      'cash_wallets',
      'positions',
      'assets',
      'asset_price_snapshots',
      'fx_rate_snapshots',
      'equity_snapshots',
    ]) {
      if (sql.includes(`"${table}"`)) {
        metric.byTable[table] = (metric.byTable[table] ?? 0) + 1;
      }
    }
    if (
      select &&
      sql.includes('"equity_snapshots"') &&
      sql.includes('"total_asset_krw"')
    ) {
      metric.historyQueries++;
      metric.historyRowsRead += result?.rowCount ?? 0;
      metric.historyMaxRowsPerQuery = Math.max(
        metric.historyMaxRowsPerQuery,
        result?.rowCount ?? 0,
      );
    }
    if (select && sql.includes('"asset_price_snapshots"'))
      metric.priceQueries++;
    if (select && sql.includes('"fx_rate_snapshots"')) metric.fxQueries++;
    if (
      select &&
      /"(?:trading_accounts|cash_wallets|positions|assets)"/.test(sql)
    )
      metric.holdingsQueries++;
    if (/^\s*(?:INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      if (sql.includes('"season_participants"')) metric.participantWrites++;
      if (sql.includes('"season_rankings"')) metric.rankingWrites++;
      if (sql.includes('"equity_snapshots"')) metric.equityWrites++;
    }
    if (/FOR UPDATE/i.test(sql) && sql.includes('"seasons"'))
      lockedConnections.set(this, finish);
    if (/^\s*(?:COMMIT|ROLLBACK)\b/i.test(sql)) {
      const acquired = lockedConnections.get(this);
      if (acquired !== undefined) metric.lockHeldMs += finish - acquired;
      lockedConnections.delete(this);
    }
  };
  const last = args.at(-1);
  if (typeof last === 'function') {
    args[args.length - 1] = (error: unknown, result?: SqlResult) => {
      complete(result);
      Reflect.apply(last, undefined, [error, result]);
    };
    return Reflect.apply(originalQuery, this, args) as unknown;
  }
  const result: unknown = Reflect.apply(originalQuery, this, args);
  if (result instanceof Promise) {
    return (result as Promise<SqlResult>).then(
      (value) => {
        complete(value);
        return value;
      },
      (error: unknown) => {
        complete();
        throw error;
      },
    );
  }
  throw new Error('Unexpected PostgreSQL driver query interface.');
} as typeof originalQuery;

const db = new PrismaService();
const capturedAt = new Date('2026-09-22T00:01:00.000Z');
const startAt = new Date('2026-01-01T00:00:00.000Z');
const namespace = randomUUID();
const ids = {
  users: [] as string[],
  accounts: [] as string[],
  assets: [] as string[],
  seasons: [] as string[],
  fx: [] as string[],
};
type Shape = { p: number; k: number; h: number };
const defaultShapes: Shape[] = [
  { p: 20, k: 3, h: 20 },
  { p: 100, k: 3, h: 20 },
  { p: 100, k: 12, h: 20 },
  { p: 100, k: 3, h: 1000 },
  { p: 500, k: 3, h: 100 },
  { p: 500, k: 12, h: 1000 },
];
const shapes = process.env.RANKING_BENCHMARK_SHAPES
  ? process.env.RANKING_BENCHMARK_SHAPES.split(',').map((value) => {
      const [p, k, h] = value.split('/').map(Number);
      assert.ok([p, k, h].every((n) => Number.isInteger(n) && n > 0));
      assert.ok(p <= 1000 && k <= 30 && h <= 5000 && p * h <= 1_000_000);
      return { p, k, h };
    })
  : defaultShapes;
const samples = Number(process.env.RANKING_BENCHMARK_SAMPLES ?? 3);
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 10);
const modes = (
  process.env.RANKING_BENCHMARK_MODES ?? 'participant,scheduled'
).split(',');
assert.ok(
  modes.every((mode) => ['participant', 'scheduled', 'burst'].includes(mode)),
);

async function seed(shape: Shape) {
  const fixtureIndex = ids.seasons.length;
  const season = await db.season.create({
    data: {
      name: `ranking-r07-${namespace}-${fixtureIndex}`,
      status: 'active',
      startAt,
      endAt: new Date('2030-01-01T00:00:00Z'),
      initialCapitalKrw: '1000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  ids.seasons.push(season.id);
  const assets: string[] = [];
  for (let a = 0; a < shape.k; a++) {
    const asset = await db.asset.create({
      data: {
        symbol: `R07-${namespace}-${fixtureIndex}-${a}`,
        name: 'Benchmark crypto',
        market: 'BINANCE',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
        assetType: 'crypto',
      },
    });
    assets.push(asset.id);
    ids.assets.push(asset.id);
    await db.assetPriceSnapshot.create({
      data: {
        assetId: asset.id,
        price: String(10 + a),
        currencyCode: 'USD',
        sourceType: 'provider_api',
        sourceName: 'binance_spot_ws_ticker',
        effectiveAt: capturedAt,
        capturedAt,
        createdAt: capturedAt,
      },
    });
  }
  const fx = await db.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1350',
      sourceType: 'provider_api',
      sourceName: 'korea_exim_exchange_rate',
      effectiveAt: capturedAt,
      capturedAt,
      createdAt: capturedAt,
    },
  });
  ids.fx.push(fx.id);
  const participants: Array<{ id: string; accountId: string; index: number }> =
    [];
  for (let p = 0; p < shape.p; p++) {
    // Lexically sorted identifiers preserve the final user-id tie-break across
    // independent runs. IDs need not be UUIDs in this schema.
    const stem = `${namespace}-${fixtureIndex}-${String(p).padStart(6, '0')}`;
    const userId = `r07-user-${stem}`;
    const accountId = `r07-account-${stem}`;
    const participantId = `r07-participant-${stem}`;
    await db.user.create({
      data: {
        id: userId,
        email: `${stem}@example.invalid`,
        passwordHash: 'test-only',
        nickname: `r07-${p}`,
      },
    });
    ids.users.push(userId);
    await db.tradingAccount.create({
      data: {
        id: accountId,
        userId,
        mode: 'season',
        initialCapitalKrw: '1000000',
        status: 'active',
        openedAt: startAt,
      },
    });
    ids.accounts.push(accountId);
    await db.seasonParticipant.create({
      data: {
        id: participantId,
        seasonId: season.id,
        userId,
        tradingAccountId: accountId,
        participantStatus: 'active',
        initialCapitalKrw: '1000000',
        joinedAt: startAt,
        totalAssetKrw: '1000000',
        totalReturnRate: '0',
        maxDrawdown: '0',
        totalFillCount: p % 7,
      },
    });
    participants.push({ id: participantId, accountId, index: p });
    await db.cashWallet.createMany({
      data: [
        {
          tradingAccountId: accountId,
          currencyCode: 'KRW',
          balanceAmount: String(500000 + (p % 17) * 1000),
        },
        {
          tradingAccountId: accountId,
          currencyCode: 'USD',
          balanceAmount: '100',
        },
      ],
    });
    await db.position.createMany({
      data: assets.map((assetId, a) => ({
        tradingAccountId: accountId,
        assetId,
        quantity: String(1 + ((p + a) % 3)),
        averageCost: String(8 + a),
        currencyCode: 'USD',
        realizedPnl: String(p % 5),
        realizedPnlKrw: String((p % 5) * 1350),
      })),
    });
    // Bounded insertion keeps benchmark setup from retaining P*H objects.
    for (let offset = 0; offset < shape.h; offset += 500) {
      await db.equitySnapshot.createMany({
        data: Array.from(
          { length: Math.min(500, shape.h - offset) },
          (_, index) => {
            const h = offset + index;
            const assetValue =
              1000000 + (((h * 17 + p * 13) % 101) - 50) * 1000;
            const at = new Date(capturedAt.getTime() - (shape.h - h) * 300_000);
            return {
              id: `r07-history-${stem}-${String(h).padStart(6, '0')}`,
              tradingAccountId: accountId,
              totalAssetKrw: String(assetValue),
              returnRate: String((assetValue - 1000000) / 10000),
              krwCash: String(assetValue),
              usdCashKrw: '0',
              domesticStockValueKrw: '0',
              usStockValueKrw: '0',
              cryptoValueKrw: '0',
              snapshotReason: 'order_executed' as const,
              capturedAt: at,
              createdAt: at,
            };
          },
        ),
      });
    }
  }
  return { seasonId: season.id, participants };
}
type Fixture = Awaited<ReturnType<typeof seed>>;

async function reset(fixture: Fixture) {
  // Keep the previous publication so measured refreshes include full existing-
  // set scope validation. Only the first warm-up starts with an empty set.
  await db.seasonRanking.updateMany({
    where: { seasonId: fixture.seasonId },
    data: { capturedAt: new Date(capturedAt.getTime() - 1) },
  });
  await db.equitySnapshot.deleteMany({
    where: {
      tradingAccountId: { in: fixture.participants.map((p) => p.accountId) },
      snapshotReason: 'scheduled',
    },
  });
}

async function outputHash(fixture: Fixture, expectedAt: Date) {
  const index = new Map(fixture.participants.map((p) => [p.id, p.index]));
  const rankings = await db.seasonRanking.findMany({
    where: { seasonId: fixture.seasonId },
    orderBy: { rank: 'asc' },
  });
  const participants = await db.seasonParticipant.findMany({
    where: { seasonId: fixture.seasonId },
    orderBy: { id: 'asc' },
  });
  const normalized = {
    rankings: rankings.map((row) => ({
      participant: index.get(row.seasonParticipantId),
      rank: row.rank,
      totalAssetKrw: row.totalAssetKrw.toFixed(8),
      returnRate: row.returnRate.toFixed(8),
      maxDrawdown: row.maxDrawdown.toFixed(8),
      totalFillCount: row.totalFillCount,
      reachedReturnAt: row.reachedReturnAt?.toISOString(),
      rankType: row.rankType,
      rankingDate: row.rankingDate.toISOString(),
      capturedAt: row.capturedAt.toISOString(),
    })),
    participants: participants.map((row) => ({
      participant: index.get(row.id),
      totalAssetKrw: row.totalAssetKrw.toFixed(8),
      totalReturnRate: row.totalReturnRate.toFixed(8),
      maxDrawdown: row.maxDrawdown.toFixed(8),
      currentRank: row.currentRank,
    })),
  };
  assert.equal(rankings.length, fixture.participants.length);
  assert.ok(
    rankings.every((row) => row.capturedAt.getTime() === expectedAt.getTime()),
  );
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

async function measure(fixture: Fixture, mode: string) {
  await reset(fixture);
  const valuation = new PortfolioValuationService(db);
  let valuationCalls = 0;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calculate = valuation.calculateTradingAccountValuation.bind(
    valuation,
  ) as PortfolioValuationService['calculateTradingAccountValuation'];
  valuation.calculateTradingAccountValuation = async (...args) => {
    valuationCalls++;
    const value = await calculate(...args);
    if (mode === 'burst' && valuationCalls === 1) {
      enter();
      await released;
    }
    return value;
  };
  const service = new RankingRefreshService(db, valuation);
  const metric: Metric = {
    sqlStatements: 0,
    selectStatements: 0,
    historyQueries: 0,
    historyRowsRead: 0,
    historyMaxRowsPerQuery: 0,
    priceQueries: 0,
    fxQueries: 0,
    holdingsQueries: 0,
    participantWrites: 0,
    rankingWrites: 0,
    equityWrites: 0,
    lockHeldMs: 0,
    sqlElapsedMs: 0,
    byTable: {},
  };
  activeMetric = metric;
  const started = performance.now();
  let wallMs: number;
  try {
    if (mode === 'burst') {
      const first = service.refreshCurrentRankingAfterParticipantChange(
        fixture.seasonId,
        fixture.participants[0].id,
        capturedAt,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entered,
          first.then(() => {
            throw new Error(
              'Burst finished before reaching the valuation barrier.',
            );
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error('Burst barrier timed out.')),
              15_000,
            );
          }),
        ]);
        const pending = Array.from({ length: 20 }, (_, n) =>
          service.refreshCurrentRankingAfterParticipantChange(
            fixture.seasonId,
            fixture.participants[n % fixture.participants.length].id,
            new Date(capturedAt.getTime() + 1000),
          ),
        );
        const scheduled = service.refreshCurrentRankingForSeason(
          fixture.seasonId,
          {
            capturedAt: new Date(capturedAt.getTime() + 2000),
            createEquitySnapshots: true,
            lockKey: `scheduled:${fixture.seasonId}`,
          },
        );
        release();
        const outcomes = await Promise.allSettled([
          first,
          ...pending,
          scheduled,
        ]);
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') throw outcome.reason;
        }
      } finally {
        clearTimeout(timeout);
        release();
        await first;
      }
    } else {
      const result = await service.refreshCurrentRankingForSeason(
        fixture.seasonId,
        {
          capturedAt,
          createEquitySnapshots: mode === 'scheduled',
          lockKey: `${mode}:${fixture.seasonId}`,
        },
      );
      assert.equal(result.skipped, false);
    }
    wallMs = performance.now() - started;
  } finally {
    activeMetric = null;
  }
  assert.ok(
    metric.sqlStatements > 0 && metric.lockHeldMs > 0,
    'Instrumentation must observe real SQL and the Season write lock.',
  );
  return {
    ...metric,
    wallMs,
    triggerRequests: mode === 'burst' ? 22 : 1,
    valuationCalls,
    fullParticipantEvaluations: valuationCalls / fixture.participants.length,
    outputHash: await outputHash(
      fixture,
      new Date(capturedAt.getTime() + (mode === 'burst' ? 2000 : 0)),
    ),
  };
}

async function cleanup() {
  activeMetric = null;
  const accountWhere = { tradingAccountId: { in: ids.accounts } };
  await db.seasonRanking.deleteMany({
    where: { seasonId: { in: ids.seasons } },
  });
  await db.equitySnapshot.deleteMany({ where: accountWhere });
  await db.position.deleteMany({ where: accountWhere });
  await db.cashWallet.deleteMany({ where: accountWhere });
  await db.seasonParticipant.deleteMany({
    where: { seasonId: { in: ids.seasons } },
  });
  await db.tradingAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  await db.user.deleteMany({ where: { id: { in: ids.users } } });
  await db.season.deleteMany({ where: { id: { in: ids.seasons } } });
  await db.assetPriceSnapshot.deleteMany({
    where: { assetId: { in: ids.assets } },
  });
  await db.asset.deleteMany({ where: { id: { in: ids.assets } } });
  await db.fxRateSnapshot.deleteMany({ where: { id: { in: ids.fx } } });
}

async function main() {
  await db.$connect();
  const results: Array<{
    shape: Shape;
    mode: string;
    samples: Awaited<ReturnType<typeof measure>>[];
  }> = [];
  const report = {
    label: process.env.RANKING_BENCHMARK_LABEL ?? 'unlabelled',
    capturedAt: capturedAt.toISOString(),
    node: process.version,
    samples,
    warmupPerShapeMode: 1,
    definitions: {
      resetPolicy:
        'Keep prior publication with capturedAt=basis-1ms; first warm-up starts empty, all measured runs validate/replace an existing ranking set. Remove only generated scheduled snapshots between runs.',
      burst:
        'Optional mode: first participant valuation pauses, 20 same-key participant triggers and one scheduler trigger arrive, then release and await all. Explicit basis,+1s,+2s; no sleeps. fullParticipantEvaluations=actual scalar valuation calls/P.',
      sqlStatements:
        'Actual pg Client.query completions including BEGIN/COMMIT/SET; fixture/reset/hash SQL excluded.',
      historyRowsRead:
        'Driver rowCount for SELECT of equity_snapshots.total_asset_krw; excludes scheduled bucket existence checks.',
      holdingsQueries:
        'SELECT statements mentioning trading_accounts/cash_wallets/positions/assets; includes scope-validation relation reads.',
      lockHeldMs:
        'FOR UPDATE response to COMMIT response on the same connection; uncontended isolated local database.',
      historyMaxRowsPerQuery:
        'Maximum driver rows returned by a history query, not process peak memory.',
      outputHash:
        'SHA256 of normalized persisted rankings and participant current values; entity IDs replaced by fixture ordinals.',
      sqlElapsedMs:
        'Sum of driver query durations; concurrent query durations overlap and are not an additive wall-time breakdown.',
    },
    results,
  };
  try {
    assert.equal(
      await db.season.count(),
      0,
      'Benchmark database must be empty.',
    );
    assert.equal(
      await db.fxRateSnapshot.count(),
      0,
      'Benchmark FX source table must be empty.',
    );
    for (const shape of shapes) {
      process.stdout.write(`Seeding P=${shape.p} K=${shape.k} H=${shape.h}\n`);
      const fixture = await seed(shape);
      for (const mode of modes) {
        await measure(fixture, mode); // Same cold/warm-up policy before both code versions.
        const measured: Awaited<ReturnType<typeof measure>>[] = [];
        for (let sample = 0; sample < samples; sample++)
          measured.push(await measure(fixture, mode));
        assert.equal(
          new Set(measured.map((sample) => sample.outputHash)).size,
          1,
          'Repeated fixture output must be deterministic.',
        );
        results.push({ shape, mode, samples: measured });
        process.stdout.write(
          `${shape.p}/${shape.k}/${shape.h} ${mode}: ${measured.map((sample) => sample.wallMs.toFixed(1)).join(',')} ms; SQL ${measured[0].sqlStatements}; history rows ${measured[0].historyRowsRead}\n`,
        );
        if (process.env.RANKING_BENCHMARK_OUTPUT)
          writeFileSync(
            process.env.RANKING_BENCHMARK_OUTPUT,
            JSON.stringify(report, null, 2) + '\n',
          );
      }
      await cleanup();
      for (const group of Object.values(ids)) group.length = 0;
    }
    if (!process.env.RANKING_BENCHMARK_OUTPUT)
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    try {
      await cleanup();
    } finally {
      await db.$disconnect();
      Client.prototype.query = originalQuery;
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
