import { isOfferedFuturesSymbol } from '../providers/binance/binance-product-catalog';
import type { Prisma } from '../generated/prisma/client';
import type { InstrumentWithAsset } from './futures.presenter';
import {
  parseTickSizeDisplayDecimals,
  readPriceFilterTickSize,
} from '../providers/binance/binance-tick-size';

export const FUTURES_EXCHANGE_INFO_URL =
  'https://fapi.binance.com/fapi/v1/exchangeInfo';
export const FUTURES_COVERAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Exact 1:1 contract mapping only. No 1000-token substitutions or non-crypto perps. */
export function parseFuturesContracts(
  payload: unknown,
): Map<string, Prisma.InputJsonObject> {
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('symbols' in payload) ||
    !Array.isArray(payload.symbols)
  )
    // @diagnosticSurface internal: Coverage parser is caught by the ingestion cycle and reports FUTURES_COVERAGE_UNAVAILABLE.
    throw new Error('FUTURES_COVERAGE_INVALID');
  const contracts = new Map<string, Prisma.InputJsonObject>();
  for (const row of payload.symbols as unknown[]) {
    if (!row || typeof row !== 'object') continue;
    const p = row as Record<string, unknown>;
    if (
      typeof p.symbol !== 'string' ||
      !/^[A-Z0-9]+USDT$/.test(p.symbol) ||
      typeof p.baseAsset !== 'string' ||
      p.symbol !== `${p.baseAsset}USDT` ||
      p.pair !== p.symbol ||
      p.contractType !== 'PERPETUAL' ||
      p.status !== 'TRADING' ||
      p.quoteAsset !== 'USDT' ||
      p.marginAsset !== 'USDT' ||
      p.underlyingType !== 'COIN'
    )
      continue;
    const tickSize = readPriceFilterTickSize(p) ?? p.priceTickSize;
    const decimals = parseTickSizeDisplayDecimals(tickSize);
    contracts.set(p.symbol, {
      symbol: p.symbol,
      pair: p.symbol,
      baseAsset: p.baseAsset,
      contractType: 'PERPETUAL',
      status: 'TRADING',
      quoteAsset: 'USDT',
      marginAsset: 'USDT',
      underlyingType: 'COIN',
      ...(typeof tickSize === 'string' && decimals !== null && decimals <= 8
        ? { priceTickSize: tickSize }
        : {}),
    });
  }
  return contracts;
}
export function verifiedFuturesInstrument(
  instrument: InstrumentWithAsset,
  now: Date,
) {
  const asset = instrument.underlyingAsset;
  if (
    !isOfferedFuturesSymbol(asset.symbol) ||
    !instrument.isActive ||
    !asset.isActive ||
    instrument.productType !== 'synthetic_perpetual' ||
    instrument.settlementCurrency !== 'USD' ||
    asset.assetType !== 'crypto' ||
    asset.market !== 'BINANCE' ||
    asset.currencyCode !== 'USD' ||
    asset.priceCurrency !== 'USD' ||
    asset.settlementCurrency !== 'USD' ||
    !instrument.markVerifiedAt ||
    instrument.markVerifiedAt > now ||
    +now - +instrument.markVerifiedAt > FUTURES_COVERAGE_MAX_AGE_MS
  )
    return false;
  return parseFuturesContracts({ symbols: [instrument.markContractJson] }).has(
    asset.symbol,
  );
}
