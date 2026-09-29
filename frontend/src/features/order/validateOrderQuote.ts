import Decimal from 'decimal.js';
import type { OrderQuoteDto, OrderQuoteRequestDto } from './api.ts';
import { isOrderQuoteExpired } from './mapper.ts';

export class OrderQuoteValidationError extends Error {}

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
        sameDecimal(quote.quantity, request.quantity)) ||
    (request.orderType === 'limit' &&
      !sameDecimal(quote.limitPrice, request.limitPrice))
  ) {
    throw new OrderQuoteValidationError(
      '입력한 주문과 견적이 일치하지 않습니다. 다시 시도해주세요.',
    );
  }
}
