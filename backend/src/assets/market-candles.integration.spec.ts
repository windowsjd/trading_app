import { spawnSync } from 'node:child_process';

const RUN_MARKET_CANDLES_DB_SMOKE = process.env.MARKET_CANDLES_DB_SMOKE === '1';
const itDbIntegration = RUN_MARKET_CANDLES_DB_SMOKE ? it : it.skip;

describe('MarketCandlesRepository DB smoke', () => {
  itDbIntegration(
    'verifies idempotent upsert, half-open range reads, latest lookup, and closed-only retention deletes against PostgreSQL',
    () => {
      runDbIntegrationPrepare();

      const result = spawnSync(
        getPnpmCommand(),
        ['exec', 'tsx', '-e', MARKET_CANDLES_DB_SMOKE_RUNNER],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Market candles DB smoke runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('market candles db smoke ok');
    },
    130_000,
  );
});

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function runDbIntegrationPrepare() {
  const result = spawnSync(getPnpmCommand(), ['run', 'test:db:prepare'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 60_000,
  });

  if (result.status !== 0) {
    throw new Error(
      [
        'Market candles DB integration prepare failed.',
        'The opt-in test applies existing Prisma migrations with `prisma migrate deploy` only; it does not reset, drop, or seed the database.',
        'stdout:',
        result.stdout,
        'stderr:',
        result.stderr,
      ].join('\n'),
    );
  }
}

const MARKET_CANDLES_DB_SMOKE_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AssetType, CurrencyCode } from './src/generated/prisma/client';
import { PrismaService } from './src/prisma/prisma.service';
import {
  MarketCandlesRepository,
  MarketCandleUpsertInput,
  MarketCandleValidationError,
} from './src/assets/market-candles.repository';

const TEST_MARKET = 'MARKET-CANDLES-SMOKE';
const TEST_SYMBOL = 'MC' + Date.now().toString(36).toUpperCase();
const prisma = new PrismaService();
const repository = new MarketCandlesRepository(prisma);
let assetId = '';

function minute(m: number): Date {
  return new Date(Date.UTC(2026, 6, 1, 0, m));
}

function candleInput(
  overrides: Partial<MarketCandleUpsertInput> = {},
): MarketCandleUpsertInput {
  return {
    assetId,
    interval: '5m',
    openTime: minute(0),
    closeTime: minute(5),
    open: '100',
    high: '110',
    low: '95',
    close: '105',
    volume: '10',
    amount: '1000',
    isClosed: true,
    sourceProvider: 'smoke-test',
    sourceUpdatedAt: minute(6),
    ...overrides,
  };
}

