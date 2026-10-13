import Decimal from 'decimal.js';
import { formatOrderBookDecimal } from './orderBook.ts';

/**
 * Estimated best bid/ask from the server's `asset_estimated_quote` channel.
 *
 * This is a provider's STATISTICAL estimate (Tiingo liquidity metric), not an
 * exchange order book: one level per side, sizes in shares, and either side
 * may be missing. It is display-only — never an order input, fill price or
 * executable quantity — and it is kept apart from the 10-level
 * `asset_order_book` ladder.
 */

/** Client-receipt age after which an estimate is shown as delayed. */
export const ESTIMATED_QUOTE_STALE_MS = 60_000;
/** After an ACK with no estimate, stop waiting and say none is available. */
export const ESTIMATED_QUOTE_FIRST_SNAPSHOT_TIMEOUT_MS = 15_000;

export interface EstimatedQuoteSide {
  price: string | null;
  size: string | null;
}

export interface AssetEstimatedQuote {
  assetId: string;
  kind: 'estimated_liquidity';
  provider: string;
  priceCurrency: 'USD';
  quantityUnit: 'share';
  bid: EstimatedQuoteSide;
  ask: EstimatedQuoteSide;
  /** Relative spread as a decimal fraction (0.0004 = 0.04%). */
  spread: string | null;
  referencePrice: string | null;
  effectiveAt: string;
  capturedAt: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decimalOrNull(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length <= 64 &&
      /^\d+(?:\.\d+)?$/u.test(value))
  );
}

function positiveOrNull(value: unknown): value is string | null {
  return value === null || (decimalOrNull(value) && new Decimal(value).gt(0));
}

function side(value: unknown): EstimatedQuoteSide | null {
  if (!record(value) || !positiveOrNull(value.price) || !decimalOrNull(value.size))
    return null;
  // A size without a price has nothing to attach to.
  return { price: value.price, size: value.price === null ? null : value.size };
}

function time(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Malformed or crossed data never becomes an apparently valid estimate. */
export function parseAssetEstimatedQuote(
  value: unknown,
  assetId: string,
): AssetEstimatedQuote | null {
  if (
    !record(value) ||
    value.type !== 'asset_estimated_quote' ||
    value.assetId !== assetId ||
    value.kind !== 'estimated_liquidity' ||
    value.priceCurrency !== 'USD' ||
    value.quantityUnit !== 'share' ||
    typeof value.provider !== 'string' ||
    !/^[a-z0-9_]{1,32}$/u.test(value.provider) ||
    !decimalOrNull(value.spread) ||
    !positiveOrNull(value.referencePrice) ||
    !time(value.effectiveAt) ||
    !time(value.capturedAt)
  )
    return null;
  const bid = side(value.bid);
  const ask = side(value.ask);
  if (!bid || !ask) return null;
  if (bid.price && ask.price && new Decimal(bid.price).gt(ask.price)) return null;
  return {
    assetId,
    kind: 'estimated_liquidity',
    provider: value.provider,
    priceCurrency: 'USD',
    quantityUnit: 'share',
    bid,
    ask,
    spread: value.spread,
    referencePrice: value.referencePrice,
    effectiveAt: value.effectiveAt,
    capturedAt: value.capturedAt,
  };
}

/** Both times belong to this client; server times only order and label. */
export function isEstimatedQuoteStale(
  quote: AssetEstimatedQuote | null,
  receivedAt: number | null,
  now: number,
): boolean {
  return !!quote && receivedAt !== null && now - receivedAt > ESTIMATED_QUOTE_STALE_MS;
}

/** Exact share count with grouping, or null when the side is missing. */
export function formatEstimatedSize(size: string | null): string | null {
  return size === null ? null : formatOrderBookDecimal(size);
}

/** 0.0004 → "0.04%"; null when the estimate has no spread. */
export function formatEstimatedSpread(spread: string | null): string | null {
  if (spread === null) return null;
  const percent = new Decimal(spread).mul(100).toDecimalPlaces(3);
  return `${percent.toFixed()}%`;
}

export function providerLabel(provider: string): string {
  return provider === 'tiingo' ? 'Tiingo' : provider;
}
