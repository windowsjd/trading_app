/**
 * Seed and inspect the stored 5-minute candle BASELINE that the 15m/30m/1h/4h
 * charts are aggregated from.
 *
 * This is a thin operator wrapper around the existing checkpointed
 * `MarketCandleSyncService.syncAssets` (the same code path the Ops
 * `market_candle_sync` job runs) plus the existing coverage repository — no
 * sync, page, lock or coverage logic is duplicated here.
 *
 * Usage (from backend/):
 *   # what does the store already cover?
 *   pnpm exec tsx scripts/candle-baseline-sync.ts --report
 *
 *   # plan only, no provider calls and no writes
 *   pnpm exec tsx scripts/candle-baseline-sync.ts --dry-run
 *
 *   # seed the 35-day 5m baseline for every active asset (resumable)
 *   pnpm exec tsx scripts/candle-baseline-sync.ts --apply
 *
 *   # keep the tail fresh afterwards (cheap; run on a schedule)
 *   pnpm exec tsx scripts/candle-baseline-sync.ts --apply --mode incremental
 *
 * Flags:
 *   --report                 coverage report only (no provider calls)
 *   --apply | --dry-run      run for real / plan only (default: --dry-run)
 *   --mode initial|incremental|repair   default: initial
 *   --days N                 baseline window, default 35 (the 5m retention)
 *   --asset-type domestic_stock|us_stock|crypto   repeatable
 *   --asset-id <uuid>        repeatable; overrides --asset-type
 *   --max-assets N           process at most N assets
 *   --no-resume              start fresh instead of resuming a checkpoint
 *
 * `--report` needs PostgreSQL only. The sync paths boot the application
 * context, so they additionally need Redis (backfill locks) and the real
 * provider credentials (KIS for stocks, Binance for crypto) — the same
 * requirements the Ops job has. Nothing is printed except aggregate counters
 * and coverage timestamps; no credential or provider payload is logged.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Module } from '@nestjs/common';

import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';

loadRuntimeEnv();

import { AssetsModule } from '../src/assets/assets.module';
import { PrismaModule } from '../src/prisma/prisma.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { MarketCandleSyncService } from '../src/assets/market-candle-sync.service';
import { MarketCandleSyncStateRepository } from '../src/assets/market-candle-sync-state.repository';
import {
  MarketCandleSyncMode,
  AssetType,
} from '../src/generated/prisma/client';

const DAY_MS = 24 * 60 * 60_000;
const DEFAULT_BASELINE_DAYS = 35;

@Module({ imports: [PrismaModule, AssetsModule] })
class CandleBaselineSyncModule {}

type Args = {
  report: boolean;
  apply: boolean;
  mode: MarketCandleSyncMode;
  days: number;
  assetTypes: AssetType[];
  assetIds: string[];
  maxAssets?: number;
  resume: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    report: false,
    apply: false,
    mode: MarketCandleSyncMode.initial,
    days: DEFAULT_BASELINE_DAYS,
    assetTypes: [],
    assetIds: [],
    resume: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--report':
        args.report = true;
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--dry-run':
        args.apply = false;
        break;
      case '--no-resume':
        args.resume = false;
        break;
      case '--mode':
        if (
          value !== 'initial' &&
          value !== 'incremental' &&
          value !== 'repair'
        ) {
          throw new Error('--mode must be initial, incremental, or repair.');
        }
        args.mode = value as MarketCandleSyncMode;
        index += 1;
        break;
      case '--days': {
        const days = Number(value);
        if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
          throw new Error('--days must be an integer between 1 and 365.');
        }
        args.days = days;
        index += 1;
        break;
      }
      case '--asset-type':
        if (
          value !== 'domestic_stock' &&
          value !== 'us_stock' &&
          value !== 'crypto'
        ) {
          throw new Error(
            '--asset-type must be domestic_stock, us_stock, or crypto.',
          );
        }
        args.assetTypes.push(value as AssetType);
        index += 1;
        break;
      case '--asset-id':
        if (!value) throw new Error('--asset-id requires a value.');
        args.assetIds.push(value);
        index += 1;
        break;
      case '--max-assets': {
        const max = Number(value);
        if (!Number.isSafeInteger(max) || max < 1) {
          throw new Error('--max-assets must be a positive integer.');
        }
        args.maxAssets = max;
        index += 1;
        break;
      }
      default:
        if (flag.startsWith('--')) throw new Error(`Unknown flag ${flag}.`);
    }
  }
  return args;
}

function iso(value: Date | null | undefined): string {
  return value ? value.toISOString() : '-';
}

async function report(
  prisma: PrismaService,
  states: MarketCandleSyncStateRepository,
  args: Args,
  now: Date,
): Promise<number> {
  const from = new Date(now.getTime() - args.days * DAY_MS);
  const assets = await prisma.asset.findMany({
    where: {
      isActive: true,
      ...(args.assetIds.length ? { id: { in: args.assetIds } } : {}),
      ...(args.assetTypes.length ? { assetType: { in: args.assetTypes } } : {}),
    },
    orderBy: [{ assetType: 'asc' }, { symbol: 'asc' }],
    select: { id: true, symbol: true, assetType: true },
    ...(args.maxAssets ? { take: args.maxAssets } : {}),
  });

  let ready = 0;
  console.log(
    `5m baseline coverage for ${assets.length} active asset(s), window ${iso(from)} → ${iso(now)}`,
  );
  for (const asset of assets) {
    // Same evidence the serving path uses (union of coverage-audited runs).
    const coverage = await states.findCompletedCoverageUnion(
      asset.id,
      '5m',
      from,
      now,
    );
    if (coverage.covered) ready += 1;
    console.log(
      [
        coverage.covered ? 'READY   ' : 'MISSING ',
        asset.assetType.padEnd(15),
        asset.symbol.padEnd(10),
        `lastCompletedAt=${iso(coverage.newestCompletedAt)}`,
      ].join(' '),
    );
  }
  console.log(
    `\n${ready}/${assets.length} asset(s) can serve 15m/30m/1h/4h charts from the database for this window.`,
  );
  return assets.length === 0 || ready === assets.length ? 0 : 1;
}

/**
 * The coverage report only needs PostgreSQL, so it runs without booting the
 * application context (which also wires Redis, the provider clients and the
 * live-candle pipeline). Operators can therefore check readiness on a machine
 * that has nothing but the database.
 */
