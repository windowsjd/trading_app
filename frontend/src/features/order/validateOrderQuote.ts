import Decimal from 'decimal.js';
import type { OrderQuoteDto, OrderQuoteRequestDto } from './api.ts';
import { isOrderQuoteExpired } from './mapper.ts';

export class OrderQuoteValidationError extends Error {}

/**
 * "Now" on the server's clock for a quote just received: its `quoteAt` plus
 * the time this device spent since sending the request. Comparing `expiresAt`
 * with the phone's own clock rejected every fresh quote (15 s TTL) when the
 * clock ran 15 s or more ahead, so no spot order could be sent (2026-11-06).
 * The request's round trip makes this a little late, never early.
 */
export function quoteServerNow(quote: Pick<OrderQuoteDto, 'quoteAt'>, sentAt: number, now = Date.now()) {
  const quotedAt = Date.parse(quote.quoteAt);
  return Number.isFinite(quotedAt) ? quotedAt + Math.max(0, now - sentAt) : now;
}

/** Validate the response before the first create. Account binding is checked
 * by quoteTradingAccountOrder; canonical decimal strings remain server-owned. */
export function validateOrderQuote(
  request: OrderQuoteRequestDto,
  quote: OrderQuoteDto,
  now = Date.now(),
) {
  if (isOrderQuoteExpired(quote, now)) {
    throw new OrderQuoteValidationError(
      '주문 견적이 만료되었습니다. 다시 시도해주세요.',
    );
  }
  const positiveDecimal = (value: string | undefined) => {
    try {
      const parsed = value ? new Decimal(value) : null;
      return parsed?.isFinite() && parsed.gt(0) ? parsed : null;
    } catch {
      return null;
    }
  };
  const sameDecimal = (left: string | undefined, right: string | undefined) => {
    const a = positiveDecimal(left);
    const b = positiveDecimal(right);
    return !!a && !!b && a.eq(b);
  };
  // A LOC SELL may be accepted for less than asked (other orders hold part of
  // the holding): only with the server's explicit adjustment for exactly this
  // request, and never for more.
  const adjustment = quote.quantityAdjustment ?? null;
  const accepted = positiveDecimal(quote.quantity);
  const requested = positiveDecimal(request.quantity);
  const acceptedLess =
    request.limitOnClose === true &&
    request.side === 'sell' &&
    !!adjustment &&
    sameDecimal(adjustment.requestedQuantity, request.quantity) &&
    sameDecimal(adjustment.acceptedQuantity, quote.quantity) &&
    !!accepted &&
    !!requested &&
    accepted.lt(requested);
  if (
    quote.state !== 'available' ||
    !quote.quoteId ||
    quote.asset?.id !== request.assetId ||
    quote.side !== request.side ||
    quote.orderType !== (request.orderType ?? 'market') ||
    !(request.amount !== undefined
      ? sameDecimal(quote.amount, request.amount) &&
        !!positiveDecimal(quote.quantity)
      : quote.amount == null &&
        (sameDecimal(quote.quantity, request.quantity) || acceptedLess)) ||
    (adjustment !== null && !acceptedLess) ||
    (request.orderType === 'limit' &&
      !sameDecimal(quote.limitPrice, request.limitPrice)) ||
    // A LOC request needs the server's LOC session preview, and an ordinary
    // request must not come back bound to a closing session.
    (request.limitOnClose === true) !== !!quote.limitOnClose?.sessionDate
  ) {
    throw new OrderQuoteValidationError(
      '입력한 주문과 견적이 일치하지 않습니다. 다시 시도해주세요.',
    );
  }
}
