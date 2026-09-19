import Decimal from 'decimal.js';
import type { IsoDateTimeString, MoneyString, QuantityString } from '../../models/dto/common';
import type { CurrencyCode } from '../market/api';

export const ORDER_BOOK_DEPTH = 10;

export interface OrderBookLevel {
  price: MoneyString;
  quantity: QuantityString;
}

/** Display snapshot, independent of provider fields and order execution. */
export interface AssetOrderBook {
  assetId: string;
  currency: CurrencyCode;
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
  return /^\d+(?:\.\d+)?$/u.test(value);
}

function normalizeLevels(levels: readonly OrderBookLevel[], side: 'asks' | 'bids') {
  return levels
    .filter(({ price, quantity }) =>
      isNonNegativeDecimal(price) && new Decimal(price).gt(0) &&
      isNonNegativeDecimal(quantity) && new Decimal(quantity).isInteger(),
    )
    .map((level) => ({ ...level }))
    .sort((a, b) => new Decimal(a.price).cmp(b.price) * (side === 'asks' ? 1 : -1))
    .slice(0, ORDER_BOOK_DEPTH);
}

function normalizeTotal(value: QuantityString | null | undefined) {
  return value != null && isNonNegativeDecimal(value) && new Decimal(value).isInteger()
    ? value : null;
}

/**
 * Domestic stock display boundary: discard absent/invalid price slots, retain
 * zero share quantities, sort without Number precision loss, and cap depth.
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
