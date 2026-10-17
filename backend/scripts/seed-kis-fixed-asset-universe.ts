import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import {
  KIS_FIXED_ASSET_UNIVERSE,
  RETIRED_FIXED_ASSETS,
} from '../src/providers/kis/kis-fixed-asset-universe';
import {
  formatDatabaseTarget,
  loadRuntimeEnv,
  requireDatabaseUrl,
} from './lib/load-runtime-env';
import {
  type AssetUniverseApplyResult,
  applyAssetUniverse,
  describeAssetUniverseResult,
} from './lib/asset-universe-apply';
import type { AssetUniverseDesired } from './lib/asset-universe-upsert';

/**
 * Seed the fixed stock universe (70 domestic + 100 US since the 2026-10-17
 * expansion; `kis-fixed-asset-universe.ts`) into `assets`. Additive and idempotent: creates missing rows and refreshes the
 * contract fields (name/currencies/assetType/isActive) on existing rows without
 * touching prices, orders, positions, or the symbol list itself.
 *
 * Retired members (`RETIRED_FIXED_ASSETS`, e.g. the delisted WBD) are only
 * deactivated: their rows, Asset IDs and history stay, and a rerun keeps them
 * inactive.
 *
 * Default run applies; `--dry-run` prints the plan without writing. Env is
 * loaded like the backend so it targets the same DB.
 *
 * `--us-only` (2026-10-17) scopes the plan to the US stocks — the Tiingo
 * official universe — e.g. `--dry-run --us-only` to check that every one is
 * registered, active and listed on NAS/NYS before switching their provider.
 * Applying it against a production database is an approved operator step.
 */

export function buildKisDesiredUniverse(
  options: { usOnly?: boolean } = {},
): AssetUniverseDesired[] {
  return KIS_FIXED_ASSET_UNIVERSE.filter(
    (entry) => !options.usOnly || entry.assetType === 'us_stock',
  ).map((entry) => ({
    symbol: entry.symbol,
    name: entry.name,
    market: entry.market,
    assetType: entry.assetType,
    currencyCode: entry.currencyCode,
    priceCurrency: entry.currencyCode,
    settlementCurrency: entry.currencyCode,
  }));
}

export async function seedKisFixedAssetUniverse(input: {
  prisma: PrismaClient;
  apply: boolean;
  usOnly?: boolean;
}): Promise<AssetUniverseApplyResult> {
  return applyAssetUniverse({
    prisma: input.prisma,
    desired: buildKisDesiredUniverse({ usOnly: input.usOnly }),
    apply: input.apply,
    retired: RETIRED_FIXED_ASSETS.filter(
      (entry) => !input.usOnly || entry.assetType === 'us_stock',
    ),
  });
}

export async function runSeedKisFixedAssetUniverse(argv: string[]) {
  const dryRun = argv.includes('--dry-run');
  const usOnly = argv.includes('--us-only');
  loadRuntimeEnv();

  const adapter = new PrismaPg({ connectionString: requireDatabaseUrl() });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log(`Target DB: ${formatDatabaseTarget(process.env.DATABASE_URL)}`);
    const result = await seedKisFixedAssetUniverse({
      prisma,
      apply: !dryRun,
      usOnly,
    });
    for (const line of describeAssetUniverseResult(
      usOnly
        ? `US stock universe (${result.counts.total})`
        : 'KIS fixed asset universe',
      result,
    )) {
      console.log(line);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  runSeedKisFixedAssetUniverse(process.argv.slice(2)).catch(
    (error: unknown) => {
      process.exitCode = 1;

      if (error instanceof Error) {
        console.error(`KIS fixed asset universe seed failed: ${error.message}`);
        return;
      }

      console.error('KIS fixed asset universe seed failed.');
    },
  );
}
