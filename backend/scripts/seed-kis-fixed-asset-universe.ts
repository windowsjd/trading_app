import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { KIS_FIXED_ASSET_UNIVERSE } from '../src/providers/kis/kis-fixed-asset-universe';

export async function runSeedKisFixedAssetUniverse(argv: string[]) {
  const dryRun = argv.includes('--dry-run');

  if (dryRun) {
    console.log(
      `KIS fixed asset universe dry-run: ${KIS_FIXED_ASSET_UNIVERSE.length} assets would be upserted.`,
    );
    console.log(JSON.stringify(KIS_FIXED_ASSET_UNIVERSE, null, 2));
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }

  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  const prisma = new PrismaClient({ adapter });

  try {
    for (const entry of KIS_FIXED_ASSET_UNIVERSE) {
      const asset = await prisma.asset.upsert({
        where: {
          market_symbol: { market: entry.market, symbol: entry.symbol },
        },
        create: {
          symbol: entry.symbol,
          name: entry.name,
          market: entry.market,
          currencyCode: entry.currencyCode,
          priceCurrency: entry.currencyCode,
          settlementCurrency: entry.currencyCode,
          assetType: entry.assetType,
          isActive: true,
        },
        update: {
          name: entry.name,
          currencyCode: entry.currencyCode,
          priceCurrency: entry.currencyCode,
          settlementCurrency: entry.currencyCode,
          assetType: entry.assetType,
          isActive: true,
        },
        select: { id: true, symbol: true, market: true },
      });
      console.log(`upserted ${asset.market}:${asset.symbol} (${asset.id})`);
    }

    console.log(
      `KIS fixed asset universe seed completed: ${KIS_FIXED_ASSET_UNIVERSE.length} assets.`,
    );
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
