import { Prisma } from '../generated/prisma/client';

export type OrderBookLevel = { price: string; quantity: string };

/** Display data only. Never an execution, valuation or persistence model. */
export type AssetOrderBook = {
  assetId: string;
  priceUnit: string;
  quantityUnit: string;
  marketLabel?: string;
  asks: OrderBookLevel[];
  bids: OrderBookLevel[];
  capturedAt: string;
  effectiveAt: string | null;
};

/** Sequence is transport-internal; the app receives only book. */
export type OrderBookEvent = {
  type: 'asset_order_book';
  sequence: string;
  book: AssetOrderBook;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isBookDecimal(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    /^\d+(?:\.\d+)?$/u.test(value)
  );
}

/** Reject the whole snapshot on corrupt levels, instead of disguising gaps. */
export function parseBookLevels(
  value: unknown,
  side: 'asks' | 'bids',
): OrderBookLevel[] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const levels: OrderBookLevel[] = [];
  const prices = new Set<string>();
  for (const entry of value as unknown[]) {
    if (
      !isRecord(entry) ||
      !isBookDecimal(entry.price) ||
      !isBookDecimal(entry.quantity)
    )
      return null;
    const price = new Prisma.Decimal(entry.price);
    if (!price.gt(0) || prices.has(price.toFixed())) return null;
    prices.add(price.toFixed());
    levels.push({ price: entry.price, quantity: entry.quantity });
  }
  return levels.sort(
    (a, b) =>
      new Prisma.Decimal(a.price).cmp(b.price) * (side === 'asks' ? 1 : -1),
  );
}

export function isBookSequence(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d{0,39})$/u.test(value);
}

function isTime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isLabel(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= 80
  );
}

export function parseOrderBookEvent(message: string): OrderBookEvent | null {
  try {
    const event: unknown = JSON.parse(message);
    if (
      !isRecord(event) ||
      event.type !== 'asset_order_book' ||
      !isBookSequence(event.sequence) ||
      !isRecord(event.book)
    )
      return null;
    const book = event.book;
    if (
      !isLabel(book.assetId) ||
      !isLabel(book.priceUnit) ||
      !isLabel(book.quantityUnit) ||
      (book.marketLabel !== undefined && !isLabel(book.marketLabel)) ||
      !isTime(book.capturedAt) ||
      (book.effectiveAt !== null && !isTime(book.effectiveAt))
    )
      return null;
    const asks = parseBookLevels(book.asks, 'asks');
    const bids = parseBookLevels(book.bids, 'bids');
    if (!asks || !bids) return null;
    return {
      type: 'asset_order_book',
      sequence: event.sequence,
      book: {
        assetId: book.assetId,
        priceUnit: book.priceUnit,
        quantityUnit: book.quantityUnit,
        ...(book.marketLabel === undefined
          ? {}
          : { marketLabel: book.marketLabel }),
        asks,
        bids,
        capturedAt: book.capturedAt,
        effectiveAt: book.effectiveAt,
      },
    };
  } catch {
    return null;
  }
}