async function runReport(args: Args): Promise<number> {
  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    return await report(
      prisma,
      new MarketCandleSyncStateRepository(prisma),
      args,
      new Date(),
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  requireDatabaseUrl();
  console.log(`database: ${formatDatabaseTarget(process.env.DATABASE_URL)}`);

  if (args.report) return runReport(args);

  // Syncing runs the real thing: provider clients, Redis backfill locks and
  // the checkpointed sync service, exactly as the Ops job does.
  const app = await NestFactory.createApplicationContext(
    CandleBaselineSyncModule,
    { logger: ['error', 'warn'] },
  );
  try {
    const now = new Date();
    const from = new Date(now.getTime() - args.days * DAY_MS);
    console.log(
      `mode=${args.mode} dryRun=${!args.apply} window=${iso(from)} → ${iso(now)} feed=5m`,
    );
    const summary = await app.get(MarketCandleSyncService).syncAssets({
      targets: ['5m'],
      mode: args.mode,
      // incremental resolves its own start from the newest stored candle; an
      // explicit from/to is what makes initial/repair cover the baseline.
      ...(args.mode === MarketCandleSyncMode.incremental
        ? {}
        : { from, to: now }),
      activeOnly: true,
      resume: args.resume,
      dryRun: !args.apply,
      ...(args.assetIds.length ? { assetIds: args.assetIds } : {}),
      ...(args.assetTypes.length ? { assetTypes: args.assetTypes } : {}),
      ...(args.maxAssets ? { maxAssets: args.maxAssets } : {}),
      now,
    });

    for (const asset of summary.assets) {
      for (const feed of asset.feeds) {
        console.log(
          [
            feed.coverageComplete ? 'COVERED ' : 'PARTIAL ',
            asset.symbol.padEnd(10),
            `status=${feed.status}`,
            `stop=${feed.stopReason}`,
            `rows=${feed.writtenRows}`,
            `covered=[${iso(feed.coveredFrom)}, ${iso(feed.coveredTo)})`,
            feed.errorCode ? `error=${feed.errorCode}` : '',
          ].join(' '),
        );
      }
    }
    console.log(
      `\nassets=${summary.processedAssets}/${summary.requestedAssets} feeds=${summary.totalFeeds} ` +
        `coverageComplete=${summary.coverageCompleteFeeds} ` +
        `completedWithIncompleteCoverage=${summary.completedWithIncompleteCoverageFeeds} ` +
        `failed=${summary.failedFeeds}`,
    );
    if (!args.apply) {
      console.log('dry run: no provider call and no write happened.');
    }
    return summary.failedFeeds > 0 ? 1 : 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
