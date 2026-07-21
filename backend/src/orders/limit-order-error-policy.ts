import { HttpStatus } from '@nestjs/common';

/**
 * Error codes introduced by the limit-buy foundation. Existing market-order
 * codes (ORDER_TYPE_NOT_SUPPORTED, ORDER_CANCEL_NOT_SUPPORTED,
 * INSUFFICIENT_BALANCE, QUOTE_*, ORDER_IDEMPOTENCY_CONFLICT, ...) keep their
 * meanings unchanged; everything here is additive. Clients must branch on
 * these codes, never on messages.
 */
export const limitOrderErrorCodes = {
  /** Feature flag off: new limit quote/create requests are rejected. */
  LIMIT_ORDER_DISABLED: 'LIMIT_ORDER_DISABLED',
  /** Phase 1 supports limit BUY only; limit sell has its own code. */
  LIMIT_BUY_ONLY: 'LIMIT_BUY_ONLY',
  /** limitPrice missing / non-positive / malformed / out of Decimal(24,8). */
  INVALID_LIMIT_PRICE: 'INVALID_LIMIT_PRICE',
  /** balance - reserved cannot cover the new reservation. */
  INSUFFICIENT_AVAILABLE_BALANCE: 'INSUFFICIENT_AVAILABLE_BALANCE',
  /** Atomic reservation lost a race and no clear cause remains. */
  ORDER_RESERVATION_CONFLICT: 'ORDER_RESERVATION_CONFLICT',
  /** Order/wallet reservation bookkeeping violates an invariant. */
  ORDER_RESERVATION_INCONSISTENT: 'ORDER_RESERVATION_INCONSISTENT',
  /** Cancel target is executed/rejected (terminal, nothing to release). */
  ORDER_NOT_CANCELABLE: 'ORDER_NOT_CANCELABLE',
  /** Concurrent state change defeated the cancel after validation. */
  ORDER_CANCEL_CONFLICT: 'ORDER_CANCEL_CONFLICT',
} as const;

export type LimitOrderErrorCode =
  (typeof limitOrderErrorCodes)[keyof typeof limitOrderErrorCodes];

export const limitOrderErrorHttpStatus: Record<
  LimitOrderErrorCode,
  HttpStatus
> = {
  LIMIT_ORDER_DISABLED: HttpStatus.FORBIDDEN,
  LIMIT_BUY_ONLY: HttpStatus.BAD_REQUEST,
  INVALID_LIMIT_PRICE: HttpStatus.BAD_REQUEST,
  INSUFFICIENT_AVAILABLE_BALANCE: HttpStatus.CONFLICT,
  ORDER_RESERVATION_CONFLICT: HttpStatus.CONFLICT,
  ORDER_RESERVATION_INCONSISTENT: HttpStatus.INTERNAL_SERVER_ERROR,
  ORDER_NOT_CANCELABLE: HttpStatus.CONFLICT,
  ORDER_CANCEL_CONFLICT: HttpStatus.CONFLICT,
};
