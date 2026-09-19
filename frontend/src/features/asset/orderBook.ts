import Decimal from 'decimal.js';
import type { IsoDateTimeString, MoneyString, QuantityString } from '../../models/dto/common';
import { formatDisplayDecimal } from '../../utils/format.ts';

export const ORDER_BOOK_DEPTH = 10;

export interface OrderBookLevel {
  price: MoneyString;
  quantity: QuantityString;
}

/** Display snapshot, independent of provider fields and order execution. */
export interface AssetOrderBook {
  assetId: string;
  /** Market display units, NOT wallet/settlement CurrencyCode (e.g. 원, USDT). */
  priceUnit: string;
  quantityUnit: string;
  /** Optional market heading, e.g. BTC / USDT; the card never parses symbols. */
  marketLabel?: string;
  /** Best first: asks ascending, bids descending. At most ten per side. */
  asks: readonly OrderBookLevel[];
  bids: readonly OrderBookLevel[];
  /** Exchange totals, if supplied; never inferred from the visible ten levels. */
  totalAskQuantity?: QuantityString | null;
  totalBidQuantity?: QuantityString | null;
  capturedAt: IsoDateTimeString;
  effectiveAt?: IsoDateTimeString | null;
}

function isNonNegativeDecimal(value: string) {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value);
}

/** Exact market values: trim fractional padding, group digits, never round. */
export function formatOrderBookDecimal(value: string): string {
  if (!isNonNegativeDecimal(value)) return '-';
  const [integer, fraction] = formatDisplayDecimal(value).split('.');
  const grouped = integer.replace(/^0+(?=\d)/u, '').replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return `${grouped}${fraction ? `.${fraction}` : ''}`;
}

function normalizeLevels(levels: readonly OrderBookLevel[], side: 'asks' | 'bids') {
  return levels
    .filter(({ price, quantity }) =>
      isNonNegativeDecimal(price) && new Decimal(price).gt(0) &&
      isNonNegativeDecimal(quantity),
    )
    .map((level) => ({ ...level }))
    .sort((a, b) => new Decimal(a.price).cmp(b.price) * (side === 'asks' ? 1 : -1))
    .slice(0, ORDER_BOOK_DEPTH);
}

function normalizeTotal(value: QuantityString | null | undefined) {
  return value != null && isNonNegativeDecimal(value)
    ? value : null;
}

/**
 * Shared display boundary: discard absent/invalid price slots, retain zero and
 * fractional quantities, sort without Number precision loss, and cap depth.
 * Market-specific rules (e.g. integer shares) belong in the future adapter.
 * Provider response decoding belongs in the future adapter, before this step.
 * Partial sides remain partial; no synthetic price or quantity is filled in.
 */
export function normalizeOrderBook(book: AssetOrderBook): AssetOrderBook {
  return {
    ...book,
    asks: normalizeLevels(book.asks, 'asks'),
    bids: normalizeLevels(book.bids, 'bids'),
    totalAskQuantity: normalizeTotal(book.totalAskQuantity),
    totalBidQuantity: normalizeTotal(book.totalBidQuantity),
  };
}
