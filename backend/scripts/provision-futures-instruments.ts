import {
  FUTURES_COVERAGE_MAX_AGE_MS,
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

/** Which database this run reads/writes, without credentials. */
function target() {
  try {
    const url = new URL(process.env.DATABASE_URL ?? '');
    return `${url.hostname}:${url.port || '5432'}/${url.pathname.slice(1)}`;
  } catch {
    return 'unparseable DATABASE_URL';
  }
}

/** Why no exact USDⓈ-M USDT perpetual is accepted for this Spot symbol. */
function exclusion(symbol: string, rows: Array<Record<string, unknown>>) {
  if (!/^[A-Z0-9]+USDT$/.test(symbol)) return 'symbol_identity_unsupported';
  const exact = rows.find((row) => row.symbol === symbol);
  if (!exact) {
    const base = symbol.slice(0, -4);
    return rows.some(
      (row) =>
        typeof row.symbol === 'string' &&
        /^1\d*0+[A-Z]/.test(row.symbol) &&
        row.symbol.endsWith(`${base}USDT`),
    )
      ? 'only_multiplier_contract'
      : 'no_usdm_contract';
  }
  if (exact.contractType !== 'PERPETUAL') return 'not_perpetual';
  if (exact.status !== 'TRADING') return `contract_${String(exact.status)}`;
  return 'contract_identity_mismatch';
}

async function main() {
  const { json } = await httpClient.getJson<unknown>(
    FUTURES_EXCHANGE_INFO_URL,
    { provider: 'binance', timeoutMs: 5000 },
  );
  const contracts = parseFuturesContracts(json);
  const rows = (
    json && typeof json === 'object' && 'symbols' in json
      ? (json as { symbols: unknown[] }).symbols
      : []
  ).filter(
    (row): row is Record<string, unknown> => !!row && typeof row === 'object',
  );
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
  // Report-only reads: existing rows are never repaired, re-verified or reactivated here.
  const existing = await db.futuresInstrument.findMany({
    include: { underlyingAsset: true },
    orderBy: { id: 'asc' },
  });
  const ineligibleAssets = await db.asset.findMany({
    where: {
      market: 'BINANCE',
      futuresInstruments: { none: {} },
      NOT: {
        isActive: true,
        assetType: 'crypto',
        currencyCode: 'USD',
        priceCurrency: 'USD',
        settlementCurrency: 'USD',
      },
    },
    select: { symbol: true, isActive: true, assetType: true },
    orderBy: { symbol: 'asc' },
  });
  const assets = candidates.filter((asset) => contracts.has(asset.symbol));
  const unsupported = candidates.filter(
    (asset) => !contracts.has(asset.symbol),
  );
  console.log(
    JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      database: target(),
      evaluatedAt: verifiedAt.toISOString(),
      missingInstruments: assets,
      unsupportedSymbols: unsupported.map((asset) => asset.symbol),
      unsupported: unsupported.map((asset) => ({
        symbol: asset.symbol,
        reason: exclusion(asset.symbol, rows),
      })),
      existingInstruments: existing.map((row) => ({
        instrumentId: row.id,
        symbol: row.underlyingAsset.symbol,
        isActive: row.isActive && row.underlyingAsset.isActive,
        contractListed: contracts.has(row.underlyingAsset.symbol),
        coverage: !row.markVerifiedAt
          ? 'unverified'
          : +verifiedAt - +row.markVerifiedAt > FUTURES_COVERAGE_MAX_AGE_MS
            ? 'expired'
            : 'verified',
        markVerifiedAt: row.markVerifiedAt?.toISOString() ?? null,
      })),
      ineligibleAssets: ineligibleAssets.map((asset) => ({
        symbol: asset.symbol,
        reason: !asset.isActive
          ? 'asset_inactive'
          : asset.assetType !== 'crypto'
            ? 'not_crypto'
            : 'not_usd_priced_and_settled',
      })),
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
