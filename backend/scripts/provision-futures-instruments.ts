import {
  FUTURES_EXCHANGE_INFO_URL,
  parseFuturesContracts,
} from '../src/futures/futures-instrument-coverage';
import { loadRuntimeEnv } from './lib/load-runtime-env';
import { ProviderHttpClient } from '../src/providers/provider-http.client';
import { PrismaService } from '../src/prisma/prisma.service';

loadRuntimeEnv();
const apply = process.argv.includes('--apply');
const unknown = process.argv.slice(2).filter((arg) => arg !== '--apply');
if (unknown.length)
  throw new Error('Usage: pnpm futures:provision-instruments [--apply]');
const db = new PrismaService();
const httpClient = new ProviderHttpClient();
async function main() {
  const { json } = await httpClient.getJson<unknown>(
    FUTURES_EXCHANGE_INFO_URL,
    { provider: 'binance', timeoutMs: 5000 },
  );
  const contracts = parseFuturesContracts(json);
  const verifiedAt = new Date();
  const candidates = await db.asset.findMany({
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
  const assets = candidates.filter((asset) => contracts.has(asset.symbol));
  console.log(
    JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      missingInstruments: assets,
      unsupportedSymbols: candidates
        .filter((asset) => !contracts.has(asset.symbol))
        .map((asset) => asset.symbol),
    }),
  );
  if (apply && assets.length) {
    const result = await db.futuresInstrument.createMany({
      data: assets.map((asset) => ({
        underlyingAssetId: asset.id,
        productType: 'synthetic_perpetual',
        settlementCurrency: 'USD',
        markContractJson: contracts.get(asset.symbol)!,
        markVerifiedAt: verifiedAt,
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
  .finally(async () => {
    await httpClient.onModuleDestroy();
    await db.$disconnect();
  });
