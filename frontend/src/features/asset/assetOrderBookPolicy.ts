import Decimal from 'decimal.js';
import type { AssetDetailAssetDto } from './api';
import { normalizeOrderBook, type AssetOrderBook, type OrderBookLevel } from './orderBook.ts';

export const ORDER_BOOK_STALE_MS = 5_000;
export const ORDER_BOOK_FIRST_SNAPSHOT_TIMEOUT_MS = 10_000;

export function supportsLiveOrderBook(asset: Pick<AssetDetailAssetDto, 'assetType' | 'market' | 'symbol' | 'isActive' | 'priceCurrency'> | undefined): boolean {
  // Server checks the active fixed universe as the authoritative boundary.
  return !!asset && asset.isActive && asset.assetType === 'crypto' &&
    asset.market === 'BINANCE' && asset.priceCurrency === 'USD' && /^[A-Z0-9]{1,32}$/u.test(asset.symbol);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decimal(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 128 && /^\d+(?:\.\d+)?$/u.test(value);
}

function levels(value: unknown): value is OrderBookLevel[] {
  if (!Array.isArray(value) || value.length > 10) return false;
  const prices = new Set<string>();
  return (value as unknown[]).every((entry) => {
    if (!record(entry) || !decimal(entry.price) || !decimal(entry.quantity)) return false;
    const price = new Decimal(entry.price);
    if (!price.gt(0) || prices.has(price.toFixed())) return false;
    prices.add(price.toFixed());
    return true;
  });
}

function time(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT/u.test(value) && Number.isFinite(Date.parse(value));
}

function label(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 80;
}

/** Malformed live data never becomes an apparently valid partial snapshot. */
export function parseAssetOrderBook(value: unknown, assetId: string): AssetOrderBook | null {
  if (!record(value) || value.type !== 'asset_order_book' || value.assetId !== assetId ||
    !label(value.priceUnit) || !label(value.quantityUnit) ||
    (value.marketLabel !== undefined && !label(value.marketLabel)) ||
    !levels(value.asks) || !levels(value.bids) || !time(value.capturedAt) ||
    (value.effectiveAt != null && !time(value.effectiveAt))) return null;
  return normalizeOrderBook({
    assetId, priceUnit: value.priceUnit, quantityUnit: value.quantityUnit,
    ...(label(value.marketLabel) ? { marketLabel: value.marketLabel } : {}),
    asks: value.asks, bids: value.bids,
    capturedAt: value.capturedAt, effectiveAt: time(value.effectiveAt) ? value.effectiveAt : null,
  });
}

export function isOrderBookStale(book: AssetOrderBook | null, receivedAt: number | null, now: number): boolean {
  // Both times belong to this client. Server capturedAt is only for ordering/display.
  return !!book && receivedAt !== null &&
    now - receivedAt > ORDER_BOOK_STALE_MS;
}
