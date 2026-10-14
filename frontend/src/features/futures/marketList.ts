import Decimal from 'decimal.js';
import type { MarketAssetItemDto } from '../market/api';
import { marketSortParams, type MarketSort } from '../market/marketSort.ts';
import type { FuturesInstrument } from './api';

/** The market label shown beside a contract symbol in the list. */
export const FUTURES_MARKET_LABEL = 'USDⓈ-M 무기한';

function metric(instrument: FuturesInstrument, criterion: 'turnover' | 'changeRate'): Decimal | null {
  const stats = instrument.marketStats;
  if (stats?.state !== 'available') return null;
  const raw = criterion === 'turnover' ? stats.quoteVolume : stats.priceChangePercent;
  try {
    const value = new Decimal(raw);
    return value.isFinite() ? value : null;
  } catch {
    return null;
  }
}

function compareText(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Spot list ordering applied to contracts: turnover = 24h quote volume,
 * change = 24h price change percent of the contract. Unavailable values sort
 * last in both directions; ties fall back to symbol, then id.
 */
export function sortFuturesMarket(
  instruments: readonly FuturesInstrument[],
  sort: MarketSort,
): FuturesInstrument[] {
  const { sortBy, sortOrder } = marketSortParams(sort);
  const direction = sortOrder === 'asc' ? 1 : -1;
  return [...instruments].sort((a, b) => {
    const left = metric(a, sortBy);
    const right = metric(b, sortBy);
    if (left === null && right !== null) return 1;
    if (left !== null && right === null) return -1;
    if (left !== null && right !== null) {
      const order = left.cmp(right) * direction;
      if (order !== 0) return order;
    }
    return compareText(a.underlying.symbol, b.underlying.symbol) || compareText(a.id, b.id);
  });
}

/**
 * The Spot row's display model for one contract: price = Futures Last
 * (`referencePrice`), change = the contract's own 24h change. Without a Last
 * price the row shows the Spot "시세 확인 불가" state; a change never stands in
 * for a missing price.
 */
export function futuresMarketRow(instrument: FuturesInstrument): MarketAssetItemDto {
  const stats = instrument.marketStats?.state === 'available' ? instrument.marketStats : null;
  const last = instrument.referencePrice ?? null;
  return {
    id: instrument.id,
    assetType: 'crypto',
    symbol: instrument.underlying.symbol,
    name: instrument.underlying.name,
    market: FUTURES_MARKET_LABEL,
    priceCurrency: 'USD',
    settlementCurrency: 'USD',
    displayPriceDecimals: instrument.underlying.displayPriceDecimals,
    isActive: instrument.isActive,
    marketStatus: 'always_open',
    tradable: true,
    tradeBlockedReason: null,
    turnover: stats?.quoteVolume ?? null,
    turnoverPeriod: stats ? 'rolling_24h' : null,
    price: last
      ? { state: 'available', currentPrice: last, priceCurrency: 'USD', changeRate: stats?.priceChangePercent ?? null }
      : { state: 'unavailable', currentPrice: null, priceCurrency: 'USD', changeRate: null },
  };
}