async function main() {
  await prisma.$connect();

  try {
    await cleanup();
    const asset = await prisma.asset.create({
      data: {
        symbol: TEST_SYMBOL,
        name: 'Market Candles Smoke Asset',
        market: TEST_MARKET,
        currencyCode: CurrencyCode.USD,
        priceCurrency: CurrencyCode.USD,
        settlementCurrency: CurrencyCode.USD,
        assetType: AssetType.crypto,
      },
    });
    assetId = asset.id;

    await runIdempotentUpsert();
    await runBatchDuplicateLastWins();
    await runHalfOpenRangeAndLimit();
    await runFindLatestAndClosedOnly();
    await runRetentionDelete();
    await runUnknownAssetRejection();
    await runInvalidInputRejection();
    console.log('market candles db smoke ok');
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

async function runIdempotentUpsert() {
  const batch = [
    candleInput(),
    candleInput({ openTime: minute(5), closeTime: minute(10) }),
    candleInput({ openTime: minute(10), closeTime: minute(15) }),
  ];

  await repository.upsertMany(batch);
  const first = await repository.findRange({
    assetId,
    interval: '5m',
    from: minute(0),
    to: minute(60),
  });
  assert.equal(first.length, 3);
  assert.deepEqual(
    first.map((row) => row.openTime.getTime()),
    [minute(0).getTime(), minute(5).getTime(), minute(10).getTime()],
  );
  assert.equal(String(first[0].close), '105');

  const rewritten = batch.map((candle) => ({
    ...candle,
    close: '107',
    sourceProvider: 'smoke-test-2',
  }));
  await repository.upsertMany(rewritten);
  const second = await repository.findRange({
    assetId,
    interval: '5m',
    from: minute(0),
    to: minute(60),
  });
  assert.equal(second.length, 3, 'idempotent re-upsert must not add rows');
  assert.deepEqual(
    second.map((row) => row.id).sort(),
    first.map((row) => row.id).sort(),
    'row ids must be preserved on upsert',
  );
  assert.deepEqual(
    second.map((row) => row.createdAt.getTime()),
    first.map((row) => row.createdAt.getTime()),
    'createdAt must be preserved on upsert',
  );
  assert.equal(String(second[0].close), '107');
  assert.equal(second[0].sourceProvider, 'smoke-test-2');
}

async function runBatchDuplicateLastWins() {
  await repository.upsertMany([
    candleInput({ openTime: minute(15), closeTime: minute(20), close: '101' }),
    candleInput({ openTime: minute(15), closeTime: minute(20), close: '102' }),
  ]);

  const rows = await repository.findRange({
    assetId,
    interval: '5m',
    from: minute(15),
    to: minute(20),
  });
  assert.equal(rows.length, 1, 'duplicate keys in one batch must produce one row');
  assert.equal(String(rows[0].close), '102', 'last duplicate in batch must win');
}

async function runHalfOpenRangeAndLimit() {
  const halfOpen = await repository.findRange({
    assetId,
    interval: '5m',
    from: minute(5),
    to: minute(15),
  });
  assert.deepEqual(
    halfOpen.map((row) => row.openTime.getTime()),
    [minute(5).getTime(), minute(10).getTime()],
    'findRange must include from and exclude to',
  );

  const limited = await repository.findRange({
    assetId,
    interval: '5m',
    from: minute(0),
    to: minute(60),
    limit: 2,
  });
  assert.deepEqual(
    limited.map((row) => row.openTime.getTime()),
    [minute(10).getTime(), minute(15).getTime()],
    'limit must keep the latest candles in ascending order',
  );
}

async function runFindLatestAndClosedOnly() {
  await repository.upsertMany([
    candleInput({
      openTime: minute(20),
      closeTime: minute(25),
      close: '108',
      isClosed: false,
    }),
  ]);

  const latest = await repository.findLatest({ assetId, interval: '5m' });
  assert.equal(latest?.openTime.getTime(), minute(20).getTime());
  assert.equal(latest?.isClosed, false, 'findLatest must include open candles');

  const latestClosed = await repository.findLatest({
    assetId,
    interval: '5m',
    closedOnly: true,
  });
  assert.equal(latestClosed?.openTime.getTime(), minute(15).getTime());
  assert.equal(latestClosed?.isClosed, true);

  const missing = await repository.findLatest({ assetId, interval: '1w' });
  assert.equal(missing, null);
}

async function runRetentionDelete() {
  await repository.upsertMany([
    candleInput({ openTime: minute(60), closeTime: minute(65) }),
  ]);

  const deleted = await repository.deleteClosedBefore({
    cutoff: minute(60),
    intervals: ['5m'],
    assetId,
  });
  assert.equal(
    deleted.deletedCount,
    4,
    'only closed candles strictly before the cutoff may be deleted',
  );

  const remaining = await repository.findRange({
    assetId,
    interval: '5m',
    from: minute(0),
    to: minute(120),
  });
  assert.deepEqual(
    remaining.map((row) => [row.openTime.getTime(), row.isClosed]),
    [
      [minute(20).getTime(), false],
      [minute(60).getTime(), true],
    ],
    'old open candles and candles at/after the cutoff must survive',
  );

  const coverage = await repository.getCoverage(assetId, '5m');
  assert.equal(coverage.earliestOpenTime?.getTime(), minute(20).getTime());
  assert.equal(coverage.latestOpenTime?.getTime(), minute(60).getTime());
  assert.equal(coverage.count, 2);
}

async function runUnknownAssetRejection() {
  await assert.rejects(
    repository.upsertMany([candleInput({ assetId: randomUUID() })]),
    (error: unknown) => error instanceof MarketCandleValidationError,
    'unknown assetId must be rejected before bulk SQL execution',
  );

  const coverage = await repository.getCoverage(assetId, '5m');
  assert.equal(coverage.count, 2, 'failed upsert must not write rows');
}

async function runInvalidInputRejection() {
  await assert.rejects(
    repository.upsertMany([candleInput({ interval: '15m' as never })]),
    (error: unknown) => error instanceof MarketCandleValidationError,
  );
  await assert.rejects(
    repository.upsertMany([
      candleInput({ openTime: minute(5), closeTime: minute(5) }),
    ]),
    (error: unknown) => error instanceof MarketCandleValidationError,
  );
  await assert.rejects(
    repository.upsertMany([candleInput({ volume: '-1' })]),
    (error: unknown) => error instanceof MarketCandleValidationError,
  );
}

async function cleanup() {
  await prisma.marketCandle.deleteMany({
    where: {
      asset: {
        market: TEST_MARKET,
      },
    },
  });
  await prisma.asset.deleteMany({
    where: {
      market: TEST_MARKET,
    },
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
