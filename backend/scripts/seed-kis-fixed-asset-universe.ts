import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { KIS_FIXED_ASSET_UNIVERSE } from '../src/providers/kis/kis-fixed-asset-universe';
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
 * Seed the fixed 40-symbol KIS stock universe (15 domestic + 25 US) into
 * `assets`. Additive and idempotent: creates missing rows and refreshes the
 * contract fields (name/currencies/assetType/isActive) on existing rows without
 * touching prices, orders, positions, or the symbol list itself.
 *
 * Default run applies; `--dry-run` prints the plan without writing. Env is
 * loaded like the backend so it targets the same DB.
 */

export function buildKisDesiredUniverse(): AssetUniverseDesired[] {
  return KIS_FIXED_ASSET_UNIVERSE.map((entry) => ({
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
}): Promise<AssetUniverseApplyResult> {
  return applyAssetUniverse({
    prisma: input.prisma,
    desired: buildKisDesiredUniverse(),
    apply: input.apply,
  });
}

export async function runSeedKisFixedAssetUniverse(argv: string[]) {
  const dryRun = argv.includes('--dry-run');
  loadRuntimeEnv();

  const adapter = new PrismaPg({ connectionString: requireDatabaseUrl() });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log(`Target DB: ${formatDatabaseTarget(process.env.DATABASE_URL)}`);
    const result = await seedKisFixedAssetUniverse({ prisma, apply: !dryRun });
    for (const line of describeAssetUniverseResult(
      'KIS fixed asset universe',
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
