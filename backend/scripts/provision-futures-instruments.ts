import { loadRuntimeEnv } from './lib/load-runtime-env';
import { PrismaService } from '../src/prisma/prisma.service';

loadRuntimeEnv();
const apply = process.argv.includes('--apply');
const unknown = process.argv.slice(2).filter((arg) => arg !== '--apply');
if (unknown.length)
  throw new Error('Usage: pnpm futures:provision-instruments [--apply]');
const db = new PrismaService();
async function main() {
  const assets = await db.asset.findMany({
    where: {
      isActive: true,
      assetType: 'crypto',
      market: 'BINANCE',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
      futuresInstruments: {
        none: { productType: 'synthetic_perpetual', settlementCurrency: 'USD' },
      },
    },
    select: { id: true, symbol: true },
    orderBy: { id: 'asc' },
  });
  console.log(
    JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      missingInstruments: assets,
    }),
  );
  if (apply && assets.length) {
    const result = await db.futuresInstrument.createMany({
      data: assets.map((asset) => ({
        underlyingAssetId: asset.id,
        productType: 'synthetic_perpetual',
        settlementCurrency: 'USD',
      })),
      skipDuplicates: true,
    });
    console.log(JSON.stringify({ created: result.count }));
  }
}
main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
