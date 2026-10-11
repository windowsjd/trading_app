import type {
  Asset,
  FuturesInstrument,
  Prisma,
} from '../../src/generated/prisma/client';
import {
  BINANCE_FUTURES_SYMBOLS,
  BINANCE_FUTURES_ONLY_ASSETS,
  isOfferedFuturesSymbol,
} from '../../src/providers/binance/binance-product-catalog';
import { FUTURES_COVERAGE_MAX_AGE_MS } from '../../src/futures/futures-instrument-coverage';

export function futuresProvisionPlan(
  assets: Asset[],
  instruments: FuturesInstrument[],
  contracts: Map<string, Prisma.InputJsonObject>,
  now: Date,
) {
  const blockers: string[] = [];
  const createAssets: (typeof BINANCE_FUTURES_ONLY_ASSETS)[number][] = [];
  const createInstruments: string[] = [];
  const updateInstruments: string[] = [];
  const keepInstruments: string[] = [];
  const assetBySymbol = new Map(assets.map((asset) => [asset.symbol, asset]));
  for (const symbol of BINANCE_FUTURES_SYMBOLS) {
    const contract = contracts.get(symbol);
    if (!contract)
      blockers.push(`${symbol}: exact TRADING COIN USDT perpetual unavailable`);
    const asset = assetBySymbol.get(symbol);
    if (!asset) {
      const exclusive = BINANCE_FUTURES_ONLY_ASSETS.find(
        (row) => row.symbol === symbol,
      );
      if (exclusive) createAssets.push(exclusive);
      else blockers.push(`${symbol}: existing Spot underlying required`);
      createInstruments.push(symbol);
      continue;
    }
    if (
      !asset.isActive ||
      asset.market !== 'BINANCE' ||
      asset.assetType !== 'crypto' ||
      asset.currencyCode !== 'USD' ||
      asset.priceCurrency !== 'USD' ||
      asset.settlementCurrency !== 'USD'
    )
      blockers.push(`${symbol}: underlying operational identity conflict`);
    const instrument = instruments.find(
      (row) =>
        row.underlyingAssetId === asset.id &&
        row.productType === 'synthetic_perpetual' &&
        row.settlementCurrency === 'USD',
    );
    if (!instrument) {
      createInstruments.push(symbol);
      continue;
    }
    if (!instrument.isActive)
      blockers.push(`${symbol}: inactive instrument requires separate review`);
    const saved = instrument.markContractJson;
    const sameContract =
      contract &&
      saved &&
      typeof saved === 'object' &&
      !Array.isArray(saved) &&
      Object.entries(contract).every(([key, value]) => saved[key] === value);
    if (
      !sameContract ||
      !instrument.markVerifiedAt ||
      instrument.markVerifiedAt > now ||
      +now - +instrument.markVerifiedAt > FUTURES_COVERAGE_MAX_AGE_MS
    )
      updateInstruments.push(symbol);
    else keepInstruments.push(symbol);
  }
  return {
    symbols: [...BINANCE_FUTURES_SYMBOLS],
    blockers,
    createAssets,
    createInstruments,
    updateInstruments,
    keepInstruments,
    counts: {
      assets: {
        create: createAssets.length,
        maintain: BINANCE_FUTURES_SYMBOLS.filter((symbol) =>
          assetBySymbol.has(symbol),
        ).length,
        change: 0,
      },
      instruments: {
        create: createInstruments.length,
        maintain: keepInstruments.length,
        change: updateInstruments.length,
      },
    },
    outsideCatalog: instruments
      .filter(
        (row) =>
          !isOfferedFuturesSymbol(
            assets.find((asset) => asset.id === row.underlyingAssetId)
              ?.symbol ?? '',
          ),
      )
      .map((row) => ({
        id: row.id,
        underlyingAssetId: row.underlyingAssetId,
        symbol:
          assets.find((asset) => asset.id === row.underlyingAssetId)?.symbol ??
          null,
        action: 'retain_financial_history_and_open_lifetime_pricing',
      })),
  };
}
